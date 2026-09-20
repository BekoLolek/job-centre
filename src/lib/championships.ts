/**
 * Championships — the part that talks to Postgres (UC-31, UC-35).
 *
 * The rules themselves live in `./championship-policy`, which has no database
 * handle: the state flow, the closed lock, what a season needs before it may be
 * published, and the two guards on the points table. This module reads, writes
 * and refuses, and it is where the lock is actually *applied*.
 *
 * ## The lock is asked for on every write, not remembered
 *
 * Every mutation below re-reads the row and asks
 * `championshipLockRefusal(current)` before it changes anything — the same
 * shape `events.ts`, `draft.ts` and `format.ts` use for a finished event. A
 * status the caller passed in is not evidence: the page it came from may be
 * ten minutes old, and by the time the write lands somebody else may have
 * closed the season. The `update` itself therefore also carries
 * `status <> 'closed'` in its `where`, so a season closed between the read and
 * the write takes no edit either.
 *
 * `setChampionshipStatus` is the one write that does not ask, because the one
 * legal move out of `closed` is the reopen. That is `canMoveChampionship`'s
 * job, and refusing `closed → hidden` there rather than with the lock message
 * is deliberate: the admin is not being told to reopen it, they are being told
 * that move does not exist.
 *
 * ## Why a move carries the status it was rendered with
 *
 * Every status change takes `from` and lands only on a row that still holds it,
 * exactly as `updateEvent` does. Two admins on the same list — one closing, one
 * unpublishing — otherwise both succeed, and the second silently undoes the
 * first while telling them both it worked.
 *
 * ## The slug never moves
 *
 * It is made from the name once, when the season is created, and renaming does
 * not touch it. `/championship/[slug]` (Task 42) is a link people paste into
 * Discord; a season renamed from "Winter 2026" to "Winter 2026/27" in March
 * must not break every one of them.
 */

import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  championshipEvents,
  championshipPlacements,
  championships,
  db as defaultDb,
  events,
} from "@/db";
import {
  CHAMPIONSHIP_PUBLISH_REQUIREMENT_TEXT,
  DEFAULT_POINTS_TABLE,
  canMoveChampionship,
  championshipLockRefusal,
  missingToPublishChampionship,
  scoringRulesProblem,
} from "./championship-policy";
import { uniqueKey } from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

export type ChampionshipRow = typeof championships.$inferSelect;

/** One counting event with nothing recorded in it yet (UC-35 1a). */
export type UnscoredEvent = { eventId: string; title: string };

/**
 * Every mutation returns this rather than throwing, for the same reason
 * `events.ts` does: the caller is a form, and a form wants a message next to
 * the control.
 *
 * `unscored` rides along on the one refusal that is a *question* rather than a
 * verdict — closing a season with a counting event nobody has scored. The
 * screen shows the names, the admin says yes, and the same call goes back with
 * `confirm`.
 */
export type ChampionshipResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; unscored?: UnscoredEvent[] };

function fail(error: string, unscored?: UnscoredEvent[]): ChampionshipResult<never> {
  return unscored ? { ok: false, error, unscored } : { ok: false, error };
}

/** The refusal when the season moved between reading it and writing it. */
const CHANGED = "The championship changed meanwhile - reload.";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 2000;

/* ------------------------------------------------------------------ */
/* Cleaning what a form sent                                          */
/* ------------------------------------------------------------------ */

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

function cleanNullable(raw: unknown, max: number): string | null {
  return cleanText(raw, max) || null;
}

/** Is this field blank, in the sense of "the admin cleared it"? */
function blank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

/**
 * A month, as the first of it — `"2026-03"` and `"2026-03-17"` both become
 * `"2026-03-01"`. Null when it is not a month at all.
 *
 * A season runs "March to November", not "March 3rd to November 17th", which
 * is what `championships_months_are_first` insists on in the column. The form
 * sends `<input type="month">`'s `"YYYY-MM"`; a row read back and sent again
 * sends the stored `"YYYY-MM-DD"`. Both land on the same day.
 */
function firstOfMonth(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/** Every season, newest first — the admin list, drafts and finished ones alike. */
export async function listChampionships(
  database: Database = defaultDb
): Promise<ChampionshipRow[]> {
  return database.select().from(championships).orderBy(desc(championships.createdAt));
}

/** One season, or null. */
export async function getChampionship(
  championshipId: string,
  database: Database = defaultDb
): Promise<ChampionshipRow | null> {
  const [row] = await database
    .select()
    .from(championships)
    .where(eq(championships.id, championshipId))
    .limit(1);
  return row ?? null;
}

/**
 * The counting events with no finishing order recorded, by name (UC-35 1a).
 *
 * Two queries rather than a `group by … having`, for the reason `listAudit`
 * gives: a season has tens of counting events, the set fits in memory, and the
 * pair reads as what it is — "the events, then which of them anybody has
 * scored".
 */
export async function unscoredCountingEvents(
  championshipId: string,
  database: Database = defaultDb
): Promise<UnscoredEvent[]> {
  const counting = await database
    .select({
      id: championshipEvents.id,
      eventId: championshipEvents.eventId,
      title: events.title,
    })
    .from(championshipEvents)
    .innerJoin(events, eq(events.id, championshipEvents.eventId))
    .where(eq(championshipEvents.championshipId, championshipId))
    .orderBy(asc(events.title));

  if (counting.length === 0) return [];

  const scored = await database
    .select({ id: championshipPlacements.championshipEventId })
    .from(championshipPlacements)
    .where(
      inArray(
        championshipPlacements.championshipEventId,
        counting.map((row) => row.id)
      )
    );

  const hasResult = new Set(scored.map((row) => row.id));
  return counting
    .filter((row) => !hasResult.has(row.id))
    .map((row) => ({ eventId: row.eventId, title: row.title }));
}

/* ------------------------------------------------------------------ */
/* Validation shared by create and edit                               */
/* ------------------------------------------------------------------ */

/** Everything an admin can set about a season. Only the keys present change. */
export type ChampionshipFields = {
  name?: string;
  description?: string | null;
  /** `"YYYY-MM"`, or null while the season's months are undecided. */
  runsFrom?: string | null;
  runsTo?: string | null;
  pointsTable?: number[];
  participationPoints?: number;
  countBest?: number | null;
};

export type CreateChampionshipInput = ChampionshipFields & {
  name: string;
  createdBy?: string | null;
};

/** The months, cleaned — or the sentence saying why they are not months. */
function readMonths(
  fields: { runsFrom?: string | null; runsTo?: string | null },
  current: { runsFrom: string | null; runsTo: string | null }
): { runsFrom: string | null; runsTo: string | null } | string {
  const runsFrom =
    "runsFrom" in fields ? (blank(fields.runsFrom) ? null : firstOfMonth(fields.runsFrom)) : current.runsFrom;
  const runsTo =
    "runsTo" in fields ? (blank(fields.runsTo) ? null : firstOfMonth(fields.runsTo)) : current.runsTo;

  if ("runsFrom" in fields && !blank(fields.runsFrom) && runsFrom === null) {
    return "The month the season starts has to be a month, like 2026-03.";
  }
  if ("runsTo" in fields && !blank(fields.runsTo) && runsTo === null) {
    return "The month the season ends has to be a month, like 2026-11.";
  }
  // UC-31 1a. `championships_months_ordered` says the same thing in the column;
  // this is the half that says it in words.
  if (runsFrom && runsTo && runsTo < runsFrom) return "A season cannot end before it starts.";

  return { runsFrom, runsTo };
}

/**
 * Is this name free among the seasons that are not finished?
 *
 * `championships_open_name_uniq` is a partial unique index on exactly that
 * condition — two finished seasons may both be "Winter 2026", two live ones may
 * not — and hitting it raises a constraint error with nothing an admin can
 * read in it. This is the same rule, asked first, so they get a sentence.
 *
 * It is a read before a write, so it is not the guarantee: two admins naming a
 * season "Winter 2026" in the same second both pass it. Postgres still refuses
 * the loser, and {@link duplicateSeason} turns that refusal into the same
 * sentence this one produces. The check is the common path; the catch is the
 * correct one.
 */
async function nameTaken(
  database: Database,
  name: string,
  exceptId?: string
): Promise<boolean> {
  const rows = await database
    .select({ id: championships.id })
    .from(championships)
    .where(
      and(
        eq(championships.name, name),
        ne(championships.status, "closed"),
        exceptId ? ne(championships.id, exceptId) : undefined
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** The two indexes a season's name can collide on — its own, and its slug's. */
const NAME_COLLISION = /championships_(open_name_uniq|slug_unique)/;

/**
 * Did this error come from another admin getting the same name in first?
 *
 * drizzle re-throws with a generic "Failed query: …" and hangs the real
 * Postgres error off `cause`, so the chain is walked rather than the top
 * message read — the same shape `expectRejection` in the test helpers uses.
 * Both indexes count: two admins typing "Winter 2026" at once collide on
 * whichever of the name and the slug Postgres happens to check first, and the
 * sentence an admin needs is the same either way.
 *
 * Anything else is re-thrown by the callers. A refusal that swallows unrelated
 * database errors is worse than no refusal.
 */
function duplicateSeason(error: unknown): boolean {
  const parts: string[] = [];
  let unique = false;
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const row = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (row.code === "23505") unique = true;
    if (row.constraint) parts.push(row.constraint);
    if (row.message) parts.push(row.message);
    current = row.cause;
  }
  const text = parts.join("\n");
  return (unique || /unique constraint/i.test(text)) && NAME_COLLISION.test(text);
}

/* ------------------------------------------------------------------ */
/* Creating                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create a season. It starts **hidden**, which is UC-31 2: only admins can see
 * it while the points table and the months are still being argued about.
 *
 * Everything but the name is optional and the points table defaults to
 * `DEFAULT_POINTS_TABLE`, so the quickest path to a working season is typing
 * its name and pressing publish.
 */
export async function createChampionship(
  input: CreateChampionshipInput,
  database: Database = defaultDb
): Promise<ChampionshipResult<ChampionshipRow>> {
  const name = cleanText(input.name, NAME_MAX);
  if (!name) return fail("Give the championship a name.");

  const months = readMonths(input, { runsFrom: null, runsTo: null });
  if (typeof months === "string") return fail(months);

  const scoring = {
    pointsTable: input.pointsTable ?? [...DEFAULT_POINTS_TABLE],
    participationPoints: input.participationPoints ?? 0,
    countBest: input.countBest ?? null,
  };
  const problem = scoringRulesProblem(scoring);
  if (problem) return fail(problem);

  if (await nameTaken(database, name)) {
    return fail(`There is already a season called "${name}".`);
  }

  const taken = await database.select({ slug: championships.slug }).from(championships);
  try {
    const [created] = await database
      .insert(championships)
      .values({
        slug: uniqueKey(name, taken.map((row) => row.slug), "season"),
        name,
        description: cleanNullable(input.description, DESCRIPTION_MAX),
        ...months,
        ...scoring,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return { ok: true, data: created };
  } catch (error) {
    // The other half of `nameTaken`: the admin who lost the race gets the same
    // sentence as the one who was merely second to the form.
    if (duplicateSeason(error)) return fail(`There is already a season called "${name}".`);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Editing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Edit a season. Only the keys present in `fields` change.
 *
 * Refused outright while the season is closed (UC-35 2b) — the points table is
 * exactly the sort of thing that must not move under a standing somebody has
 * already read. Reopening is one click away and is written down.
 */
export async function updateChampionship(
  championshipId: string,
  fields: ChampionshipFields,
  database: Database = defaultDb
): Promise<ChampionshipResult<ChampionshipRow>> {
  const current = await getChampionship(championshipId, database);
  if (!current) return fail("That championship no longer exists.");

  const locked = championshipLockRefusal(current);
  if (locked) return fail(locked);

  let name = current.name;
  if ("name" in fields) {
    name = cleanText(fields.name, NAME_MAX);
    if (!name) return fail("Give the championship a name.");
  }

  const months = readMonths(fields, current);
  if (typeof months === "string") return fail(months);

  const scoring = {
    pointsTable: fields.pointsTable ?? current.pointsTable,
    participationPoints: fields.participationPoints ?? current.participationPoints,
    countBest: "countBest" in fields ? (fields.countBest ?? null) : current.countBest,
  };
  const problem = scoringRulesProblem(scoring);
  if (problem) return fail(problem);

  if (name !== current.name && (await nameTaken(database, name, championshipId))) {
    return fail(`There is already a season called "${name}".`);
  }

  /*
   * Only the columns the caller sent, plus `updatedAt`, so a caller that sends
   * three fields writes three — `updateEvent`'s shape, and what lets a later
   * screen (Task 40's Championship section on the event editor) save one
   * setting without carrying the rest of the season along with it.
   *
   * It buys nothing today: the editor is a single form and sends all seven
   * every time, so the merged values it writes back are the ones it just read.
   * The rules above are checked against that merged season regardless, because
   * UC-31 4a is a rule *between* two of these fields and cannot be decided from
   * a partial payload.
   */
  const changes: Partial<typeof championships.$inferInsert> = { updatedAt: new Date() };
  if ("name" in fields) changes.name = name;
  if ("description" in fields) {
    changes.description = cleanNullable(fields.description, DESCRIPTION_MAX);
  }
  if ("runsFrom" in fields) changes.runsFrom = months.runsFrom;
  if ("runsTo" in fields) changes.runsTo = months.runsTo;
  if ("pointsTable" in fields) changes.pointsTable = scoring.pointsTable;
  if ("participationPoints" in fields) {
    changes.participationPoints = scoring.participationPoints;
  }
  if ("countBest" in fields) changes.countBest = scoring.countBest;

  // The lock again, this time as the database sees it: a season closed between
  // the read above and this write takes no edit either.
  try {
    const [updated] = await database
      .update(championships)
      .set(changes)
      .where(and(eq(championships.id, championshipId), ne(championships.status, "closed")))
      .returning();

    if (!updated) return fail(CHANGED);
    return { ok: true, data: updated };
  } catch (error) {
    if (duplicateSeason(error)) return fail(`There is already a season called "${name}".`);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* The lifecycle                                                      */
/* ------------------------------------------------------------------ */

export type StatusMoveOptions = {
  /** UC-35 1a: close it even though a counting event has no result. */
  confirm?: boolean;
};

/**
 * Move a season along the lifecycle — publish, unpublish, close, reopen.
 *
 * `from` is the status the control was rendered with, and the move lands only
 * on a row that still holds it. Each of the four edges carries its own guard:
 *
 *  - **publish** needs a name and a points table (UC-31 5), and — when it is a
 *    reopen — a name no open season already holds, because the partial unique
 *    index does not cover the closed row this one is about to stop being.
 *  - **close** needs every counting event scored, or `confirm` (UC-35 1a).
 *
 * Everything else the diagram does not draw is refused by `canMoveChampionship`
 * before any of that runs.
 */
export async function setChampionshipStatus(
  championshipId: string,
  from: ChampionshipStatusValue,
  to: ChampionshipStatusValue,
  options: StatusMoveOptions = {},
  database: Database = defaultDb
): Promise<ChampionshipResult<ChampionshipRow>> {
  const current = await getChampionship(championshipId, database);
  if (!current) return fail("That championship no longer exists.");
  if (current.status !== from) return fail(CHANGED);
  if (from === to) return fail(`This championship is already ${to}.`);
  if (!canMoveChampionship(from, to)) {
    return fail(`A championship cannot go from ${from} to ${to}.`);
  }

  if (to === "published") {
    const missing = missingToPublishChampionship(current);
    if (missing.length > 0) {
      const needs = missing.map((item) => CHAMPIONSHIP_PUBLISH_REQUIREMENT_TEXT[item]);
      return fail(
        `This championship cannot be published yet. It still needs ${andList(needs)}.`
      );
    }
    if (from === "closed" && (await nameTaken(database, current.name, championshipId))) {
      return fail(
        `There is already an open season called "${current.name}". Rename one of them first.`
      );
    }
  }

  if (to === "closed" && !options.confirm) {
    const unscored = await unscoredCountingEvents(championshipId, database);
    if (unscored.length > 0) {
      const names = unscored.map((row) => `"${row.title}"`);
      return fail(
        `${andList(names)} ${names.length === 1 ? "has" : "have"} no result yet. Close the season anyway?`,
        unscored
      );
    }
  }

  try {
    const [updated] = await database
      .update(championships)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(championships.id, championshipId), eq(championships.status, from)))
      .returning();

    if (!updated) return fail(CHANGED);
    return { ok: true, data: updated };
  } catch (error) {
    // A reopen moves this row *into* the partial index, so it races the same
    // way a create does — somebody else can take the name in between.
    if (duplicateSeason(error)) {
      return fail(
        `There is already an open season called "${current.name}". Rename one of them first.`
      );
    }
    throw error;
  }
}

/** `["a", "b", "c"]` → `"a, b and c"`. */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
