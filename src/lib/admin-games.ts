/**
 * `/admin/games` — the data layer behind "add a game and say what info I want
 * from players" (docs/platform-plan.md §13 Q4, §14).
 *
 * This is the module that makes a new event type a *row* rather than a deploy.
 * Everything the admin screen does goes through one of these functions, and
 * every one of them:
 *
 *  - validates its own input, because a server action is a public endpoint;
 *  - rewrites `sort` densely (0…n-1) after a reorder, so "move up" never
 *    quietly does nothing because two rows share a number;
 *  - reports what an edit will destroy *before* it destroys it — see
 *    `fieldAnswerCount` and `previewFieldEdit`, which exist because deleting a
 *    question that forty people have answered should not be a silent event.
 *
 * Nothing here deletes a game. Deactivating hides it from `/me/profile` and
 * from applications while leaving every answer intact, which is the standing
 * "nothing destructive, ever" rule in checklist.md. Fields *can* be deleted,
 * because a mistyped question with no answers is a normal thing to remove — but
 * the count comes back first.
 */

import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  type Database,
  type Game,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileFieldType,
  db as defaultDb,
  games,
  profileFields,
  profileValues,
} from "@/db";
import {
  type FieldShape,
  fieldTypeInfo,
  isFieldType,
  normaliseOptions,
  normaliseRankLadder,
  reorderById,
  slugify,
  uniqueKey,
  valueStillValid,
} from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every mutation returns this rather than throwing. A server action's caller is
 * a form, and a form wants a message next to the control, not a stack trace.
 */
export type AdminResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function done(): AdminResult {
  return { ok: true, data: null };
}

function withData<T>(data: T): AdminResult<T> {
  return { ok: true, data };
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export type AdminFieldView = ProfileField & {
  /** How many members have answered it. The number a delete would destroy. */
  answers: number;
};

export type AdminGameView = Game & {
  fields: AdminFieldView[];
  /** Answers across every field of this game — the weight of the game itself. */
  answers: number;
};

export type AdminGamesView = {
  /** Every game, active or not, in `sort` order. */
  games: AdminGameView[];
  /** The `game_id is null` fields, which belong to no game (§7). */
  globalFields: AdminFieldView[];
  globalAnswers: number;
};

/**
 * The whole admin screen in three queries, answer counts included.
 *
 * Counts are grouped in Postgres rather than fetched per field: forty fields
 * would otherwise be forty round trips, and on Neon that is forty HTTP
 * requests.
 */
export async function loadAdminGames(database: Database = defaultDb): Promise<AdminGamesView> {
  const [gameRows, fieldRows, counts] = await Promise.all([
    database.select().from(games).orderBy(asc(games.sort), asc(games.name)),
    database
      .select()
      .from(profileFields)
      .orderBy(asc(profileFields.sort), asc(profileFields.createdAt)),
    database
      .select({ fieldId: profileValues.fieldId, total: count() })
      .from(profileValues)
      .groupBy(profileValues.fieldId),
  ]);

  const answersByField = new Map(counts.map((row) => [row.fieldId, Number(row.total)]));
  const decorate = (field: ProfileField): AdminFieldView => ({
    ...field,
    answers: answersByField.get(field.id) ?? 0,
  });

  const globalFields = fieldRows.filter((field) => field.gameId === null).map(decorate);

  return {
    games: gameRows.map((game) => {
      const fields = fieldRows.filter((field) => field.gameId === game.id).map(decorate);
      return {
        ...game,
        fields,
        answers: fields.reduce((total, field) => total + field.answers, 0),
      };
    }),
    globalFields,
    globalAnswers: globalFields.reduce((total, field) => total + field.answers, 0),
  };
}

/** How many stored answers one field has. The number a delete would destroy. */
export async function fieldAnswerCount(
  fieldId: string,
  database: Database = defaultDb
): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(profileValues)
    .where(eq(profileValues.fieldId, fieldId));
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

const NAME_MAX = 60;

function cleanName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, NAME_MAX) : "";
}

/** The next `sort` value, so a new row lands at the bottom rather than the top. */
async function nextGameSort(database: Database): Promise<number> {
  const [row] = await database
    .select({ highest: sql<number | null>`max(${games.sort})` })
    .from(games);
  return (row?.highest ?? -1) + 1;
}

export type CreateGameInput = {
  name: string;
  /** Optional: derived from the name when absent, which is the normal path. */
  key?: string;
  rankLadder?: unknown;
};

/**
 * Add a game. Name only, in practice — "REPO" is enough to get a row.
 *
 * The key is slugged from the name because an admin should never have to think
 * about one, but it is *not* silently disambiguated the way a field key is: a
 * game key is a stable identifier that seeds and URLs refer to, so a clash is
 * reported rather than turned into `repo-2` behind the admin's back.
 */
export async function createGame(
  input: CreateGameInput,
  database: Database = defaultDb
): Promise<AdminResult<Game>> {
  const name = cleanName(input.name);
  if (!name) return fail("Give the game a name.");

  const key = slugify(typeof input.key === "string" && input.key.trim() ? input.key : name);
  if (!key) return fail("That name has no letters or numbers in it to make a key from.");

  const [clash] = await database.select().from(games).where(eq(games.key, key)).limit(1);
  if (clash) return fail(`There is already a game with the key "${key}" (${clash.name}).`);

  const [created] = await database
    .insert(games)
    .values({
      key,
      name,
      sort: await nextGameSort(database),
      isActive: true,
      rankLadder: normaliseRankLadder(input.rankLadder),
    })
    .returning();

  return withData(created);
}

/** Rename a game. The key never moves — things point at it. */
export async function renameGame(
  gameId: string,
  rawName: string,
  database: Database = defaultDb
): Promise<AdminResult<Game>> {
  const name = cleanName(rawName);
  if (!name) return fail("Give the game a name.");

  const [updated] = await database
    .update(games)
    .set({ name })
    .where(eq(games.id, gameId))
    .returning();

  return updated ? withData(updated) : fail("That game no longer exists.");
}

/**
 * Show or hide a game.
 *
 * This is the closest thing to deleting a game the admin gets, and it is
 * deliberate: an inactive game vanishes from `/me/profile` and from event
 * applications while every stored answer survives, so switching it back on
 * restores the lot.
 */
export async function setGameActive(
  gameId: string,
  isActive: boolean,
  database: Database = defaultDb
): Promise<AdminResult<Game>> {
  const [updated] = await database
    .update(games)
    .set({ isActive })
    .where(eq(games.id, gameId))
    .returning();
  return updated ? withData(updated) : fail("That game no longer exists.");
}

/** Move a game up or down the list, then rewrite every `sort` as 0…n-1. */
export async function moveGame(
  gameId: string,
  direction: "up" | "down",
  database: Database = defaultDb
): Promise<AdminResult> {
  const rows = await database.select().from(games).orderBy(asc(games.sort), asc(games.name));
  if (!rows.some((row) => row.id === gameId)) return fail("That game no longer exists.");

  await writeGameSort(database, reorderById(rows, gameId, direction));
  return done();
}

/**
 * Renumber `sort` as 0…n-1 for the given order, skipping rows already correct.
 *
 * Dense from the top every time. Nudging one row's number instead is what
 * eventually produces two rows sharing a `sort`, at which point "move up"
 * appears to do nothing and nobody can see why.
 */
async function writeGameSort(
  database: Database,
  ordered: ReadonlyArray<{ id: string; sort: number }>
): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort === index) continue;
    await database.update(games).set({ sort: index }).where(eq(games.id, row.id));
  }
}

/** As {@link writeGameSort}, for the questions within one section. */
async function writeFieldSort(
  database: Database,
  ordered: ReadonlyArray<{ id: string; sort: number }>
): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort === index) continue;
    await database.update(profileFields).set({ sort: index }).where(eq(profileFields.id, row.id));
  }
}

/* ------------------------------------------------------------------ */
/* Rank ladders                                                       */
/* ------------------------------------------------------------------ */

export type LadderImpact = {
  /** Ladder entries that would stop being valid answers. */
  removed: string[];
  /** How many stored answers name one of them. */
  answers: number;
};

/**
 * What replacing this game's ladder would cost.
 *
 * A `rank` answer stores the ladder entry's *name*, so renaming or removing an
 * entry orphans every answer holding it. The admin is told the number before
 * they commit, and `setRankLadder` clears exactly those rows afterwards — the
 * alternative is a profile that displays a rank the game no longer has.
 */
export async function previewRankLadder(
  gameId: string,
  nextLadder: readonly string[],
  database: Database = defaultDb
): Promise<LadderImpact> {
  const [game] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) return { removed: [], answers: 0 };

  const keeping = new Set(normaliseRankLadder([...nextLadder]));
  const removed = game.rankLadder.filter((name) => !keeping.has(name));
  if (removed.length === 0) return { removed: [], answers: 0 };

  const rankFields = await database
    .select({ id: profileFields.id })
    .from(profileFields)
    .where(and(eq(profileFields.gameId, gameId), eq(profileFields.type, "rank")));
  if (rankFields.length === 0) return { removed, answers: 0 };

  const rows = await database
    .select({ fieldId: profileValues.fieldId, value: profileValues.value })
    .from(profileValues)
    .where(inArray(profileValues.fieldId, rankFields.map((field) => field.id)));

  const orphaned = rows.filter(
    (row) => typeof row.value === "string" && removed.includes(row.value)
  );
  return { removed, answers: orphaned.length };
}

/**
 * Replace a game's ladder, lowest first, and clear answers it orphans.
 *
 * An empty ladder is valid and meaningful — Jackbox has no ranks — so this
 * never insists on entries. What it will not do is leave a member's profile
 * claiming a rank that no longer exists.
 */
export async function setRankLadder(
  gameId: string,
  rawLadder: unknown,
  database: Database = defaultDb
): Promise<AdminResult<{ ladder: string[]; clearedAnswers: number }>> {
  const [game] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) return fail("That game no longer exists.");

  const ladder = normaliseRankLadder(rawLadder);
  if (ladder.length > 60) return fail("A ladder that long is almost certainly a mistake.");

  const impact = await previewRankLadder(gameId, ladder, database);
  await database.update(games).set({ rankLadder: ladder }).where(eq(games.id, gameId));

  let cleared = 0;
  if (impact.answers > 0) cleared = await clearInvalidAnswers(gameId, database);

  return withData({ ladder, clearedAnswers: cleared });
}

/**
 * Delete stored answers that no longer parse against their field.
 *
 * Called after any edit that can invalidate answers — a shortened ladder, a
 * retyped field, a deleted option. Reads the values rather than trying to
 * express "still valid" in SQL, because the rules live in `profile-fields` and
 * having them in two places is how the two versions drift apart.
 */
async function clearInvalidAnswers(
  gameId: string | null,
  database: Database = defaultDb
): Promise<number> {
  const [game] = gameId
    ? await database.select().from(games).where(eq(games.id, gameId)).limit(1)
    : [null];

  const fields = await database
    .select()
    .from(profileFields)
    .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId));
  if (fields.length === 0) return 0;

  const rows = await database
    .select()
    .from(profileValues)
    .where(inArray(profileValues.fieldId, fields.map((field) => field.id)));

  const shapeFor = (field: ProfileField): FieldShape => ({
    type: field.type,
    label: field.label,
    options: field.options,
    rankLadder: game?.rankLadder ?? [],
  });
  const fieldById = new Map(fields.map((field) => [field.id, field]));

  const doomed = rows.filter((row) => {
    const field = fieldById.get(row.fieldId);
    return field ? !valueStillValid(shapeFor(field), row.value) : false;
  });

  if (doomed.length === 0) return 0;
  await database
    .delete(profileValues)
    .where(inArray(profileValues.id, doomed.map((row) => row.id)));
  return doomed.length;
}

/* ------------------------------------------------------------------ */
/* Profile fields                                                     */
/* ------------------------------------------------------------------ */

export type FieldInput = {
  label: string;
  type: string;
  /** Labels, one per entry, or `{value,label}` pairs. Ignored by most types. */
  options?: unknown;
  required?: boolean;
};

/** The shared checks for creating and editing a field. */
function validateFieldInput(input: FieldInput): AdminResult<{
  label: string;
  type: ProfileFieldType;
  options: ProfileFieldOption[];
  required: boolean;
}> {
  const label = cleanName(input.label);
  if (!label) return fail("Give the question a label — it is what the member reads.");

  if (!isFieldType(input.type)) return fail("Pick a question type.");
  const type = input.type;

  const info = fieldTypeInfo(type);
  const options = info.needsOptions ? normaliseOptions(input.options) : [];
  if (info.needsOptions && options.length === 0) {
    return fail(`"${info.label}" needs at least one option to choose from.`);
  }
  if (options.length > 60) return fail("That is too many options for one question.");

  return withData({ label, type, options, required: Boolean(input.required) });
}

/**
 * Add a question to a game, or to the global set when `gameId` is null.
 *
 * The key is slugged from the label and disambiguated automatically — unlike a
 * game key, nothing outside this table refers to it, so two questions both
 * labelled "Notes" becoming `notes` and `notes-2` is a convenience rather than a
 * surprise. The `(game_id, key)` unique index is `NULLS NOT DISTINCT`, which is
 * what makes the same rule work for global fields.
 */
export async function createField(
  gameId: string | null,
  input: FieldInput,
  database: Database = defaultDb
): Promise<AdminResult<ProfileField>> {
  const checked = validateFieldInput(input);
  if (!checked.ok) return checked;

  if (gameId) {
    const [game] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
    if (!game) return fail("That game no longer exists.");
    if (checked.data.type === "rank" && game.rankLadder.length === 0) {
      return fail(
        `${game.name} has no rank ladder yet, so a rank question would have nothing to offer. ` +
          "Add the ranks first."
      );
    }
  }

  const siblings = await database
    .select()
    .from(profileFields)
    .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId));

  const key = uniqueKey(checked.data.label, siblings.map((field) => field.key), "question");
  const sort = siblings.reduce((highest, field) => Math.max(highest, field.sort + 1), 0);

  const [created] = await database
    .insert(profileFields)
    .values({ gameId, key, sort, ...checked.data })
    .returning();

  return withData(created);
}

export type FieldEditImpact = {
  /** Answers stored against the field today. */
  answers: number;
  /** How many of them the proposed edit would invalidate and clear. */
  invalidated: number;
};

/**
 * What an edit to this field would cost, without making it.
 *
 * The honest version of "are you sure?": retyping a `select` as a `number`
 * invalidates every answer, while adding an option to a `multiselect`
 * invalidates none, and the admin should be able to tell those apart before
 * clicking rather than after.
 */
export async function previewFieldEdit(
  fieldId: string,
  input: FieldInput,
  database: Database = defaultDb
): Promise<FieldEditImpact> {
  const [field] = await database
    .select()
    .from(profileFields)
    .where(eq(profileFields.id, fieldId))
    .limit(1);
  if (!field) return { answers: 0, invalidated: 0 };

  const checked = validateFieldInput(input);
  const rows = await database
    .select()
    .from(profileValues)
    .where(eq(profileValues.fieldId, fieldId));
  if (!checked.ok || rows.length === 0) return { answers: rows.length, invalidated: 0 };

  const [game] = field.gameId
    ? await database.select().from(games).where(eq(games.id, field.gameId)).limit(1)
    : [null];

  const next: FieldShape = {
    type: checked.data.type,
    label: checked.data.label,
    options: checked.data.options,
    rankLadder: game?.rankLadder ?? [],
  };

  return {
    answers: rows.length,
    invalidated: rows.filter((row) => !valueStillValid(next, row.value)).length,
  };
}

/**
 * Edit a field's label, type, options or required flag, then clear any answer
 * the new definition makes nonsense of.
 *
 * The key is left alone on a relabel. It is an internal identifier; changing it
 * would break nothing today but would break a saved application answer in
 * Phase 2, and there is no reason to spend that.
 */
export async function updateField(
  fieldId: string,
  input: FieldInput,
  database: Database = defaultDb
): Promise<AdminResult<{ field: ProfileField; clearedAnswers: number }>> {
  const checked = validateFieldInput(input);
  if (!checked.ok) return checked;

  const [existing] = await database
    .select()
    .from(profileFields)
    .where(eq(profileFields.id, fieldId))
    .limit(1);
  if (!existing) return fail("That question no longer exists.");

  if (checked.data.type === "rank") {
    const [game] = existing.gameId
      ? await database.select().from(games).where(eq(games.id, existing.gameId)).limit(1)
      : [null];
    if (!game) return fail("A rank question has to belong to a game with a rank ladder.");
    if (game.rankLadder.length === 0) {
      return fail(`${game.name} has no rank ladder yet, so a rank question has nothing to offer.`);
    }
  }

  const [updated] = await database
    .update(profileFields)
    .set(checked.data)
    .where(eq(profileFields.id, fieldId))
    .returning();

  const cleared = await clearInvalidAnswers(existing.gameId, database);
  return withData({ field: updated, clearedAnswers: cleared });
}

/**
 * Delete a question and every answer to it.
 *
 * `profile_values.field_id` cascades, so the answers go with it whether or not
 * anyone counted them first — which is precisely why the screen calls
 * `fieldAnswerCount` and says the number out loud before offering the button.
 */
export async function deleteField(
  fieldId: string,
  database: Database = defaultDb
): Promise<AdminResult<{ deletedAnswers: number }>> {
  const answers = await fieldAnswerCount(fieldId, database);
  const [deleted] = await database
    .delete(profileFields)
    .where(eq(profileFields.id, fieldId))
    .returning({ id: profileFields.id, gameId: profileFields.gameId, sort: profileFields.sort });
  if (!deleted) return fail("That question no longer exists.");

  // Close the gap the delete left, so `sort` stays dense.
  const siblings = await database
    .select()
    .from(profileFields)
    .where(
      deleted.gameId
        ? eq(profileFields.gameId, deleted.gameId)
        : isNull(profileFields.gameId)
    )
    .orderBy(asc(profileFields.sort), asc(profileFields.createdAt));
  await writeFieldSort(database, siblings);

  return withData({ deletedAnswers: answers });
}

/** Move a question within its own section, then renumber that section. */
export async function moveField(
  fieldId: string,
  direction: "up" | "down",
  database: Database = defaultDb
): Promise<AdminResult> {
  const [field] = await database
    .select()
    .from(profileFields)
    .where(eq(profileFields.id, fieldId))
    .limit(1);
  if (!field) return fail("That question no longer exists.");

  const siblings = await database
    .select()
    .from(profileFields)
    .where(
      field.gameId ? eq(profileFields.gameId, field.gameId) : isNull(profileFields.gameId)
    )
    .orderBy(asc(profileFields.sort), asc(profileFields.createdAt));

  await writeFieldSort(database, reorderById(siblings, fieldId, direction));
  return done();
}

/* ------------------------------------------------------------------ */
/* Small read helper the page uses for its heading                    */
/* ------------------------------------------------------------------ */

/** How many games are switched on. `ne` keeps it one statement. */
export async function activeGameCount(database: Database = defaultDb): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(games)
    .where(ne(games.isActive, false));
  return Number(row?.total ?? 0);
}
