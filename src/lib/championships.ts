/**
 * Championships — the part that talks to Postgres (UC-31, UC-32, UC-35).
 *
 * The rules themselves live in `./championship-policy`, which has no database
 * handle: the state flow, the closed lock, what a season needs before it may be
 * published, and the two guards on the points table. This module reads, writes
 * and refuses, and it is where the lock is actually *applied*.
 *
 * **Where everyone finished is `./championship-results`**, not here. A season
 * and its counting events are an admin's objects, argued about on
 * `/admin/championships`; one event's finishing order is a *host's*, typed on
 * their own event the night it was played, and it moves whenever teams,
 * applications or placements do. Two reasons to change, two modules. That one
 * imports this one — `championshipOfEvent`, {@link fail} and
 * {@link NOT_COUNTING} — and nothing here asks about a place, so the
 * dependency runs one way.
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
 * The writes that count an event towards a season do the same, in the same
 * words, which is the whole of "a finished season does not change" — and they
 * carry it into the statement too, because a check followed by an
 * unconditional write is a window an admin can close a season inside.
 * `championship_events` cannot name `status` in its own `where`, so each write
 * reaches the season its own way: {@link setCountingEvent} and
 * {@link removeCountingEvent} through the {@link openSeasons} subquery,
 * {@link addCountingEvent} by inserting *from* a select over `championships`
 * that returns no row once the season is closed.
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

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  type EventStatus,
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
  weightProblem,
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

/** Exported for `./championship-results`, which returns the same refusals. */
export function fail(error: string, unscored?: UnscoredEvent[]): ChampionshipResult<never> {
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

/** A counting event still waiting for a finishing order, wherever it lives. */
export type UnscoredResult = UnscoredEvent & {
  slug: string;
  eventStatus: EventStatus;
  seasonId: string;
  seasonName: string;
};

/**
 * The same question as {@link unscoredCountingEvents}, asked across every
 * season at once — the admin home's line (UC-33 5).
 *
 * **Only events that have been played.** UC-33's precondition is that the
 * event has taken place, so a draft or a published event three weeks away is
 * not missing anything yet, and a cancelled one never will be. `complete` is
 * the ordinary case and is the whole reason this exists: the event whose
 * result is most conspicuously missing is the one that finished last night,
 * and recording it then is expressly allowed (UC-33 1b).
 *
 * A finished season is left out on the same reasoning as
 * `championshipsToAddTo`: it refuses the write, so listing it would be listing
 * a refusal.
 */
export async function unscoredResults(
  database: Database = defaultDb
): Promise<UnscoredResult[]> {
  const counting = await database
    .select({
      id: championshipEvents.id,
      eventId: championshipEvents.eventId,
      title: events.title,
      slug: events.slug,
      eventStatus: events.status,
      seasonId: championships.id,
      seasonName: championships.name,
    })
    .from(championshipEvents)
    .innerJoin(events, eq(events.id, championshipEvents.eventId))
    .innerJoin(championships, eq(championships.id, championshipEvents.championshipId))
    .where(
      and(ne(championships.status, "closed"), inArray(events.status, ["live", "complete"]))
    )
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
    .map(({ id: _countingId, ...row }) => row);
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

/** R-196's index: one event, at most one season (UC-32 1a). */
const EVENT_COLLISION = /championship_events_event_uniq/;

/**
 * Did this error come from somebody getting there first on one of these
 * indexes?
 *
 * drizzle re-throws with a generic "Failed query: …" and hangs the real
 * Postgres error off `cause`, so the chain is walked rather than the top
 * message read — the same shape `expectRejection` in the test helpers uses.
 *
 * Anything else is re-thrown by the callers. A refusal that swallows unrelated
 * database errors is worse than no refusal, so the index has to be named: a
 * unique violation somewhere else is still a bug.
 */
function uniqueViolation(error: unknown, index: RegExp): boolean {
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
  return (unique || /unique constraint/i.test(text)) && index.test(text);
}

/**
 * Did this error come from another admin getting the same name in first?
 *
 * Both indexes count: two admins typing "Winter 2026" at once collide on
 * whichever of the name and the slug Postgres happens to check first, and the
 * sentence an admin needs is the same either way.
 */
function duplicateSeason(error: unknown): boolean {
  return uniqueViolation(error, NAME_COLLISION);
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
   * three fields writes three — `updateEvent`'s shape, and the shape
   * {@link setCountingEvent} took for the Championship section on the event
   * editor, which saves a weight without carrying a points table it never
   * showed.
   *
   * It still buys nothing *here*: this editor is a single form and sends all
   * seven every time, so the merged values it writes back are the ones it just
   * read.
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

/* ------------------------------------------------------------------ */
/* Which events count, and for how much (UC-32)                       */
/* ------------------------------------------------------------------ */

/**
 * One event counting towards a season, as a screen lists it.
 *
 * `id` is the `championship_events` row rather than the event: it is what a
 * placement hangs off, so it is the id Task 41 records against.
 */
export type CountingEvent = {
  id: string;
  eventId: string;
  title: string;
  /** Above 0. Multiplies everything this event is worth. */
  weight: number;
  /** This event's own table, or null when it uses the season's. */
  pointsTable: number[] | null;
};

/**
 * The season one event counts towards, seen from the event.
 *
 * Carries the season's own scoring rules because the two settings below are
 * meaningless without them: the event editor has to show what "the season's
 * table" is before offering to replace it, and an event's own table is checked
 * against the season's participation points (see {@link setCountingEvent}).
 */
export type EventChampionship = CountingEvent & {
  season: {
    id: string;
    name: string;
    status: ChampionshipStatusValue;
    pointsTable: number[];
    participationPoints: number;
    countBest: number | null;
  };
};

/** Everything that may be set about one counting event. Only the keys present change. */
export type CountingEventFields = {
  weight?: number;
  /** The event's own table, or null to go back to the season's. */
  pointsTable?: number[] | null;
};

/** Asked by everything keyed on an event rather than on a counting row. */
export const NOT_COUNTING = "This event does not count towards a championship.";

/** UC-32 1a: refuse, and name the season that already has it. */
function alreadyCounting(name: string): string {
  return `This event already counts towards "${name}". Take it out of that season first.`;
}

/**
 * The seasons a child row may still be written under — the lock, as the write
 * itself sees it.
 *
 * `championshipLockRefusal` is asked first and produces the sentence; this is
 * the same rule in the `where`, so a season closed between the read and the
 * write takes no edit either. `updateChampionship` carries `status <> 'closed'`
 * for exactly this reason; a child table needs the subquery to say it.
 */
function openSeasons(database: Database) {
  return database
    .select({ id: championships.id })
    .from(championships)
    .where(ne(championships.status, "closed"));
}

/** Who is being offered a season to put an event into. */
export type CountingViewer = { isAdmin: boolean };

/**
 * The seasons this person may add an event to, newest first (UC-32 1).
 *
 * Two rules, and they pull in opposite directions, which is why this is a
 * function and not a `.filter()` in a page:
 *
 *  - **A finished season takes no new events** (UC-35 2b), so offering one
 *    would be offering a refusal. That holds for everybody.
 *  - **A hidden season is admins only** (UC-31 2: "only admins can see it").
 *    Its name and its points table are still being argued about, and a
 *    dropdown of every draft season is exactly the browsing that "only admins"
 *    excludes. A host is offered the published ones.
 *
 * The second rule is not a wall around the *event*: a host whose event already
 * counts towards a hidden season still sees that season on their own event and
 * can weight it or take it out, because {@link championshipOfEvent} answers
 * "what is this event in" rather than "what seasons exist". What a host may not
 * do is read the list of everybody else's unpublished ones.
 *
 * Nothing downstream depends on this being right — the three writes authorise
 * on the event, and a host who posts a hidden season's id straight at
 * `addEventToChampionshipAction` is not refused by it. That is deliberate, and
 * the reasoning is written out where that action is defined. This decides what
 * is *offered*.
 */
export async function championshipsToAddTo(
  viewer: CountingViewer,
  database: Database = defaultDb
): Promise<Array<{ id: string; name: string; status: ChampionshipStatusValue }>> {
  return database
    .select({
      id: championships.id,
      name: championships.name,
      status: championships.status,
    })
    .from(championships)
    .where(
      viewer.isAdmin
        ? ne(championships.status, "closed")
        : eq(championships.status, "published")
    )
    .orderBy(desc(championships.createdAt));
}

/** Every event counting towards this season, by name. */
export async function listCountingEvents(
  championshipId: string,
  database: Database = defaultDb
): Promise<CountingEvent[]> {
  return database
    .select({
      id: championshipEvents.id,
      eventId: championshipEvents.eventId,
      title: events.title,
      weight: championshipEvents.weight,
      pointsTable: championshipEvents.pointsTable,
    })
    .from(championshipEvents)
    .innerJoin(events, eq(events.id, championshipEvents.eventId))
    .where(eq(championshipEvents.championshipId, championshipId))
    .orderBy(asc(events.title));
}

/**
 * The season this event counts towards, or null.
 *
 * One row at most, because `championship_events.event_id` is unique — which is
 * the whole of R-196 and is why every write below is keyed on the event id
 * rather than on the counting row's. The caller authorising these writes
 * authorises on an event, so keying them on anything else would mean checking
 * one id and writing another (see `src/lib/event-scope.ts`).
 */
export async function championshipOfEvent(
  eventId: string,
  database: Database = defaultDb
): Promise<EventChampionship | null> {
  const [row] = await database
    .select({
      id: championshipEvents.id,
      eventId: championshipEvents.eventId,
      title: events.title,
      weight: championshipEvents.weight,
      pointsTable: championshipEvents.pointsTable,
      seasonId: championships.id,
      seasonName: championships.name,
      seasonStatus: championships.status,
      seasonPointsTable: championships.pointsTable,
      participationPoints: championships.participationPoints,
      countBest: championships.countBest,
    })
    .from(championshipEvents)
    .innerJoin(championships, eq(championships.id, championshipEvents.championshipId))
    .innerJoin(events, eq(events.id, championshipEvents.eventId))
    .where(eq(championshipEvents.eventId, eventId))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    eventId: row.eventId,
    title: row.title,
    weight: row.weight,
    pointsTable: row.pointsTable,
    season: {
      id: row.seasonId,
      name: row.seasonName,
      status: row.seasonStatus,
      pointsTable: row.seasonPointsTable,
      participationPoints: row.participationPoints,
      countBest: row.countBest,
    },
  };
}

/**
 * Count this event towards this season, at weight 1 (UC-32 1-2).
 *
 * An event completed weeks ago is as welcome as one that has not happened
 * (UC-32 1b): nothing is stored about what a season is worth, so its places
 * count from the moment they are recorded against it, which for a finished
 * event is the moment somebody types them in.
 *
 * The refusal an event already in a season gets names that season (UC-32 1a).
 * It is asked before the insert so the common path reads a sentence, and caught
 * after it so the race does too — `createChampionship`'s shape, for the same
 * reason: the check is the common path, the catch is the correct one.
 *
 * The lock gets the same treatment, which is why this inserts from a `select`
 * over `championships` rather than from plain values: the row only appears if
 * the season is *still* not closed when the insert runs. Checking the status
 * and then inserting unconditionally leaves a window in which an admin closes
 * the season — freezing standings somebody is about to read — and a new event
 * lands in it anyway.
 */
export async function addCountingEvent(
  championshipId: string,
  eventId: string,
  database: Database = defaultDb
): Promise<ChampionshipResult<EventChampionship>> {
  const season = await getChampionship(championshipId, database);
  if (!season) return fail("That championship no longer exists.");

  const locked = championshipLockRefusal(season);
  if (locked) return fail(locked);

  const [event] = await database
    .select({ id: events.id, title: events.title })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) return fail("That event no longer exists.");

  const existing = await championshipOfEvent(eventId, database);
  if (existing) return fail(alreadyCounting(existing.season.name));

  let added: typeof championshipEvents.$inferSelect | undefined;
  try {
    [added] = await database
      .insert(championshipEvents)
      .select(
        /*
         * Every column, in the table's order, because that is the list an
         * `insert … select` carries — there is no `default` keyword available
         * in a select list. The four that are not the two ids are
         * `championship_events`' own defaults, restated: a new counting event
         * is worth exactly one turn of the season's table (UC-32 2), on the
         * season's own points table until somebody says otherwise.
         */
        database
          .select({
            id: sql<string>`gen_random_uuid()`.as("id"),
            championshipId: championships.id,
            eventId: sql<string>`${eventId}::uuid`.as("event_id"),
            weight: sql<number>`1`.as("weight"),
            pointsTable: sql<number[] | null>`null::jsonb`.as("points_table"),
            addedAt: sql<Date>`now()`.as("added_at"),
          })
          .from(championships)
          .where(
            and(eq(championships.id, championshipId), ne(championships.status, "closed"))
          )
      )
      .returning();
  } catch (error) {
    if (uniqueViolation(error, EVENT_COLLISION)) {
      const winner = await championshipOfEvent(eventId, database);
      return fail(alreadyCounting(winner?.season.name ?? season.name));
    }
    throw error;
  }

  // Nothing inserted means the `select` matched nothing, and only the season
  // can have changed since it was read a moment ago.
  if (!added) {
    const fresh = await getChampionship(championshipId, database);
    if (!fresh) return fail("That championship no longer exists.");
    return fail(championshipLockRefusal(fresh) ?? CHANGED);
  }

  return {
    ok: true,
    data: {
      id: added.id,
      eventId,
      title: event.title,
      weight: added.weight,
      pointsTable: added.pointsTable,
      season: {
        id: season.id,
        name: season.name,
        status: season.status,
        pointsTable: season.pointsTable,
        participationPoints: season.participationPoints,
        countBest: season.countBest,
      },
    },
  };
}

/**
 * Set what one counting event is worth — its weight, its own points table, or
 * both (UC-32 3, 3a).
 *
 * Only the keys present change — `updateChampionship`'s shape, and it buys
 * nothing today for the same reason: the Championship panel shows both
 * settings in one save and sends both every time, so what it writes back for
 * the one it did not touch is what it just read. The rules below are checked
 * against the merged row regardless, because an event's own table is only
 * legal *relative to* the season it is in.
 *
 * The event's own table is checked by `scoringRulesProblem` against the
 * **season's** participation points, which is not a convenience: `placementValue`
 * floors any table out at those points, so a table whose last place is worth
 * less than taking part would pay better for finishing outside it than for
 * finishing last in it. One rule, asked of whichever table is in use.
 *
 * An empty table is stored as null rather than as `[]`. Scoring already treats
 * the two the same — `resultsForEvent` falls back to the season's table when
 * the event's has no rows — and one way of saying "use the season's" is enough.
 */
export async function setCountingEvent(
  eventId: string,
  fields: CountingEventFields,
  database: Database = defaultDb
): Promise<ChampionshipResult<EventChampionship>> {
  const current = await championshipOfEvent(eventId, database);
  if (!current) return fail(NOT_COUNTING);

  const locked = championshipLockRefusal(current.season);
  if (locked) return fail(locked);

  const changes: Partial<typeof championshipEvents.$inferInsert> = {};

  if ("weight" in fields) {
    const weight = Number(fields.weight);
    const problem = weightProblem(weight);
    if (problem) return fail(problem);
    changes.weight = weight;
  }

  if ("pointsTable" in fields) {
    const table = fields.pointsTable ?? null;
    if (table !== null) {
      const problem = scoringRulesProblem({
        pointsTable: table,
        participationPoints: current.season.participationPoints,
        countBest: current.season.countBest,
      });
      if (problem) return fail(problem);
    }
    changes.pointsTable = table === null || table.length === 0 ? null : table;
  }

  // A caller that asked for nothing gets what is already there rather than an
  // `update` with an empty `set`, which is not a statement Postgres has.
  if (Object.keys(changes).length === 0) return { ok: true, data: current };

  const [updated] = await database
    .update(championshipEvents)
    .set(changes)
    .where(
      and(
        eq(championshipEvents.eventId, eventId),
        inArray(championshipEvents.championshipId, openSeasons(database))
      )
    )
    .returning();

  if (!updated) return fail(CHANGED);
  return {
    ok: true,
    data: { ...current, weight: updated.weight, pointsTable: updated.pointsTable },
  };
}

/**
 * Stop counting this event (UC-32 4a).
 *
 * There is nothing to re-score afterwards and that is the design, not an
 * omission: a standing is `scoreChampionship` over the rows that are there, so
 * the season is already correct the next time anybody reads it. The places
 * recorded in this event go with it, by the cascade on
 * `championship_placements.championship_event_id` — they were places *in a
 * counting event*, and outside one they are not places in anything.
 */
export async function removeCountingEvent(
  eventId: string,
  database: Database = defaultDb
): Promise<ChampionshipResult<EventChampionship>> {
  const current = await championshipOfEvent(eventId, database);
  if (!current) return fail(NOT_COUNTING);

  const locked = championshipLockRefusal(current.season);
  if (locked) return fail(locked);

  const [removed] = await database
    .delete(championshipEvents)
    .where(
      and(
        eq(championshipEvents.eventId, eventId),
        inArray(championshipEvents.championshipId, openSeasons(database))
      )
    )
    .returning({ id: championshipEvents.id });

  if (!removed) return fail(CHANGED);
  return { ok: true, data: current };
}


/** `["a", "b", "c"]` → `"a, b and c"`. */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
