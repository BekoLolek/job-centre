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
 * "nothing destructive, ever" rule in checklist.md.
 *
 * ## Answers survive (R-09, UC-03 5a)
 *
 * The same rule now holds one level down, for the questions themselves:
 *
 *  - **Retiring** a question stops it being asked and keeps every answer
 *    (`retireField`). It is the replacement for deleting one people have used.
 *  - **Editing** a question never clears an answer (`updateField`). A retyped
 *    question can leave stored answers the new definition does not recognise;
 *    `previewFieldEdit` counts them so the admin knows, and they are *kept*
 *    rather than deleted, because an answer somebody gave is a fact about them
 *    and an admin's second thoughts about the wording are not a reason to
 *    forget it.
 *  - **Deleting** survives only for a question nobody has answered — a
 *    mistyped question with no answers is a normal thing to remove. One with
 *    answers is refused and pointed at retirement.
 */

import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  type Database,
  type Game,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileFieldType,
  db as defaultDb,
  events,
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
  /** Still asked. A retired question is in `retired`, not here. */
  fields: AdminFieldView[];
  /** Retired (UC-03 5a): no longer asked, answers still stored. */
  retired: AdminFieldView[];
  /** Answers across every field of this game, retired ones included. */
  answers: number;
};

export type AdminGamesView = {
  /** Every game, active or not, in `sort` order. */
  games: AdminGameView[];
  /** The `game_id is null` fields, which belong to no game (§7). */
  globalFields: AdminFieldView[];
  /** Retired global fields, same rule. */
  globalRetired: AdminFieldView[];
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

  const asked = (field: ProfileField) => field.retiredAt === null;
  const globals = fieldRows.filter((field) => field.gameId === null).map(decorate);

  return {
    games: gameRows.map((game) => {
      const mine = fieldRows.filter((field) => field.gameId === game.id).map(decorate);
      return {
        ...game,
        fields: mine.filter(asked),
        retired: mine.filter((field) => !asked(field)),
        // Deliberately the whole set: a retired question's answers are still
        // stored, and the number on the card is how much of this game's data
        // exists, not how much of it is on a profile form today.
        answers: mine.reduce((total, field) => total + field.answers, 0),
      };
    }),
    globalFields: globals.filter(asked),
    globalRetired: globals.filter((field) => !asked(field)),
    globalAnswers: globals.reduce((total, field) => total + field.answers, 0),
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

/**
 * Whether some *other* game already carries this name (UC-03 1a).
 *
 * Case- and space-insensitive, because "Marvel Rivals" and "marvel  rivals"
 * are the same game to everyone except `=`. `cleanName` has already collapsed
 * the spaces, so this only has to fold case.
 *
 * `exceptId` is what makes it work on a rename: a game is allowed to keep its
 * own name, and without it saving a row unchanged would reject itself.
 */
async function nameTaken(
  database: Database,
  name: string,
  exceptId?: string
): Promise<boolean> {
  const rows = await database.select({ id: games.id, name: games.name }).from(games);
  const wanted = name.toLowerCase();
  return rows.some((row) => row.id !== exceptId && row.name.toLowerCase() === wanted);
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
  if (await nameTaken(database, name)) return fail("That game already exists.");

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

/**
 * Rename a game. The key never moves — things point at it.
 *
 * The name is the only thing an admin ever reads a game by, so it carries the
 * same uniqueness rule on a rename as it does on a create (UC-03 1a). Without
 * it the catalogue can be walked into a state with two "Marvel Rivals" in it,
 * which the create path refuses outright — and a rule that only holds on the
 * way in is not a rule.
 */
export async function renameGame(
  gameId: string,
  rawName: string,
  database: Database = defaultDb
): Promise<AdminResult<Game>> {
  const name = cleanName(rawName);
  if (!name) return fail("Give the game a name.");
  if (await nameTaken(database, name, gameId)) return fail("That game already exists.");

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

/** One section's questions in `sort` order — a game's, or the global set's. */
async function siblingsOf(
  database: Database,
  gameId: string | null
): Promise<ProfileField[]> {
  return database
    .select()
    .from(profileFields)
    .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId))
    .orderBy(asc(profileFields.sort), asc(profileFields.createdAt));
}

/**
 * Renumber a section as asked-first, retired-after, 0…n-1.
 *
 * Retired questions keep a `sort` because they can be restored, but they are
 * parked behind the live ones. Leaving one sitting between two live questions
 * would make "move up" skip over something nobody can see, which reads on
 * screen as the button being broken — the same failure dense renumbering was
 * introduced to prevent.
 */
async function resequenceSection(database: Database, gameId: string | null): Promise<void> {
  const rows = await siblingsOf(database, gameId);
  await writeFieldSort(database, [
    ...rows.filter((row) => row.retiredAt === null),
    ...rows.filter((row) => row.retiredAt !== null),
  ]);
}

/* ------------------------------------------------------------------ */
/* Rank ladders                                                       */
/* ------------------------------------------------------------------ */

/** One event whose entry rule this ladder change would re-aim (UC-03 3b). */
export type LadderAffectedEvent = {
  id: string;
  slug: string;
  title: string;
  /** Which threshold moves: "enter", "captain", or both. */
  rules: Array<"enter" | "captain">;
  /** The rank each moved threshold names, so the warning can quote it. */
  ranks: string[];
  /** True when a threshold's own rank is being removed outright. */
  ranksGone: boolean;
};

export type LadderImpact = {
  /** Ladder entries that would stop being valid answers. */
  removed: string[];
  /** How many stored answers name one of them. */
  answers: number;
  /** Events whose rank rules this change re-aims. Empty when none. */
  events: LadderAffectedEvent[];
};

/**
 * Which ladder entries sit at or above `threshold`, as a set.
 *
 * This *is* an entry rule (R-10, §8.3): eligibility is "your rank is at least
 * the threshold's", so the rule's meaning is exactly the set of ranks it lets
 * in. Comparing that set before and after is therefore the only honest test of
 * whether a reorder changed anything.
 *
 * Null when the ladder does not contain the threshold at all — the rule has
 * been unmoored rather than moved, which the caller reports differently.
 */
function admitted(ladder: readonly string[], threshold: string): Set<string> | null {
  const at = ladder.indexOf(threshold);
  return at < 0 ? null : new Set(ladder.slice(at));
}

/**
 * Whether the two ladders let the same people through `threshold`.
 *
 * Only entries present in *both* ladders count. Adding a brand new rank is not
 * a change to an existing rule — nobody could have answered with it — and
 * flagging every addition would make the warning noise the admin learns to
 * click past, which is the one thing a warning must not become.
 */
function ruleMoved(
  before: readonly string[],
  after: readonly string[],
  threshold: string
): { moved: boolean; gone: boolean } {
  const was = admitted(before, threshold);
  const now = admitted(after, threshold);
  if (!was) return { moved: false, gone: false };
  if (!now) return { moved: true, gone: true };

  const shared = new Set(before.filter((name) => after.includes(name)));
  const trim = (set: Set<string>) => [...set].filter((name) => shared.has(name)).sort();
  const a = trim(was);
  const b = trim(now);
  return { moved: a.length !== b.length || a.some((name, at) => name !== b[at]), gone: false };
}

/**
 * Which events' rank rules a new ladder would re-aim (UC-03 3b).
 *
 * Read from `events` rather than from a count kept somewhere: an entry rule is
 * stored as the ladder *entry name* (§8.3), so its meaning is defined entirely
 * by where that name sits in `games.rank_ladder`. Move the name and the same
 * stored rule admits a different set of people, without anybody having edited
 * the event.
 */
async function ladderAffectedEvents(
  gameId: string,
  before: readonly string[],
  after: readonly string[],
  database: Database
): Promise<LadderAffectedEvent[]> {
  const rows = await database
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      enter: events.minRankToEnter,
      captain: events.minRankToCaptain,
    })
    .from(events)
    .where(eq(events.gameId, gameId));

  const out: LadderAffectedEvent[] = [];
  for (const row of rows) {
    const rules: Array<"enter" | "captain"> = [];
    const ranks: string[] = [];
    let ranksGone = false;

    const thresholds: Array<["enter" | "captain", string | null]> = [
      ["enter", row.enter],
      ["captain", row.captain],
    ];
    for (const [rule, threshold] of thresholds) {
      if (!threshold) continue;
      const { moved, gone } = ruleMoved(before, after, threshold);
      if (!moved) continue;
      rules.push(rule);
      if (!ranks.includes(threshold)) ranks.push(threshold);
      if (gone) ranksGone = true;
    }

    if (rules.length > 0) {
      out.push({ id: row.id, slug: row.slug, title: row.title, rules, ranks, ranksGone });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * What replacing this game's ladder would cost.
 *
 * Two separate costs, and the screen shows both before the write:
 *
 *  1. **Answers.** A `rank` answer stores the ladder entry's *name*, so
 *     removing an entry orphans every answer holding it. `setRankLadder`
 *     clears exactly those rows afterwards — the alternative is a profile
 *     displaying a rank the game no longer has. A pure *reorder* removes
 *     nothing and so costs no answers at all.
 *  2. **Events (UC-03 3b).** A reorder costs no answers but silently re-aims
 *     every entry rule written against this game, which is the change nobody
 *     sees coming. Those events are named before the save, not after.
 */
export async function previewRankLadder(
  gameId: string,
  nextLadder: readonly string[],
  database: Database = defaultDb
): Promise<LadderImpact> {
  const [game] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) return { removed: [], answers: 0, events: [] };

  const next = normaliseRankLadder([...nextLadder]);
  const keeping = new Set(next);
  const removed = game.rankLadder.filter((name) => !keeping.has(name));
  const affected = await ladderAffectedEvents(gameId, game.rankLadder, next, database);

  if (removed.length === 0) return { removed: [], answers: 0, events: affected };

  const rankFields = await database
    .select({ id: profileFields.id })
    .from(profileFields)
    .where(and(eq(profileFields.gameId, gameId), eq(profileFields.type, "rank")));
  if (rankFields.length === 0) return { removed, answers: 0, events: affected };

  const rows = await database
    .select({ fieldId: profileValues.fieldId, value: profileValues.value })
    .from(profileValues)
    .where(inArray(profileValues.fieldId, rankFields.map((field) => field.id)));

  const orphaned = rows.filter(
    (row) => typeof row.value === "string" && removed.includes(row.value)
  );
  return { removed, answers: orphaned.length, events: affected };
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
 * The one remaining caller is `setRankLadder`, and only when the admin has
 * confirmed a ladder entry's *removal*: an answer naming a rank the game no
 * longer has would render as a rank nobody can be. Editing a question does
 * **not** call this any more — see `updateField`.
 *
 * Retired questions are skipped. Their answers are the archive that retiring
 * exists to protect (UC-03 5a), and nothing is asking them to still parse.
 *
 * Reads the values rather than trying to express "still valid" in SQL, because
 * the rules live in `profile-fields` and having them in two places is how the
 * two versions drift apart.
 */
async function clearInvalidAnswers(
  gameId: string | null,
  database: Database = defaultDb
): Promise<number> {
  const [game] = gameId
    ? await database.select().from(games).where(eq(games.id, gameId)).limit(1)
    : [null];

  const fields = (
    await database
      .select()
      .from(profileFields)
      .where(gameId ? eq(profileFields.gameId, gameId) : isNull(profileFields.gameId))
  ).filter((field) => field.retiredAt === null);
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
  /**
   * How many of them the new definition would no longer recognise.
   *
   * They are **kept** either way — `updateField` deletes nothing (UC-03 5a).
   * This is the number that says "forty people answered this and your new
   * wording makes forty answers unreadable", which is a thing to know before
   * clicking rather than after.
   */
  invalidated: number;
};

/**
 * What an edit to this field would cost, without making it.
 *
 * The honest version of "are you sure?": retyping a `select` as a `number`
 * strands every answer, while adding an option to a `multiselect` strands
 * none, and the admin should be able to tell those apart before clicking
 * rather than after.
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
 * Edit a field's label, type, options or required flag. **No answer is ever
 * deleted by an edit** (UC-03 5a, R-09).
 *
 * This is the rule the module exists for. An answer is something a member
 * said; an admin's second thoughts about the wording of the question are not a
 * reason to forget it. Retyping `select` to `number` can leave answers the new
 * definition cannot read — `previewFieldEdit` counts them and the dialog says
 * the number — but they stay on the row, and putting the question back the way
 * it was brings every one of them back with it. That round trip is impossible
 * if the edit deleted them, and it is the difference between an edit and an
 * amputation.
 *
 * `strandedAnswers` is what comes back: how many stored answers the new
 * definition will not parse. Zero on a harmless edit.
 *
 * The key is left alone on a relabel. It is an internal identifier; changing it
 * would break nothing today but would break a saved application answer in
 * Phase 2, and there is no reason to spend that.
 */
export async function updateField(
  fieldId: string,
  input: FieldInput,
  database: Database = defaultDb
): Promise<AdminResult<{ field: ProfileField; strandedAnswers: number }>> {
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

  // Counted against the *incoming* definition before the write, which is the
  // same arithmetic `previewFieldEdit` did — so the number the admin confirmed
  // is the number they are told afterwards.
  const stranded = (await previewFieldEdit(fieldId, input, database)).invalidated;

  const [updated] = await database
    .update(profileFields)
    .set(checked.data)
    .where(eq(profileFields.id, fieldId))
    .returning();

  return withData({ field: updated, strandedAnswers: stranded });
}

/* ------------------------------------------------------------------ */
/* Retiring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Stop asking a question, keep every answer to it (UC-03 5a, R-09).
 *
 * The replacement for deleting one that people have used. `loadProfile` drops
 * it from the member's form and from that section's completeness, so nobody is
 * asked it again and nobody is marked incomplete for not having answered it;
 * `profile_values` is not touched at all. Switching it back on with
 * `restoreField` brings every answer back onto the form exactly as it was,
 * which is the whole point — the same bargain `setGameActive` makes one level
 * up.
 *
 * Already retired is not an error. A second click on a button that has done
 * its job is a double click, not a fault, and reporting one would be the
 * screen arguing with the admin about something it already agrees with.
 */
export async function retireField(
  fieldId: string,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<AdminResult<{ field: ProfileField; keptAnswers: number }>> {
  const [existing] = await database
    .select()
    .from(profileFields)
    .where(eq(profileFields.id, fieldId))
    .limit(1);
  if (!existing) return fail("That question no longer exists.");

  const kept = await fieldAnswerCount(fieldId, database);
  const [updated] = await database
    .update(profileFields)
    .set({ retiredAt: existing.retiredAt ?? now })
    .where(eq(profileFields.id, fieldId))
    .returning();

  await resequenceSection(database, existing.gameId);
  return withData({ field: updated, keptAnswers: kept });
}

/** Ask it again. Every answer stored while it was retired comes back with it. */
export async function restoreField(
  fieldId: string,
  database: Database = defaultDb
): Promise<AdminResult<{ field: ProfileField; restoredAnswers: number }>> {
  const restored = await fieldAnswerCount(fieldId, database);
  const [updated] = await database
    .update(profileFields)
    .set({ retiredAt: null })
    .where(eq(profileFields.id, fieldId))
    .returning();
  if (!updated) return fail("That question no longer exists.");

  await resequenceSection(database, updated.gameId);
  return withData({ field: updated, restoredAnswers: restored });
}

/**
 * Delete a question **nobody has answered**.
 *
 * `profile_values.field_id` cascades, so a delete really does take every
 * answer with it — which is why a question with answers is refused outright
 * and pointed at `retireField` instead (UC-03 5a). There is no confirm dialog
 * that makes destroying them acceptable, and offering one only moves the
 * decision to the tiredest moment of somebody's evening.
 *
 * A question with no answers is a different thing: a typo, added five minutes
 * ago, that should simply go. That one still deletes.
 */
export async function deleteField(
  fieldId: string,
  database: Database = defaultDb
): Promise<AdminResult<{ deletedAnswers: number }>> {
  const answers = await fieldAnswerCount(fieldId, database);
  if (answers > 0) {
    return fail(
      `${answers === 1 ? "1 member has" : `${answers} members have`} answered this question, ` +
        "so it cannot be deleted. Retire it instead: it stops being asked and every answer " +
        "is kept."
    );
  }

  const [deleted] = await database
    .delete(profileFields)
    .where(eq(profileFields.id, fieldId))
    .returning({ id: profileFields.id, gameId: profileFields.gameId, sort: profileFields.sort });
  if (!deleted) return fail("That question no longer exists.");

  // Close the gap the delete left, so `sort` stays dense.
  await resequenceSection(database, deleted.gameId);

  return withData({ deletedAnswers: answers });
}

/**
 * Move a question within its own section, then renumber that section.
 *
 * The move happens among the questions of the same standing — a live question
 * swaps with the live question next to it, never with a retired one it cannot
 * see. Retired questions are then written back behind the live ones, so the
 * section stays dense either way.
 */
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

  const siblings = await siblingsOf(database, field.gameId);
  const asked = siblings.filter((row) => row.retiredAt === null);
  const retired = siblings.filter((row) => row.retiredAt !== null);
  const moving = field.retiredAt === null ? asked : retired;
  const staying = field.retiredAt === null ? retired : asked;

  const reordered = reorderById(moving, fieldId, direction);
  await writeFieldSort(
    database,
    field.retiredAt === null ? [...reordered, ...staying] : [...staying, ...reordered]
  );
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
