/**
 * The member's own profile — reading it, and saving one section of it.
 *
 * docs/platform-plan.md §7: `profile_fields` are admin-defined, so this module
 * cannot know what the questions are. It knows the *shape* — a section per
 * active game plus the global one, fields in `sort` order, one stored answer per
 * (member, field) — and hands the page a structure it can render without a
 * second query or a single decision about validity.
 *
 * The validation rules themselves live in `./profile-fields`, which has no
 * database handle and is tested exhaustively. This module is the part that
 * talks to Postgres.
 *
 * ## The trust boundary
 *
 * `saveProfileSection` is what a server action calls, so **the request decides
 * nothing**. It re-reads the section's fields from the database and only writes
 * answers to fields that genuinely belong to that section; option lists come
 * from the stored field, never from the payload; a field id from another
 * section, another game or nowhere at all is rejected outright rather than
 * ignored. A save either applies in full or writes nothing.
 */

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  type Database,
  type Game,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileValue,
  type ProfileValueRow,
  db as defaultDb,
  games,
  profileFields,
  profileValues,
} from "@/db";
import {
  type Completeness,
  type DetailAttention,
  type FieldShape,
  GLOBAL_SECTION_KEY,
  GLOBAL_SECTION_NAME,
  choicesFor,
  detailAttention,
  parseProfileValue,
  sectionCompleteness,
} from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Shapes the page renders                                            */
/* ------------------------------------------------------------------ */

export type ProfileFieldView = {
  id: string;
  key: string;
  label: string;
  type: ProfileField["type"];
  required: boolean;
  /** The admin's option list, verbatim. Empty for types that have none. */
  options: ProfileFieldOption[];
  /** What the member taps: options, or the game's ladder for a `rank` field. */
  choices: ProfileFieldOption[];
  /** This member's stored answer, or `null` when they have not said. */
  value: ProfileValue;
  /**
   * When they last saved or confirmed that answer (R-49 / UC-12 3), or null —
   * never, which is what every answer given before the column existed says.
   *
   * ISO, never a formatted string: no instant is formatted on the server, and
   * the two screens that show this one (`ProfileSection` and `ApplyForm`'s
   * detail rows) are client components that render it through `LocalTime` in
   * the reader's own zone. A string rather than a `Date` for the reason
   * `ApplyDay.startsAt` is one — a `Date` does not survive the props of a
   * client component well.
   */
  confirmedAt: string | null;
  /**
   * Why this detail still needs them, or null. `detailAttention`'s answer, so
   * the application form, the profile page and `/me`'s to-dos cannot form three
   * opinions about which questions are outstanding.
   */
  attention: DetailAttention;
};

/**
 * Enough of a field to render a control for it.
 *
 * `FieldControl` is handed one of these rather than a whole `ProfileFieldView`
 * because three screens build one out of something that is not a profile field
 * at all — the two question dialogs preview an admin's draft question, and the
 * application form renders an event's own question. None of them has a
 * `confirmed_at` to offer, and inventing one so the types line up would be
 * fiction. What they do all have is a type, a label and a choice list, which is
 * all a control reads.
 */
export type FieldControlView = Pick<
  ProfileFieldView,
  "id" | "key" | "label" | "type" | "required" | "options" | "choices" | "value"
>;

export type ProfileSectionView = {
  /** `null` is the global section — the questions asked of everybody (§7). */
  gameId: string | null;
  /** `global`, or the game's key. Stable enough to use as a React key. */
  key: string;
  name: string;
  /** Lowest first. Empty for a game without ranks, like Jackbox. */
  rankLadder: string[];
  fields: ProfileFieldView[];
  completeness: Completeness;
};

export type ProfileView = {
  sections: ProfileSectionView[];
  /** True when the admin has not defined a single field anywhere yet. */
  empty: boolean;
  /** True when the member has answered nothing at all. */
  untouched: boolean;
};

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * One section, assembled from rows already read.
 *
 * Shared by `loadProfile` and `loadProfileForGame` rather than copied into
 * both, because the two differ only in *which* sections they want and the
 * interesting part — what a retired question does, where a `rank` field gets
 * its choices, how completeness is counted — must be the same answer on
 * `/me/profile` and on the application form. UC-12 2 shows the member the same
 * details UC-04 2 does; two builders is two chances for one of them to keep
 * asking a retired question.
 */
function buildSection(
  game: Game | null,
  allFields: readonly ProfileField[],
  storedValues: readonly ProfileValueRow[],
  alsoRequired: ReadonlySet<string> = new Set()
): ProfileSectionView {
  const rowByField = new Map(storedValues.map((row) => [row.fieldId, row]));
  const ladder = game?.rankLadder ?? [];

  const fields = allFields
    .filter((field) => field.gameId === (game?.id ?? null) && field.retiredAt === null)
    .map((field): ProfileFieldView => {
      const row = rowByField.get(field.id) ?? null;
      const value = row?.value ?? null;
      const required = field.required || alsoRequired.has(field.id);
      return {
        id: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        required,
        options: field.options,
        choices: choicesFor(field.type, field.options, ladder),
        value,
        confirmedAt: row?.confirmedAt?.toISOString() ?? null,
        attention: detailAttention(
          {
            type: field.type,
            label: field.label,
            options: field.options,
            rankLadder: ladder,
            required,
            retiredAt: field.retiredAt,
          },
          value
        ),
      };
    });

  return {
    gameId: game?.id ?? null,
    key: game?.key ?? GLOBAL_SECTION_KEY,
    name: game?.name ?? GLOBAL_SECTION_NAME,
    rankLadder: [...ladder],
    fields,
    completeness: sectionCompleteness(fields),
  };
}

/**
 * The sections an application to this game's event has to show (UC-12 2).
 *
 * The **global** section and the game's own, in that order, and nothing else —
 * the member's Valorant answers are not what a Marvel Rivals event is asking
 * about. An event with no game gets the global section alone.
 *
 * Unlike `loadProfile` this does not require the game to be active: an event
 * already published against a game an admin has since deactivated still has
 * applicants, and refusing to show them the questions they are being judged on
 * would be worse than showing a section for a game that is no longer in the
 * catalogue. Retirement still applies per question, because that is a decision
 * about the question rather than about the game.
 *
 * `alsoRequired` lets one event demand a detail the catalogue leaves optional.
 * An event question linked to a profile field and marked required is the
 * manager saying "I will not read an application without this", and the
 * amendment to UC-04 4a is explicit that the application is where such a demand
 * belongs — the profile still saves without it. Passing the ids in rather than
 * patching `required` afterwards keeps `attention` and `completeness` derived
 * from one definition of required instead of two.
 */
export async function loadProfileForGame(
  userId: string | null,
  gameId: string | null,
  options: { alsoRequired?: ReadonlySet<string> } = {},
  database: Database = defaultDb
): Promise<ProfileSectionView[]> {
  const [game] = gameId
    ? await database.select().from(games).where(eq(games.id, gameId)).limit(1)
    : [];

  const [allFields, storedValues] = await Promise.all([
    database
      .select()
      .from(profileFields)
      .where(game ? or(eq(profileFields.gameId, game.id), isNull(profileFields.gameId)) : isNull(profileFields.gameId))
      .orderBy(asc(profileFields.sort), asc(profileFields.createdAt)),
    userId
      ? database.select().from(profileValues).where(eq(profileValues.userId, userId))
      : Promise.resolve([] as ProfileValueRow[]),
  ]);

  const alsoRequired = options.alsoRequired ?? new Set<string>();
  const sections = [buildSection(null, allFields, storedValues, alsoRequired)];
  if (game) sections.push(buildSection(game, allFields, storedValues, alsoRequired));
  return sections.filter((section) => section.fields.length > 0);
}

/**
 * Everything `/me/profile` needs, in three queries.
 *
 * Two things are hidden here without a single answer being destroyed, and they
 * are the same bargain at two scales:
 *
 *  - Only **active** games get a section. Deactivating a game hides its
 *    questions and keeps every answer, which is what makes deactivation the
 *    safe alternative to deleting one.
 *  - Only questions that have not been **retired** are listed (UC-03 5a,
 *    R-09). A retired question stops being asked the moment an admin retires
 *    it — including in `completeness`, so nobody is told their profile is
 *    incomplete because of a question nobody is asking any more — while its
 *    `profile_values` rows sit exactly where they were. Restoring it puts
 *    every one of them back on the form.
 *
 * The global section appears only when global fields exist, because an empty
 * "Everyone" heading is noise rather than an empty state.
 */
export async function loadProfile(
  userId: string,
  database: Database = defaultDb
): Promise<ProfileView> {
  const [activeGames, allFields, storedValues] = await Promise.all([
    database
      .select()
      .from(games)
      .where(eq(games.isActive, true))
      .orderBy(asc(games.sort), asc(games.name)),
    database.select().from(profileFields).orderBy(asc(profileFields.sort), asc(profileFields.createdAt)),
    database.select().from(profileValues).where(eq(profileValues.userId, userId)),
  ]);

  const sections: ProfileSectionView[] = [];
  const global = buildSection(null, allFields, storedValues);
  if (global.fields.length > 0) sections.push(global);
  for (const game of activeGames) sections.push(buildSection(game, allFields, storedValues));

  // A value belonging to a field of a deactivated game, or to a retired
  // question, still counts as the member having answered something —
  // "untouched" is about them, not about what happens to be on screen.
  const answeredFieldIds = new Set(storedValues.map((row) => row.fieldId));

  return {
    sections,
    empty: sections.every((section) => section.fields.length === 0),
    untouched: answeredFieldIds.size === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

/** Answers keyed by `profile_fields.id`. Exactly what the client holds. */
export type AnswerPatch = Record<string, unknown>;

export type SaveResult =
  | {
      ok: true;
      /** The values as stored, so the client can replace its optimistic copy. */
      values: Record<string, ProfileValue>;
      completeness: Completeness;
      savedAt: string;
    }
  | {
      ok: false;
      /** Keyed by field id where the problem is one field's; `_` when it is not. */
      errors: Record<string, string>;
    };

/**
 * Save one section's answers.
 *
 * All-or-nothing: every answer is parsed before anything is written, so a
 * rejected value never leaves the section half-saved. Blank answers are stored
 * as *absence* — the row is deleted rather than set to null — which keeps
 * "never answered" and "answered, then cleared" the same thing, and stops
 * `profile_values` filling with tombstones.
 *
 * Required fields do **not** block the save; they come back in `completeness`
 * for the page to show as "2 of 3 answered". A profile is a thing you fill in
 * over time, and the hard gate belongs on the event application (§8.3), not
 * here.
 *
 * Every written row has `confirmed_at` stamped with it (UC-04 4), because
 * saving an answer *is* asserting it — the member has just looked at the
 * question and said this. The same instant goes on `updated_at`, so a save and
 * a confirmation of the same answer are distinguishable only when they happen
 * separately, which is exactly when the distinction matters.
 */
export async function saveProfileSection(
  userId: string,
  gameId: string | null,
  patch: AnswerPatch,
  database: Database = defaultDb
): Promise<SaveResult> {
  const ids = Object.keys(patch);
  if (ids.length === 0) {
    return { ok: false, errors: { _: "Nothing to save." } };
  }

  // The section as the database has it — the only definition that counts.
  const [game] = gameId
    ? await database.select().from(games).where(eq(games.id, gameId)).limit(1)
    : [null];

  if (gameId && !game) {
    return { ok: false, errors: { _: "That game no longer exists." } };
  }
  if (game && !game.isActive) {
    return { ok: false, errors: { _: `${game.name} is not active any more.` } };
  }

  /*
   * Retired questions are dropped here too, not just on the read. A page open
   * since before the retirement would otherwise still post to one, and the
   * save would quietly write an answer to a question the site has stopped
   * asking — the answers a retirement keeps are the ones already given, not
   * new ones (UC-03 5a).
   */
  const fields = (
    await database
      .select()
      .from(profileFields)
      .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId))
  ).filter((field) => field.retiredAt === null);

  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const ladder = game?.rankLadder ?? [];

  const errors: Record<string, string> = {};
  const parsed: Array<{ field: ProfileField; value: ProfileValue }> = [];

  for (const id of ids) {
    const field = fieldById.get(id);
    if (!field) {
      // Not "ignore the unknown key": a payload naming a field that is not in
      // this section is either a stale page or a forgery, and both deserve to
      // be told rather than half-honoured.
      errors[id] = "That question is not part of this section any more.";
      continue;
    }

    const shape: FieldShape = {
      type: field.type,
      label: field.label,
      options: field.options,
      rankLadder: ladder,
    };
    const result = parseProfileValue(shape, patch[id]);
    if (!result.ok) errors[id] = result.error;
    else parsed.push({ field, value: result.value });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const now = new Date();
  const toDelete = parsed
    .filter(({ value }) => value === null || (Array.isArray(value) && value.length === 0))
    .map(({ field }) => field.id);
  const toWrite = parsed.filter(({ field }) => !toDelete.includes(field.id));

  if (toDelete.length > 0) {
    await database
      .delete(profileValues)
      .where(
        and(eq(profileValues.userId, userId), inArray(profileValues.fieldId, toDelete))
      );
  }

  for (const { field, value } of toWrite) {
    await database
      .insert(profileValues)
      .values({ userId, fieldId: field.id, value, updatedAt: now, confirmedAt: now })
      .onConflictDoUpdate({
        target: [profileValues.userId, profileValues.fieldId],
        set: { value, updatedAt: now, confirmedAt: now },
      });
  }

  // Report the whole section's completeness, not just the patched fields, so
  // the counter on screen is right even when one chip was toggled.
  const stored = await database
    .select()
    .from(profileValues)
    .where(eq(profileValues.userId, userId));
  const storedByField = new Map(stored.map((row) => [row.fieldId, row.value]));

  const values: Record<string, ProfileValue> = {};
  for (const { field } of parsed) values[field.id] = storedByField.get(field.id) ?? null;

  return {
    ok: true,
    values,
    completeness: sectionCompleteness(
      fields.map((field) => ({
        label: field.label,
        required: field.required,
        value: storedByField.get(field.id) ?? null,
      }))
    ),
    savedAt: now.toISOString(),
  };
}

/*
 * There is no `confirmProfileAnswers` here, and there was.
 *
 * "Yes, that is all still right" (R-49 / UC-12 3) is stamped by
 * `commitDetails` in `src/lib/events.ts`, inside the transaction that accepts
 * the application — the only path a member can reach it from. A second
 * stamp-only writer in this module had no production caller and no way to
 * acquire one: the apply form is the one screen that offers the tap, and it
 * cannot write a confirmation outside the transaction that checks the details
 * it belongs to. Two writers of one column, with the reachable one enforcing
 * the retirement rule a step earlier (`askedDetails` drops a retired detail and
 * `checkDetails` then refuses its id outright, rather than silently skipping
 * it), is how the two of them drift.
 *
 * Its invariants — never creates a row, never moves `updated_at`, authorised on
 * the row it writes — are stated on `commitDetails`, which is the code that now
 * keeps them.
 */
