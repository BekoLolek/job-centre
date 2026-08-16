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

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  type Database,
  type Game,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileValue,
  db as defaultDb,
  games,
  profileFields,
  profileValues,
} from "@/db";
import {
  type Completeness,
  type FieldShape,
  choicesFor,
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
};

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

/** The label the global section carries on the page. */
export const GLOBAL_SECTION_NAME = "Everyone";
export const GLOBAL_SECTION_KEY = "global";

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * Everything `/me/profile` needs, in three queries.
 *
 * Only **active** games get a section: deactivating a game hides its questions
 * without destroying a single answer, which is what makes deactivation the safe
 * alternative to deletion. The global section appears only when global fields
 * exist, because an empty "Everyone" heading is noise rather than an empty
 * state.
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

  const valueByField = new Map(storedValues.map((row) => [row.fieldId, row.value]));

  const build = (game: Game | null): ProfileSectionView => {
    const ladder = game?.rankLadder ?? [];
    const fields = allFields
      .filter((field) => field.gameId === (game?.id ?? null))
      .map((field): ProfileFieldView => ({
        id: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options,
        choices: choicesFor(field.type, field.options, ladder),
        value: valueByField.get(field.id) ?? null,
      }));

    return {
      gameId: game?.id ?? null,
      key: game?.key ?? GLOBAL_SECTION_KEY,
      name: game?.name ?? GLOBAL_SECTION_NAME,
      rankLadder: [...ladder],
      fields,
      completeness: sectionCompleteness(fields),
    };
  };

  const sections: ProfileSectionView[] = [];
  const global = build(null);
  if (global.fields.length > 0) sections.push(global);
  for (const game of activeGames) sections.push(build(game));

  // A value belonging to a field of a deactivated game still counts as the
  // member having answered something — "untouched" is about them, not about
  // what happens to be on screen.
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

  const fields = await database
    .select()
    .from(profileFields)
    .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId));

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
      .values({ userId, fieldId: field.id, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [profileValues.userId, profileValues.fieldId],
        set: { value, updatedAt: now },
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
