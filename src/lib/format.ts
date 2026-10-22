/**
 * The format engine — the part that talks to Postgres (§7, §8.2, §10).
 *
 * The rules live in `./format-policy`, the generation in `./bracket`, the
 * resolution in `./format-resolve` and the running order in
 * `./format-schedule`; none of them has a database handle and all four are
 * tested exhaustively. This module is the trust boundary and the transaction
 * boundary, exactly as `./events` is for applications and `./draft` is for the
 * money.
 *
 * ## Nothing here believes the request
 *
 * Stage ids, match ids, team ids and scores are re-read from the database on
 * every write. A result posted against a match in another event is refused
 * outright rather than ignored, and a winner override naming a team that is not
 * in the match is refused with a sentence saying so.
 *
 * ## Generating a bracket is one transaction, and it is not destructive
 *
 * Regenerating a stage rewrites every match in it. Anything already played is a
 * completed result, and checklist.md's standing rule is that no feature may
 * erase one — so `generateMatches` refuses outright the moment a single game in
 * the stage has been ticked off. Changing the format after the first game is
 * not an edit, it is a different tournament.
 *
 * ## The matches follow the teams, and the server is what makes them (R-73)
 *
 * `syncStages` is the one function that answers "should these rows be rebuilt",
 * and every path that can change the answer calls it inside its own server
 * action: the stage list, the team count, a hand placement. It used to be an
 * effect in the Format tab, which meant the answer was only ever computed on a
 * screen somebody happened to be looking at — change the teams with the Format
 * tab shut and the bracket stayed on yesterday's shape until somebody opened it
 * (UC-18 8, 9).
 *
 * It has exactly three outcomes per stage, and the middle one is the whole
 * design (UC-18 9a):
 *
 *  - **current** — the rows already are what `(kind, team count, config)` says.
 *    Nothing is written, which is what makes calling this after every team
 *    write cheap.
 *  - **out of date** — they are not, and the stage is carrying something a
 *    rebuild would destroy. `stages.out_of_date_since` is stamped and the rows
 *    are left exactly as they are. `rebuildStage` is the way through, and it
 *    says what it will clear first.
 *  - **rebuilt** — they are not, and nobody has touched the stage.
 *
 * `stageTouchOf` is what separates the last two, and it is deliberately wider
 * than `stageHasResults`: a score typed in but never ticked off blocks the
 * *automatic* path even though it does not block a manager who has been told
 * about it. An automation that can destroy work has to refuse whenever it
 * cannot tell, because the person who would have said "yes, go on" is not
 * there.
 *
 * ## What is deliberately not stored
 *
 * Labels, stakes notes, phases, placements and the whole schedule plan. All of
 * them are functions of `(kind, teamCount, config)`, which is stored, so a
 * column for any of them would be a second copy that can disagree — the same
 * argument that keeps `balance_left` off `teams` and `applications_open` off
 * `events`.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  type Database,
  type EventRow,
  type MatchGameRow,
  type MatchRow,
  type Stage,
  type StageConfigJson,
  type StageKindValue,
  type Team,
  db as defaultDb,
  events,
  matchGames,
  matches,
  stages,
  teams,
} from "@/db";
import {
  type GeneratedStage,
  type MatchBracket,
  generateStage,
  swissNextRound,
} from "./bracket";
import { lockRefusal } from "./archive-policy";
import { type AuditEntry, recordAudit } from "./audit";
import type { EventResult } from "./events";
import {
  type FormatTiming,
  type MatchSlot,
  type PlaySide,
  type StageConfig,
  type StageKind,
  MAX_DAYS,
  MAX_TEAMS,
  isMatchSlot,
  isStageKind,
  normaliseFormatTiming,
  normaliseMatchSlot,
  normaliseModeName,
  normalisePlaySide,
  normaliseStageConfig,
  readScore,
  scoreRefusal,
  seriesRefusal,
  teamCountRefusal,
  tossForFirstSideChoice,
  unresolvedSlotRefusal,
} from "./format-policy";
import {
  type GameChoice,
  type MatchGameRecord,
  type MatchRecord,
  type ResolvedMatch,
  type Standing,
  StageResolution,
  type TeamRef,
  blankGamesFor,
  seedOrderFrom,
  seedingFrom,
} from "./format-resolve";
import {
  type PlannedBlock,
  type ScheduleOptions,
  autoSchedule,
  dayMinutes,
  planBlocks,
  recalculateSchedule,
  syncFinish,
} from "./format-schedule";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * The same discriminated result `./events` and `./draft` return, and
 * deliberately the same type rather than a twin: the callers are forms, and a
 * form wants one shape to branch on however many modules it talks to.
 */
export type FormatResult<T = null> = EventResult<T>;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function withData<T>(data: T): FormatResult<T> {
  return { ok: true, data };
}

/** How many stages one event may have. Two — groups then playoffs — is the case. */
export const MAX_STAGES = 4;

const NAME_MAX = 60;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/* ------------------------------------------------------------------ */
/* Shapes the pages render                                            */
/* ------------------------------------------------------------------ */

export type StageView = {
  id: string;
  name: string;
  kind: StageKind;
  sort: number;
  config: StageConfig;
  teamCount: number;
  /** The generated spec this stage's board is drawn from. */
  spec: GeneratedStage;
  matches: ResolvedMatch[];
  /** The whole table, and one per group when the stage has groups. */
  standings: Standing[];
  groups: Array<{ key: string; standings: Standing[] }>;
  placements: Array<{ position: number; shared: number; teamId: string }>;
  champion: string | null;
  /** What this stage hands the next one, or null while it is unsettled. */
  seeding: string[] | null;
  /**
   * The seeding this stage was *resolved from*, best first — the team list's own
   * order for the first stage, the previous stage's finishing order after that,
   * and a row of nulls while that stage is still being played.
   *
   * It is what makes a source reference readable in both directions: `seed:3`
   * resolves through it, and so does the reverse question `advanceSwiss` has to
   * answer, which is "this team is which seed of this stage".
   */
  seeds: Array<string | null>;
  /** When a manager last moved something here by hand (R-157 / UC-19 E2). */
  handEditedAt: string | null;
  /**
   * When these matches stopped matching the format and the teams (UC-18 9a).
   * Non-null is the board's "out of date", and the one state with a button.
   */
  outOfDateSince: string | null;
};

export type FormatView = {
  eventId: string;
  teams: TeamRef[];
  stages: StageView[];
  /** The running order across every stage, in block order. */
  blocks: PlannedBlock[];
  /** Minutes per day, day 1 first. */
  dayMinutes: number[];
  timing: FormatTiming;
  concurrentLobbies: number;
  days: number;
};

/* ------------------------------------------------------------------ */
/* Small shared reads                                                 */
/* ------------------------------------------------------------------ */

async function readEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

/**
 * Read the event **and take its row lock**, so everything that follows in this
 * transaction is the only thing rewriting this event's bracket. The lock is on
 * the event rather than the table, so two tournaments never queue behind each
 * other.
 */
async function lockEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function readTeams(database: Database, eventId: string): Promise<Team[]> {
  return database
    .select()
    .from(teams)
    .where(eq(teams.eventId, eventId))
    .orderBy(asc(teams.sort), asc(teams.createdAt));
}

async function readStageRows(database: Database, eventId: string): Promise<Stage[]> {
  return database
    .select()
    .from(stages)
    .where(eq(stages.eventId, eventId))
    .orderBy(asc(stages.sort), asc(stages.createdAt));
}

async function readMatchRows(database: Database, stageIds: string[]): Promise<MatchRow[]> {
  if (stageIds.length === 0) return [];
  return database
    .select()
    .from(matches)
    .where(inArray(matches.stageId, stageIds))
    .orderBy(asc(matches.phase), asc(matches.slot));
}

async function readGameRows(database: Database, matchIds: string[]): Promise<MatchGameRow[]> {
  if (matchIds.length === 0) return [];
  return database
    .select()
    .from(matchGames)
    .where(inArray(matchGames.matchId, matchIds))
    .orderBy(asc(matchGames.index));
}

/* ------------------------------------------------------------------ */
/* Row ↔ record                                                       */
/* ------------------------------------------------------------------ */

/** Instants leave the database as `Date`; everything above this line wants ISO. */
function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function recordFrom(row: MatchRow, games: MatchGameRow[]): MatchRecord {
  return {
    slot: row.slot,
    bestOf: row.bestOf,
    teamAId: row.teamAId,
    teamBId: row.teamBId,
    sourceA: row.sourceA,
    sourceB: row.sourceB,
    scheduledAt: iso(row.scheduledAt),
    finishedAt: iso(row.finishedAt),
    durationMin: row.durationMin,
    winnerOverrideId: row.winnerOverrideId,
    firstSideChoice: normaliseMatchSlot(row.firstSideChoice),
    games: games
      .filter((g) => g.matchId === row.id)
      .sort((x, y) => x.index - y.index)
      .map((g) => ({
        index: g.index,
        mode: g.mode,
        map: g.map,
        referee: g.referee,
        scoreA: g.scoreA,
        scoreB: g.scoreB,
        played: g.played,
        sideChosen: normalisePlaySide(g.sideChosen),
      })),
  };
}

function teamRefs(rows: Team[]): TeamRef[] {
  return rows.map((row) => ({ id: row.id, name: row.name, seed: row.seed }));
}

/** The stage kind as the policy layer knows it, tolerating a stored oddity. */
function kindOf(row: Stage): StageKind {
  return isStageKind(row.kind) ? row.kind : "round_robin";
}

/* ------------------------------------------------------------------ */
/* Scheduling settings                                                */
/* ------------------------------------------------------------------ */

/**
 * The schedule settings live on `events.config` rather than in a table of their
 * own: they are three numbers and a list, read once per schedule screen, and
 * the format tab saves them together — none of the three arguments that made
 * `draft_configs` a table applies.
 */
export type ScheduleSettings = {
  timing: FormatTiming;
  concurrentLobbies: number;
  days: number;
  blockDays: number[] | null;
};

export function scheduleSettingsFrom(config: unknown): ScheduleSettings {
  const raw = (config ?? {}) as Record<string, unknown>;
  const format = (raw.format ?? {}) as Record<string, unknown>;
  const days = Number(format.days);
  const lobbies = Number(format.concurrentLobbies);
  const blockDays = Array.isArray(format.blockDays)
    ? format.blockDays.map((v) => Math.max(1, Math.trunc(Number(v)) || 1))
    : null;

  return {
    timing: normaliseFormatTiming((format.timing ?? null) as Partial<FormatTiming> | null),
    concurrentLobbies: Number.isFinite(lobbies) ? Math.min(8, Math.max(1, Math.trunc(lobbies))) : 2,
    days: Number.isFinite(days) ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(days))) : 1,
    blockDays: blockDays?.length ? blockDays : null,
  };
}

function scheduleOptionsFrom(settings: ScheduleSettings): ScheduleOptions {
  return {
    timing: settings.timing,
    concurrentLobbies: settings.concurrentLobbies,
    days: settings.days,
    blockDays: settings.blockDays,
  };
}

/* ------------------------------------------------------------------ */
/* Reading the whole format                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything the boards render, resolved.
 *
 * Stages are resolved in order and chained: each one seeds from the previous
 * one's finishing order, and a stage whose predecessor is still being played
 * simply has no seeds yet — which is exactly why its bracket shows "Seed 1"
 * rather than a team name. That chain is the generalisation of the current
 * board's `seedsFor`, which refuses to seed the bracket until the last
 * round-robin map is in.
 */
export async function formatFor(
  eventId: string,
  database: Database = defaultDb
): Promise<FormatView | null> {
  const event = await readEvent(database, eventId);
  if (!event) return null;

  const [teamRows, stageRows] = await Promise.all([
    readTeams(database, eventId),
    readStageRows(database, eventId),
  ]);
  const matchRows = await readMatchRows(
    database,
    stageRows.map((s) => s.id)
  );
  const gameRows = await readGameRows(
    database,
    matchRows.map((m) => m.id)
  );

  const settings = scheduleSettingsFrom(event.config);
  const refs = teamRefs(teamRows);
  const specs: GeneratedStage[] = [];
  const views: StageView[] = [];
  // The first stage seeds itself from the team list; every later one seeds from
  // the stage before it, and a row of nulls while that stage is still being
  // played — *not* a fallback to the team order, which would fill a bracket
  // from a table that has not finished moving.
  let seeds: Array<string | null> | null = null;

  for (const row of stageRows) {
    const kind = kindOf(row);
    const spec = generateStage(kind, teamRows.length, row.config as Partial<StageConfig>);
    const records = matchRows
      .filter((m) => m.stageId === row.id)
      .map((m) => recordFrom(m, gameRows));

    const resolution: StageResolution = new StageResolution({
      stage: spec,
      matches: records,
      teams: refs,
      seeds,
    });
    specs.push(spec);
    views.push({
      seeds: seedingFrom({ stage: spec, matches: records, teams: refs, seeds }),
      handEditedAt: iso(row.handEditedAt),
      outOfDateSince: iso(row.outOfDateSince),
      id: row.id,
      name: row.name ?? defaultStageName(kind),
      kind,
      sort: row.sort,
      config: spec.config,
      teamCount: teamRows.length,
      spec,
      matches: resolution.matches(),
      standings: resolution.table(null),
      groups: spec.groups.map((g) => ({ key: g.key, standings: resolution.table(g.key) })),
      placements: resolution.placements(),
      champion: resolution.champion(),
      seeding: resolution.seeding(),
    });
    seeds = resolution.seeding() ?? teamRows.map(() => null);
  }

  const blocks = planBlocks(specs, scheduleOptionsFrom(settings));

  return {
    eventId,
    teams: refs,
    stages: views,
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: settings.timing,
    concurrentLobbies: settings.concurrentLobbies,
    days: settings.days,
  };
}

/**
 * Slot to row id, for every match in an event.
 *
 * A `ResolvedMatch` deliberately carries no id: it is a *generated* slot plus
 * whatever happens to be stored against it, and the generated half has no row —
 * which is exactly what lets a bracket be previewed before it exists. The
 * writes below all take a row id, so a screen that renders the board and then
 * wants to record against it needs this one mapping, and it is cheaper and more
 * honest than hanging a nullable id off every resolved match.
 *
 * Keyed by slot alone rather than by stage and slot, which is the assumption
 * `writeSchedule` and `setWinnerOverride` already make: the running order and
 * the re-flow index every match of an event by slot, so two stages sharing one
 * would already be indistinguishable to the scheduler.
 */
export async function matchIdsFor(
  eventId: string,
  database: Database = defaultDb
): Promise<Record<string, string>> {
  const rows = await database
    .select({ id: matches.id, slot: matches.slot })
    .from(matches)
    .where(eq(matches.eventId, eventId));
  return Object.fromEntries(rows.map((row) => [row.slot, row.id]));
}

function defaultStageName(kind: StageKind): string {
  switch (kind) {
    case "round_robin":
      return "Round robin";
    case "single_elim":
      return "Playoffs";
    case "double_elim":
      return "Playoffs";
    case "swiss":
      return "Swiss";
    case "group_playoff":
      return "Groups and playoffs";
  }
}

/* ------------------------------------------------------------------ */
/* Stages                                                             */
/* ------------------------------------------------------------------ */

export type StageInput = {
  /** Present to update an existing stage, absent to create one. */
  id?: string;
  name?: string;
  kind: StageKindValue | string;
  config?: Partial<StageConfig> | null;
};

/**
 * Replace an event's stage list.
 *
 * Deleting a stage takes its matches with it, so a stage with a played game is
 * refused — the same rule `generateMatches` applies, and for the same reason.
 *
 * ## Everything is checked before anything is written
 *
 * `recordGames`' two passes, for `recordGames`' reason and the rule in
 * docs/decisions/004-refusals-inside-transactions.md: nothing here calls
 * `tx.rollback()`, and drizzle **commits** a transaction whose callback returns
 * rather than throws. The delete below used to run before the survivors were
 * checked, and both of the checks underneath it can refuse — a stage id that
 * names nothing, and a kind change on a stage that has results. So one save
 * that removed an empty stage *and* reshaped a played one deleted the empty
 * stage, committed it, and told the manager nothing had happened.
 *
 * The whole input list is therefore validated first, then the removals, then
 * the delete, then the writes. Two loops instead of one, and the second one
 * cannot refuse.
 */
export async function setStages(
  eventId: string,
  input: StageInput[],
  database: Database = defaultDb
): Promise<FormatResult<Stage[]>> {
  if (input.length > MAX_STAGES) {
    return fail(`An event can have at most ${MAX_STAGES} stages.`);
  }
  for (const stage of input) {
    if (!isStageKind(stage.kind)) return fail(`"${String(stage.kind)}" is not a stage format.`);
  }

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const existing = await readStageRows(tx, eventId);
    const keep = new Set(input.map((s) => s.id).filter((id): id is string => Boolean(id)));
    const removed = existing.filter((row) => !keep.has(row.id));
    const byId = new Map(existing.map((row) => [row.id, row]));

    /*
     * Pass one: decide. `planned` is what each row of the input would become,
     * and not one of them has been written yet — nor has the delete below run,
     * which is the point. Both refusals in here were under the delete.
     */
    const planned: Array<{ sort: number; name: string; kind: StageKind; config: StageConfig; current: Stage | undefined }> = [];
    for (const [sort, stage] of input.entries()) {
      const kind = stage.kind as StageKind;
      const current = stage.id ? byId.get(stage.id) : undefined;

      if (stage.id && !current) return fail("One of those stages no longer exists.");

      // Changing the shape of a stage that has been played is not an edit.
      if (current && kind !== current.kind && (await stageHasResults(tx, current.id))) {
        return fail(`"${current.name ?? current.kind}" has results recorded, so its format cannot change.`);
      }

      planned.push({
        sort,
        name: cleanText(stage.name, NAME_MAX) || defaultStageName(kind),
        kind,
        config: normaliseStageConfig(kind, stage.config ?? null),
        current,
      });
    }

    for (const row of removed) {
      if (await stageHasResults(tx, row.id)) {
        return fail(`"${row.name ?? row.kind}" has results recorded, so it cannot be removed.`);
      }
    }

    // Pass two: write. Nothing below refuses.
    if (removed.length) {
      await tx.delete(stages).where(
        inArray(
          stages.id,
          removed.map((r) => r.id)
        )
      );
    }

    const out: Stage[] = [];
    for (const { sort, name, kind, config, current } of planned) {
      if (current) {
        const [row] = await tx
          .update(stages)
          .set({ name, kind, sort, config })
          .where(eq(stages.id, current.id))
          .returning();
        out.push(row);
      } else {
        const [row] = await tx
          .insert(stages)
          .values({ eventId, name, kind, sort, config })
          .returning();
        out.push(row);
      }
    }

    return withData(out);
  });
}

/**
 * Has anything actually happened in this stage?
 *
 * Three things count, and all three are results a regeneration would erase: a
 * game ticked off, an admin's winner override, and a recorded finish. A score
 * typed in but never ticked is not a result — that is a card filled in ahead of
 * time, and it is the one state an admin may still change their mind about.
 */
async function stageHasResults(database: Database, stageId: string): Promise<boolean> {
  const played = await database
    .select({ id: matchGames.id })
    .from(matchGames)
    .innerJoin(matches, eq(matchGames.matchId, matches.id))
    .where(and(eq(matches.stageId, stageId), eq(matchGames.played, true)))
    .limit(1);
  if (played.length > 0) return true;

  const settled = await database
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.stageId, stageId),
        or(isNotNull(matches.winnerOverrideId), isNotNull(matches.finishedAt))
      )
    )
    .limit(1);
  return settled.length > 0;
}

/**
 * Generate — or regenerate — every match of one stage.
 *
 * The whole of §8.2 in one call: the bracket, its byes, its source references,
 * its series lengths and the mode sequence of every game, for any team count
 * from 2 to 8. Table games are written with their teams already filled in
 * (there is nothing to resolve); bracket slots are written with sources only.
 *
 * Refused once anything has been played, because a regeneration is a delete.
 */
export async function generateMatches(
  stageId: string,
  database: Database = defaultDb
): Promise<FormatResult<{ created: number }>> {
  return database.transaction(async (tx) => {
    const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId)).limit(1);
    if (!stage) return fail("That stage no longer exists.");

    const event = await lockEvent(tx, stage.eventId);
    if (!event) return fail("That event no longer exists.");

    // Two gates, and both are needed. `stageHasResults` protects a stage
    // mid-tournament; the lock protects an event whose bracket was generated,
    // never played and then marked finished — nothing to erase in this stage,
    // but regenerating it would still rewrite a closed record's shape.
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    if (await stageHasResults(tx, stageId)) {
      return fail("This stage already has results, so it cannot be regenerated.");
    }

    const teamRows = await readTeams(tx, stage.eventId);
    if (teamRows.length > MAX_TEAMS) return fail(`An event can have at most ${MAX_TEAMS} teams.`);

    // Per kind, named, and nothing generated (UC-18 2a). The old pair of
    // messages said "at least two teams" for every shape, which is true of a
    // bracket and false of three groups — and the shapes that could not be
    // built were silently clamped into one that could.
    const kind = kindOf(stage);
    const config = normaliseStageConfig(kind, stage.config as Partial<StageConfig>);
    const refusal = teamCountRefusal(kind, teamRows.length, config);
    if (refusal) return fail(refusal);

    const created = await writeStageMatches(tx, stage, teamRows);
    return withData({ created });
  });
}

/**
 * Delete every match of one stage and write the generated shape in its place —
 * the destructive half of every rebuild path, in one place.
 *
 * It decides nothing. Whether the stage may be rebuilt at all is the caller's
 * question: `generateMatches` asks `stageHasResults`, `syncStages` asks
 * `stageTouchOf`, and `rebuildStage` asks the manager. Three copies of the
 * insert loop would be three chances for one of them to drift into writing a
 * bracket the other two would not.
 *
 * ## It also clears the stage's three stored marks
 *
 * `hand_edited_at` and `out_of_date_since` both describe rows that no longer
 * exist after this, so leaving either set would be a warning about matches that
 * have gone. A Swiss stage's recorded pairings go the same way and for the same
 * reason: the rounds they paired have just been deleted, so the stage goes back
 * to round one rather than regenerating rounds nobody will play.
 */
async function writeStageMatches(
  tx: Database,
  stage: Stage,
  teamRows: Team[]
): Promise<number> {
  const kind = kindOf(stage);
  const config = normaliseStageConfig(kind, stage.config as Partial<StageConfig>);
  const fresh: StageConfig = { ...config, swissRounds: {} };
  const spec = generateStage(kind, teamRows.length, fresh);
  const seeded = seedOrderOf(teamRows);

  await tx.delete(matches).where(eq(matches.stageId, stage.id));
  await tx
    .update(stages)
    .set({ config: fresh as unknown as StageConfigJson, handEditedAt: null, outOfDateSince: null })
    .where(eq(stages.id, stage.id));

  await insertGenerated(tx, stage, spec.matches, seeded);
  return spec.matches.length;
}

/** Write these generated matches as rows, with their blank cards. */
async function insertGenerated(
  tx: Database,
  stage: Stage,
  wanted: GeneratedStage["matches"],
  seeded: string[]
): Promise<void> {
  for (const match of wanted) {
    // A table game's pairing is known from the start; a bracket slot's is not,
    // and writing a guess into it would defeat the whole resolve-on-read idea.
    const direct = match.bracket === "rr";
    const [row] = await tx
      .insert(matches)
      .values({
        stageId: stage.id,
        eventId: stage.eventId,
        slot: match.slot,
        round: match.round,
        phase: match.phase,
        bestOf: match.bestOf,
        teamAId: direct ? teamFromSource(match.sourceA, seeded) : null,
        teamBId: direct ? teamFromSource(match.sourceB, seeded) : null,
        sourceA: match.sourceA,
        sourceB: match.sourceB,
        // The coin, tossed once per match and never again unless an admin
        // asks. Everything after game 1 is a parity check on the game index
        // (§8.4), so this one value is the whole of the assignment.
        firstSideChoice: tossForFirstSideChoice(),
      })
      .returning({ id: matches.id });

    const games = blankGamesFor(match);
    if (games.length) {
      await tx.insert(matchGames).values(
        games.map((game) => ({
          matchId: row.id,
          index: game.index,
          mode: game.mode,
          map: game.map,
          referee: game.referee,
          scoreA: game.scoreA,
          scoreB: game.scoreB,
          played: game.played,
          sideChosen: game.sideChosen,
        }))
      );
    }
  }
}

/**
 * The teams in seed order — `seedOrderFrom`, which is also what the resolver
 * reads, so a stored table pairing and a resolved bracket slot cannot disagree
 * about who holds `seed:3` (R-160 / UC-18 E5).
 */
function seedOrderOf(rows: Team[]): string[] {
  return seedOrderFrom(rows);
}

function teamFromSource(source: string, seeded: string[]): string | null {
  const match = /^seed:([1-9][0-9]*)$/.exec(source);
  return match ? (seeded[Number(match[1]) - 1] ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Are these rows still the shape the settings describe? (R-73)       */
/* ------------------------------------------------------------------ */

/**
 * One line per match, describing everything a regeneration would write.
 *
 * Comparing the generated spec against the stored rows is the only honest
 * answer to "are these matches current", and it has to be the whole row rather
 * than a count. The Format tab's old effect compared `rows.length` against
 * `spec.matches.length`, which is blind to every change that keeps the count:
 * a stage moved from Bo3 to Bo5, a mode sequence edited, a grand final given
 * its own length, and — the one that matters most here — a team removed and
 * another added, which leaves a four-team round robin with six matches pointing
 * at a team that is no longer in the event.
 *
 * What is deliberately **not** in the line: the coin (random per generation, so
 * including it would make every stage permanently stale), the schedule, and
 * anything recorded. Those are facts about the rows, not about their shape.
 */
function shapeLines(spec: GeneratedStage, seeded: string[]): string[] {
  return spec.matches
    .map((match) => {
      const direct = match.bracket === "rr";
      return [
        match.slot,
        match.round,
        match.phase,
        match.bestOf,
        match.sourceA,
        match.sourceB,
        direct ? (teamFromSource(match.sourceA, seeded) ?? "") : "",
        direct ? (teamFromSource(match.sourceB, seeded) ?? "") : "",
        match.modes.join("+"),
      ].join("~");
    })
    .sort();
}

/**
 * The same line, read back off the rows that are actually stored.
 *
 * ## A played game's mode is a record, so the spec's own mode is read there
 * (R-153 / UC-19 E1)
 *
 * `match_games.mode` is two things at different times. Before the game it is
 * the *plan* — `blankGamesFor` copies it out of `config.modeSequence`, and
 * editing that sequence has to make the untouched rows stale, which is why the
 * mode is in this line at all. After the game it is the **record**: UC-19 E1
 * lets a manager write down that game 2 was actually a domination, and R-153
 * asks for exactly that so "the record is complete".
 *
 * Comparing the second against the plan is comparing a fact against an
 * intention, and it had two bad answers, both reproduced before this: on a
 * stage nobody had played, `syncStages` called the stage out of shape and
 * **rebuilt it**, deleting the mode somebody had just recorded; on a stage with
 * results it marked the stage out of date for ever, with the Format tab
 * explaining that "there are results in the way" about a stage whose only
 * divergence was the record of what happened in it.
 *
 * So a played game's mode is read as whatever the spec says it would be: the
 * record cannot make the rows stale, and an edited mode sequence still can,
 * because the games it has not reached yet are still the plan.
 */
function storedShapeLines(
  rows: MatchRow[],
  games: MatchGameRow[],
  spec: GeneratedStage
): string[] {
  return rows
    .map((row) =>
      [
        row.slot,
        row.round,
        row.phase,
        row.bestOf,
        row.sourceA ?? "",
        row.sourceB ?? "",
        row.teamAId ?? "",
        row.teamBId ?? "",
        games
          .filter((game) => game.matchId === row.id)
          .sort((x, y) => x.index - y.index)
          .map((game) =>
            game.played ? (spec.bySlot[row.slot]?.modes[game.index] ?? game.mode) : game.mode
          )
          .join("+"),
      ].join("~")
    )
    .sort();
}

/** Has somebody touched this stage, and would a rebuild therefore lose work? */
export type StageTouch = {
  playedGames: number;
  overrides: number;
  finished: number;
  /** Scores typed in but never ticked off. Not a result; still somebody's work. */
  draftedScores: number;
  scheduled: number;
  /** A manager moved a start time here (R-157 / UC-19 E2). */
  handEdited: boolean;
  /** True when `generateMatches` and `setStages` refuse outright. */
  blocked: boolean;
  /**
   * True when nothing may rebuild this stage **without being asked**. Wider
   * than `blocked` on purpose — see the note at the top of the file.
   */
  touched: boolean;
};

/**
 * What one stage is carrying, from rows that have already been read.
 *
 * `blocked` mirrors `stageHasResults` exactly — a game ticked off, an admin's
 * winner override, a recorded finish — because those two answers disagreeing is
 * a dialog that promises a rebuild the write then refuses.
 */
function stageTouchOf(
  stage: Stage,
  rows: MatchRow[],
  games: MatchGameRow[]
): StageTouch {
  const ids = new Set(rows.map((row) => row.id));
  const inStage = games.filter((game) => ids.has(game.matchId));

  const playedGames = inStage.filter((game) => game.played).length;
  const draftedScores = inStage.filter(
    (game) => !game.played && (game.scoreA > 0 || game.scoreB > 0)
  ).length;
  const overrides = rows.filter((row) => row.winnerOverrideId).length;
  const finished = rows.filter((row) => row.finishedAt).length;
  const scheduled = rows.filter((row) => row.scheduledAt).length;
  const handEdited = stage.handEditedAt !== null;
  const blocked = playedGames > 0 || overrides > 0 || finished > 0;

  return {
    playedGames,
    overrides,
    finished,
    draftedScores,
    scheduled,
    handEdited,
    blocked,
    touched: blocked || handEdited || draftedScores > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Keeping the matches in step with the teams (R-73 / UC-18 8, 9, 9a) */
/* ------------------------------------------------------------------ */

/** What the sync did about one stage. */
export type StageSync = {
  stageId: string;
  name: string;
  kind: StageKind;
  /**
   * `current` — nothing needed doing. `rebuilt` — the rows were replaced.
   * `out_of_date` — they needed replacing and the stage is carrying work, so
   * they were left alone and marked (UC-18 9a). `refused` — they cannot be
   * built at all, and `reason` says why in a sentence (UC-18 2a).
   */
  state: "current" | "rebuilt" | "out_of_date" | "refused";
  created: number;
  reason: string | null;
  touch: StageTouch;
};

export type SyncResult = {
  stages: StageSync[];
  rebuilt: number;
  outOfDate: number;
};

/**
 * **Bring every untouched stage back into line with the teams and the settings**
 * (R-73 / UC-18 9).
 *
 * Called from the same server action as whatever changed: saving the stage
 * list, setting the team count, placing somebody on a roster by hand. That is
 * the acceptance criterion — changing the teams with the Format tab never
 * opened leaves the matches current — and it is why this is a library function
 * rather than an effect: a screen can only react to a change somebody is
 * watching.
 *
 * ## It takes the event's row lock, like every other write here
 *
 * A rebuild deletes and re-inserts a whole stage, and the thing it races is a
 * result being recorded into the stage it is deleting. Both take `for update`
 * on the event, so one of them finishes first and the other reads what it did:
 * a result that lands first makes the stage `touched`, and the rebuild declines
 * and marks it out of date instead. Half a bracket is not reachable.
 *
 * ## It never fails because of a stage
 *
 * A stage that cannot be built — three groups and four teams, a shape stored
 * under a kind this build does not know — is reported as `refused` with the
 * sentence, not thrown. The caller is a team write that has already succeeded,
 * and failing it afterwards would mean reporting an error for something that
 * did happen.
 */
export async function syncStages(
  eventId: string,
  database: Database = defaultDb
): Promise<FormatResult<SyncResult>> {
  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const stageRows = await readStageRows(tx, eventId);
    if (stageRows.length === 0) return withData({ stages: [], rebuilt: 0, outOfDate: 0 });

    const teamRows = await readTeams(tx, eventId);
    const matchRows = await readMatchRows(
      tx,
      stageRows.map((row) => row.id)
    );
    const gameRows = await readGameRows(
      tx,
      matchRows.map((row) => row.id)
    );
    const seeded = seedOrderOf(teamRows);

    // A finished or cancelled event is a closed record. Nothing here rewrites
    // one, not even into a shape that would be right if it were still running.
    const locked = lockRefusal(event);

    const out: StageSync[] = [];
    const now = new Date();

    for (const stage of stageRows) {
      const rows = matchRows.filter((row) => row.stageId === stage.id);
      const touch = stageTouchOf(stage, rows, gameRows);
      const name = stage.name ?? stage.kind;
      const base = { stageId: stage.id, name, created: 0, touch };

      if (locked) {
        out.push({ ...base, kind: kindOf(stage), state: "refused", reason: locked });
        continue;
      }

      // A kind this build does not know is the plainest "cannot tell" there is:
      // `kindOf` would read it as a round robin, so rebuilding would quietly
      // replace somebody's bracket with a league table.
      if (!isStageKind(stage.kind)) {
        out.push({
          ...base,
          kind: kindOf(stage),
          state: "refused",
          reason: `“${name}” is stored as a format this version does not know, so its matches were left alone.`,
        });
        continue;
      }

      const kind = stage.kind;
      const config = normaliseStageConfig(kind, stage.config as Partial<StageConfig>);
      const refusal =
        teamRows.length > MAX_TEAMS
          ? `An event can have at most ${MAX_TEAMS} teams.`
          : teamCountRefusal(kind, teamRows.length, config);

      if (refusal) {
        // Nothing generated (UC-18 2a) — but rows that are already there and no
        // longer match are still out of date, and saying so is the only way the
        // screen can explain why the bracket on it is yesterday's.
        const refusedSpec = generateStage(kind, teamRows.length, config);
        const stale =
          rows.length > 0 &&
          lineOf(shapeLines(refusedSpec, seeded)) !==
            lineOf(storedShapeLines(rows, gameRows, refusedSpec));
        if (stale) {
          await markOutOfDate(tx, stage, now);
          out.push({ ...base, kind, state: "out_of_date", reason: refusal });
        } else {
          out.push({ ...base, kind, state: "refused", reason: refusal });
        }
        continue;
      }

      const spec = generateStage(kind, teamRows.length, config);
      const wanted = lineOf(shapeLines(spec, seeded));
      const stored = lineOf(storedShapeLines(rows, gameRows, spec));

      if (rows.length > 0 && wanted === stored) {
        // Current. If it was marked out of date — a rebuild ran, or the teams
        // came back to what they were — the mark is no longer true.
        if (stage.outOfDateSince) {
          await tx.update(stages).set({ outOfDateSince: null }).where(eq(stages.id, stage.id));
        }
        out.push({ ...base, kind, state: "current", reason: null });
        continue;
      }

      if (touch.touched) {
        await markOutOfDate(tx, stage, now);
        out.push({ ...base, kind, state: "out_of_date", reason: null });
        continue;
      }

      const created = await writeStageMatches(tx, stage, teamRows);
      out.push({ ...base, kind, state: "rebuilt", created, reason: null });
    }

    return withData({
      stages: out,
      rebuilt: out.filter((row) => row.state === "rebuilt").length,
      outOfDate: out.filter((row) => row.state === "out_of_date").length,
    });
  });
}

/** The shape lines as one comparable value. */
function lineOf(lines: string[]): string {
  return lines.join("|");
}

/**
 * One log line for what the sync did, and none at all when it did nothing.
 *
 * It lives here rather than in an action file because three different actions
 * call `syncStages` — the stage list, the team count, a hand placement — and
 * "the bracket was rebuilt because the teams changed" is a line somebody reads
 * the morning after. It should read the same whichever screen caused it, which
 * a sentence written three times would not.
 *
 * `format.generated` rather than a new action name: the log already colours
 * that one as destructive, which a rebuild is.
 *
 * It cannot throw — `recordAudit` swallows its own failures — which matters
 * because every caller is a write that has already succeeded.
 */
export async function auditStageSync(
  actor: AuditEntry["actor"],
  eventId: string,
  sync: FormatResult<SyncResult>,
  database: Database = defaultDb
): Promise<void> {
  if (!sync.ok) return;
  const rebuilt = sync.data.stages.filter((stage) => stage.state === "rebuilt");
  const stale = sync.data.stages.filter((stage) => stage.state === "out_of_date");
  if (rebuilt.length === 0 && stale.length === 0) return;

  const parts: string[] = [];
  if (rebuilt.length > 0) {
    parts.push(
      `Rebuilt ${rebuilt.map((stage) => `${stage.name} (${stage.created})`).join(", ")}`
    );
  }
  if (stale.length > 0) {
    parts.push(
      `marked ${stale.map((stage) => stage.name).join(", ")} out of date — ${stale.length === 1 ? "it is" : "they are"} carrying work a rebuild would clear, so nothing was touched`
    );
  }

  await recordAudit(
    {
      action: "format.generated",
      actor,
      eventId,
      summary: `${parts.join("; ")}.`,
      detail: {
        rebuilt: rebuilt.length,
        outOfDate: stale.length,
        created: rebuilt.reduce((total, stage) => total + stage.created, 0),
      },
    },
    database
  );
}

/** Stamp the mark, once. A stage already out of date has been out of date since then. */
async function markOutOfDate(tx: Database, stage: Stage, now: Date): Promise<void> {
  if (stage.outOfDateSince) return;
  await tx.update(stages).set({ outOfDateSince: now }).where(eq(stages.id, stage.id));
}

/* ------------------------------------------------------------------ */
/* Letting a team be deleted at all (R-161 / UC-15 E1)                */
/* ------------------------------------------------------------------ */

/** What removing these teams would do to the matches that name them. */
export type TeamRelease = {
  /** Matches naming one of the teams, by stage. */
  stages: Array<{ stageId: string; name: string; matches: number; withResults: number }>;
  matches: number;
  /** Of those, the ones carrying a result — the ones that refuse the removal. */
  withResults: number;
};

/**
 * Which matches name one of these teams — asked *before* a removal, so the
 * confirm dialog can say what it costs (R-161 / UC-15 E1).
 *
 * Read-only, and it decides nothing.
 */
export async function matchesNamingTeams(
  eventId: string,
  teamIds: readonly string[],
  database: Database = defaultDb
): Promise<TeamRelease> {
  const empty: TeamRelease = { stages: [], matches: 0, withResults: 0 };
  if (teamIds.length === 0) return empty;

  const stageRows = await readStageRows(database, eventId);
  const rows = (
    await readMatchRows(
      database,
      stageRows.map((row) => row.id)
    )
  ).filter((row) => namesOneOf(row, teamIds));
  if (rows.length === 0) return empty;

  const games = await readGameRows(
    database,
    rows.map((row) => row.id)
  );
  const carrying = (row: MatchRow) =>
    row.winnerOverrideId !== null ||
    row.finishedAt !== null ||
    games.some((game) => game.matchId === row.id && game.played);

  const byStage = stageRows
    .map((stage) => {
      const mine = rows.filter((row) => row.stageId === stage.id);
      return {
        stageId: stage.id,
        name: stage.name ?? stage.kind,
        matches: mine.length,
        withResults: mine.filter(carrying).length,
      };
    })
    .filter((entry) => entry.matches > 0);

  return {
    stages: byStage,
    matches: rows.length,
    withResults: rows.filter(carrying).length,
  };
}

function namesOneOf(row: MatchRow, teamIds: readonly string[]): boolean {
  return teamIds.some(
    (id) => row.teamAId === id || row.teamBId === id || row.winnerOverrideId === id
  );
}

/**
 * **Let these teams be deleted** — or refuse, naming what is in the way
 * (R-161 / UC-15 E1).
 *
 * ## Why this has to exist at all
 *
 * `matches.team_a_id` references `teams` with no `on delete` action, on purpose:
 * cascading would erase a completed result and `set null` cannot null one half
 * of a composite key (see the column's docblock). So Postgres refuses to delete
 * a team that any match names, and it refuses with a foreign-key error — which
 * is the right instinct and the wrong sentence. Before this existed, lowering
 * the team count on an event whose matches had been generated failed with
 * `matches_team_a_event_fk` in front of the manager.
 *
 * ## What it does, and what it will not do
 *
 * A table game's pairing is *stored* (`team_a_id`), unlike a bracket slot's,
 * which is a source reference resolved on read. Nulling the two columns turns
 * the first into the second: the match resolves from `seed:n` against whatever
 * team list exists afterwards, which is exactly how every bracket match in the
 * engine already works, and the sync that follows rebuilds the stage properly.
 *
 * It **refuses** when one of those matches carries a result — a played game, a
 * recorded finish, or a winner override naming the team going. Nulling the
 * reference there would quietly re-attribute a completed result to whoever
 * inherits that seed, which is the standing rule's "erase a result" by a longer
 * route. The way through is the way through every other recorded mistake:
 * clear the series, or rebuild the stage, and then remove the team.
 */
export async function releaseTeamsFromMatches(
  eventId: string,
  teamIds: readonly string[],
  database: Database = defaultDb
): Promise<FormatResult<{ released: number }>> {
  if (teamIds.length === 0) return withData({ released: 0 });

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const release = await matchesNamingTeams(eventId, teamIds, tx);
    if (release.matches === 0) return withData({ released: 0 });

    if (release.withResults > 0) {
      const named = release.stages
        .filter((stage) => stage.withResults > 0)
        .map((stage) => `“${stage.name}”`)
        .join(", ");
      return fail(
        `${named} has a recorded result in a match one of those teams played, so removing the team would change who that result belongs to. Clear the series, or rebuild the stage, first.`
      );
    }

    const stageRows = await readStageRows(tx, eventId);
    const rows = (
      await readMatchRows(
        tx,
        stageRows.map((row) => row.id)
      )
    ).filter((row) => namesOneOf(row, teamIds));

    for (const row of rows) {
      await tx
        .update(matches)
        .set({
          teamAId: teamIds.includes(row.teamAId ?? "") ? null : row.teamAId,
          teamBId: teamIds.includes(row.teamBId ?? "") ? null : row.teamBId,
          winnerOverrideId: teamIds.includes(row.winnerOverrideId ?? "")
            ? null
            : row.winnerOverrideId,
        })
        .where(eq(matches.id, row.id));
    }

    return withData({ released: rows.length });
  });
}

/* ------------------------------------------------------------------ */
/* "Rebuild anyway" — what it clears, then clearing it (UC-18 9a)     */
/* ------------------------------------------------------------------ */

/**
 * What rebuilding — or removing, or reshaping — one stage would clear.
 *
 * Read before the write so a confirm dialog can name the results that would go
 * rather than counting them, the same problem `previewEventDays` solves for
 * days and `previewTeams` for teams.
 */
export type StageClearing = {
  stageId: string;
  name: string;
  /** Rows in the database — *not* the generated spec's length. See `stageClearings`. */
  matches: number;
  playedGames: number;
  /** Series with a winner — the ones a rebuild would actually lose. */
  decided: number;
  overrides: number;
  finished: number;
  scheduled: number;
  /** Scores typed in but never ticked off. Not a result; not a blocker. */
  draftedScores: number;
  /** A manager moved a start time in this stage (R-157 / UC-19 E2). */
  handEdited: boolean;
  /** True when `generateMatches` and `setStages` will refuse outright. */
  blocked: boolean;
  /** When the sync last found these matches out of step (UC-18 9a). */
  outOfDateSince: string | null;
  /** The results themselves, so the dialog can name them rather than count them. */
  results: Array<{ slot: string; label: string; line: string }>;
  /**
   * **The token `rebuildStage` demands back.**
   *
   * It is a digest of everything above, recomputed inside the rebuild's own
   * transaction. Hand back the one you were shown and the rebuild goes ahead;
   * hand back a stale one — because a result landed in the seconds the dialog
   * was open — and it is refused rather than clearing something the manager was
   * never told about. This is the only guard that can tell those two apart: the
   * stage looks identically rebuildable either way.
   */
  confirm: string;
};

/**
 * Count what every stage of this event is carrying — asked *before* any write.
 *
 * Over the matches that actually **exist**. `formatFor` resolves a stage's
 * matches from its generated spec whether or not a single row has been written,
 * which is exactly what lets a bracket be previewed before it exists — and it
 * means `stage.matches.length` is never zero and cannot answer "has this been
 * generated yet". The rows can.
 */
export async function stageClearings(
  eventId: string,
  database: Database = defaultDb
): Promise<StageClearing[]> {
  const view = await formatFor(eventId, database);
  if (!view) return [];

  const stageRows = await readStageRows(database, eventId);
  const matchRows = await readMatchRows(
    database,
    stageRows.map((row) => row.id)
  );
  const gameRows = await readGameRows(
    database,
    matchRows.map((row) => row.id)
  );

  return stageRows.map((stage) => {
    const rows = matchRows.filter((row) => row.stageId === stage.id);
    const resolved = view.stages.find((entry) => entry.id === stage.id);
    return clearingOf(stage, rows, gameRows, resolved ?? null);
  });
}

function clearingOf(
  stage: Stage,
  rows: MatchRow[],
  games: MatchGameRow[],
  resolved: StageView | null
): StageClearing {
  const touch = stageTouchOf(stage, rows, games);
  const stored = new Set(rows.map((row) => row.slot));
  const onBoard = (resolved?.matches ?? []).filter((match) => stored.has(match.slot));

  const results: StageClearing["results"] = [];
  let decided = 0;
  for (const match of onBoard) {
    // `status` and `needsDecision` are the resolver's answers, and they are the
    // ones the board shows: a void match has no winner, and a drawn decider is
    // not decided until somebody says so. Re-deriving either here is how a
    // dialog comes to disagree with the screen behind it.
    if (match.status === "done") decided += 1;
    if (match.games.some((game) => game.played) || match.winnerOverrideId || match.finishedAt) {
      results.push({
        slot: match.slot,
        label: match.displayLabel,
        line: `${match.nameA} ${match.gamesWonA}–${match.gamesWonB} ${match.nameB}`,
      });
    }
  }

  return {
    stageId: stage.id,
    name: stage.name ?? stage.kind,
    matches: rows.length,
    playedGames: touch.playedGames,
    decided,
    overrides: touch.overrides,
    finished: touch.finished,
    scheduled: touch.scheduled,
    draftedScores: touch.draftedScores,
    handEdited: touch.handEdited,
    blocked: touch.blocked,
    outOfDateSince: iso(stage.outOfDateSince),
    results,
    confirm: clearingDigest(stage, rows, games),
  };
}

/**
 * A short, stable fingerprint of everything in a stage that a rebuild destroys.
 *
 * Every played game, every score, every override, every finish, every start
 * time and the hand-edit mark. Anything a manager was shown in the dialog is in
 * here, so a value that still matches is a promise that nothing they were not
 * shown has appeared since.
 */
function clearingDigest(stage: Stage, rows: MatchRow[], games: MatchGameRow[]): string {
  const ids = new Set(rows.map((row) => row.id));
  const parts = [
    stage.id,
    iso(stage.handEditedAt) ?? "",
    ...[...rows]
      .sort((x, y) => x.slot.localeCompare(y.slot))
      .map((row) =>
        [
          row.slot,
          row.bestOf,
          row.winnerOverrideId ?? "",
          iso(row.finishedAt) ?? "",
          iso(row.scheduledAt) ?? "",
          row.durationMin ?? "",
          games
            .filter((game) => game.matchId === row.id)
            .sort((x, y) => x.index - y.index)
            .map((game) => `${game.index}:${game.scoreA}:${game.scoreB}:${game.played ? 1 : 0}`)
            .join(","),
        ].join("~")
      ),
    // A game whose match has gone is not reachable from the rows above, and a
    // digest that cannot see it would be a digest that misses a deletion.
    String(games.filter((game) => ids.has(game.matchId)).length),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * **Rebuild one stage over the top of what it is carrying** (UC-18 9a).
 *
 * The single most destructive operation on the site: it deletes every match of
 * the stage, and with them every played game, every score and every override in
 * it. So it is the one write that will not take an instruction on its own —
 * `confirm` has to be the `StageClearing.confirm` the manager was actually
 * shown, and it is recomputed here, inside the transaction, under the event's
 * row lock.
 *
 * Three different failures that a plain "force: true" flag cannot tell apart:
 *
 *  - The dialog was opened, a result was recorded in another tab, and the
 *    manager then pressed the button. The digest has moved, so this refuses and
 *    says what happened. Nothing is cleared.
 *  - The stage was rebuilt by somebody else in the meantime. Same answer.
 *  - The manager read what it would clear and meant it. The digest matches, and
 *    it is cleared.
 *
 * The event lock is what makes the recomputation meaningful: a result being
 * recorded concurrently either commits before this and changes the digest, or
 * waits behind it and is refused by the row that is no longer there.
 */
export async function rebuildStage(
  stageId: string,
  confirm: string,
  database: Database = defaultDb
): Promise<FormatResult<{ created: number; cleared: StageClearing }>> {
  return database.transaction(async (tx) => {
    const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId)).limit(1);
    if (!stage) return fail("That stage no longer exists.");

    const event = await lockEvent(tx, stage.eventId);
    if (!event) return fail("That event no longer exists.");

    // A finished event's record is closed, and "rebuild anyway" is not a key to
    // it. This is the same refusal `generateMatches` makes, and it comes first
    // because it does not depend on anything the manager was shown.
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const rows = await readMatchRows(tx, [stage.id]);
    const games = await readGameRows(
      tx,
      rows.map((row) => row.id)
    );
    const digest = clearingDigest(stage, rows, games);

    if (!confirm || confirm !== digest) {
      return fail(
        "Something in this stage changed since you were shown what rebuilding it would clear, so nothing was touched. Look again and confirm."
      );
    }

    const teamRows = await readTeams(tx, stage.eventId);
    if (teamRows.length > MAX_TEAMS) return fail(`An event can have at most ${MAX_TEAMS} teams.`);

    const kind = kindOf(stage);
    const config = normaliseStageConfig(kind, stage.config as Partial<StageConfig>);
    const refusal = teamCountRefusal(kind, teamRows.length, config);
    if (refusal) return fail(refusal);

    // Read the report back out *before* the delete: afterwards there is nothing
    // left to describe, and the caller's log line has to say what went.
    const view = await formatFor(stage.eventId, tx);
    const cleared = clearingOf(
      stage,
      rows,
      games,
      view?.stages.find((entry) => entry.id === stage.id) ?? null
    );

    const created = await writeStageMatches(tx, stage, teamRows);
    await reflow(tx, stage.eventId);
    return withData({ created, cleared });
  });
}

/* ------------------------------------------------------------------ */
/* Recording results                                                  */
/* ------------------------------------------------------------------ */

export type GamePatch = {
  index: number;
  mode?: string;
  map?: string;
  referee?: string;
  scoreA?: number;
  scoreB?: number;
  played?: boolean;
  /**
   * Which side the team holding the choice took. `null` clears it, and absent
   * leaves it alone — a note about the game, not part of the rule, so an admin
   * who never fills it in changes nothing about who chose what.
   */
  sideChosen?: PlaySide | string | null;
};

/**
 * A patch that cannot *add* anything: no game ticked, no score, no map, no
 * referee, no side taken, no mode.
 *
 * "Cannot add" and not "erases", because this says nothing about the fields a
 * patch leaves out. The merge in `recordGames` **preserves** `mode`, `map`,
 * `referee`, `played` and `sideChosen` when they are absent, so `{ index: 0 }`
 * satisfies every clause here while changing nothing at all, and
 * `{ index: 0, scoreA: 0 }` zeroes one score and leaves the tick where it was.
 * What the predicate guarantees is a *direction*: whatever a patch that passes
 * it writes, the series afterwards holds no result it did not hold before.
 *
 * It is the one shape allowed through the unresolved-slot refusal below, and
 * `clearMatch` is why: clearing a series is the way back from a score typed
 * against the wrong card, and a slot that has *stopped* resolving — because the
 * match feeding it was corrected, or its teams were removed — is exactly the
 * card that needs clearing. A refusal that caught it too would leave a wrong
 * result on the board with no way to remove it, which is the opposite of what
 * the refusal is for. Nothing can be recorded this way, so it is not a hole:
 * the worst an erasing patch can do is what the manager asked for.
 *
 * Because it is only a direction, it is not on its own enough to earn the
 * exemption — see `erasesSomething` and the pair of conditions below.
 */
function erasesOnly(patch: GamePatch): boolean {
  return (
    patch.played !== true &&
    !patch.scoreA &&
    !patch.scoreB &&
    !cleanText(patch.map, 60) &&
    !cleanText(patch.referee, NAME_MAX) &&
    !patch.sideChosen &&
    patch.mode === undefined
  );
}

/**
 * A patch that actually takes something away, rather than merely not adding.
 *
 * Read with `erasesOnly`: that one is about what the values *are*, this one is
 * about which fields are **named**. Every field here is one the merge only
 * leaves alone when it is absent, so a patch that mentions it and passes
 * `erasesOnly` can only be removing what is in it — `played: false` unticks,
 * `scoreA: 0` zeroes, `map: ""` and `referee: ""` blank, `sideChosen: null`
 * clears. `mode` cannot appear: `erasesOnly` requires it absent.
 */
function erasesSomething(patch: GamePatch): boolean {
  return (
    patch.played !== undefined ||
    patch.scoreA !== undefined ||
    patch.scoreB !== undefined ||
    patch.map !== undefined ||
    patch.referee !== undefined ||
    patch.sideChosen !== undefined
  );
}

/**
 * **A later match whose teams moved under a result that is already recorded**
 * (R-79 / UC-19 3a).
 *
 * Correcting a map re-propagates the whole bracket, which is the point of
 * resolving slots on read — but a later match that *already has maps recorded*
 * is the one case the propagation cannot fix by itself. Its games were played
 * by the teams that used to resolve there; after the correction a different
 * pair resolves, and the scoreline on the board now says two teams played a
 * series one of them was never in.
 *
 * So it is reported rather than resolved. There is no third answer the engine
 * could pick for the manager: whether those maps were really played by the new
 * team, or belong to a match that must now be cleared and replayed, is a fact
 * about a room and not about a bracket.
 *
 * It carries ids and counts, not sentences — the board the caller already has
 * holds the names, and `displayLabel` comes from the generated spec rather than
 * from a column, like everything else about a match's label.
 */
export type DependentFlag = {
  slot: string;
  /** The generated label — "Upper final", not a slot key. */
  label: string;
  /** How many games were already ticked off when the teams moved. */
  playedGames: number;
  /** Who resolved there before the write, and who does now. */
  before: { a: string | null; b: string | null };
  after: { a: string | null; b: string | null };
};

type SlotSnapshot = { a: string | null; b: string | null; played: number; label: string };

/** Every slot's resolved pair and played-game count, off one resolved board. */
function snapshotOf(view: FormatView | null): Map<string, SlotSnapshot> {
  const out = new Map<string, SlotSnapshot>();
  for (const stage of view?.stages ?? []) {
    for (const match of stage.matches) {
      out.set(match.slot, {
        a: match.teamAId,
        b: match.teamBId,
        played: match.games.filter((game) => game.played).length,
        label: match.displayLabel,
      });
    }
  }
  return out;
}

/**
 * The slots that changed hands while already carrying maps — the edited slot
 * excluded, because the manager is looking at that one.
 *
 * A pair becoming *unresolved* counts. A later match whose team has gone back
 * to "Upper semi 1 winner" while five maps sit against it is in the same
 * trouble as one whose team changed, and for the same reason.
 */
function flagsBetween(
  before: Map<string, SlotSnapshot>,
  after: Map<string, SlotSnapshot>,
  editedSlot: string
): DependentFlag[] {
  const out: DependentFlag[] = [];
  for (const [slot, was] of before) {
    if (slot === editedSlot || was.played === 0) continue;
    const now = after.get(slot);
    if (!now) continue;
    if (now.a === was.a && now.b === was.b) continue;
    out.push({
      slot,
      label: now.label,
      playedGames: was.played,
      before: { a: was.a, b: was.b },
      after: { a: now.a, b: now.b },
    });
  }
  return out;
}

export type RecordOutcome = {
  finishedAt: string | null;
  durationMin: number | null;
  /** UC-19 3a. Empty whenever nothing later moved. */
  flagged: DependentFlag[];
};

/**
 * Record part of a series, then keep the finish, the duration and the rest of
 * the day in step.
 *
 * The three follow from each other and cannot be left to the caller: ticking
 * off the deciding game finishes the match, which fixes its duration, which
 * moves every later block of that day (§10). Doing them in one transaction is
 * what stops a page ever showing a finished match inside a block that has not
 * ended.
 *
 * ## Everything is checked before anything is written
 *
 * This function used to validate as it wrote, patch by patch, and that is not a
 * detail: nothing in this codebase calls `tx.rollback()`, so returning a
 * refusal from the middle of the loop **committed** every patch before it. A
 * manager who sent five games and got "game 4's score is not a number" back
 * would have had games 1 to 3 stored and been told nothing was. UC-19 4a says
 * "nothing stored", so the two passes below are the requirement, not tidiness:
 * read, decide, and only then write.
 *
 * ## Three refusals, and all of them are about a result that cannot exist
 *
 *  - **A slot that has not resolved** (UC-19 pre1). "Winner of upper semi 1"
 *    cannot have a score. Only a write that takes something away is let
 *    through — see `erasesOnly` and `erasesSomething`.
 *  - **A score that is not a score** (UC-19 4a) — `scoreRefusal`, per game.
 *  - **A series that is not a series** (UC-19 4a, 5a) — `seriesRefusal`, asked
 *    of the merged state this write would leave behind rather than of the
 *    patch, which is what makes it hold when two managers save different halves
 *    of the same card.
 *
 * Every one of them is decided from reads taken **after** the event row lock,
 * so a board that moved between the manager pressing Save and this transaction
 * opening is refused against what is actually stored.
 */
export async function recordGames(
  matchId: string,
  patches: GamePatch[],
  options: { durationMin?: number | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<FormatResult<RecordOutcome>> {
  return database.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: matches.id, eventId: matches.eventId })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!found) return fail("That match no longer exists.");

    const event = await lockEvent(tx, found.eventId);
    if (!event) return fail("That event no longer exists.");

    // This is the write that can untick a played game and zero its score, so
    // it is the single most important one to refuse on a finished event.
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    return recordGamesIn(tx, matchId, patches, options);
  });
}

/**
 * `recordGames`' own work, with the event already locked and its refusal
 * already made - {@link overrideIn}'s sibling, split out for the same caller
 * and for the same reason.
 *
 * Every read it decides on is taken in here, under the lock the caller is
 * holding, which is what the two passes below rest on.
 */
async function recordGamesIn(
  tx: Database,
  matchId: string,
  patches: GamePatch[],
  options: { durationMin?: number | null; now?: Date }
): Promise<FormatResult<RecordOutcome>> {
  // Re-read under the lock. The first select only answered "which event is
  // this", and `bestOf`, `slot` and the override all decide something below.
  const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!match) return fail("That match no longer exists.");

  const boardBefore = await formatFor(match.eventId, tx);
  const resolved = boardBefore?.stages
    .flatMap((stage) => stage.matches)
    .find((entry) => entry.slot === match.slot);
  if (!resolved) return fail("That match is not part of the current format.");

  /*
   * The exemption belongs to a write that takes something away, which is two
   * conditions and not one. `every(erasesOnly)` alone is satisfied by two
   * shapes that erase nothing: an empty list, because `[].every(…)` is
   * vacuously true, and `{ index: 0 }`, because the fields `erasesOnly` cares
   * about are all preserved when absent. Either one bought a bare
   * `durationMin` — which `recordGamesAction` takes from the client beside
   * `games` — an exemption from UC-19 pre1: a duration stamped on a match
   * whose teams have not resolved, and `reflow` below then shifting the rest
   * of that day off it. No score can be written that way, so the cost is a
   * wrong schedule rather than a wrong result, but the refusal has to fire.
   *
   * `some(erasesSomething)` covers the empty list on its own — nothing to
   * erase in nothing — so there is no separate length check to keep in step.
   */
  const erasing = patches.some(erasesSomething) && patches.every(erasesOnly);
  if (!erasing) {
    const waiting = unresolvedSlotRefusal(resolved);
    if (waiting) return fail(waiting);
  }

  const current = await tx
    .select()
    .from(matchGames)
    .where(eq(matchGames.matchId, matchId))
    .orderBy(asc(matchGames.index));
  const byIndex = new Map(current.map((row) => [row.index, row]));

  // Pass one: decide. `staged` is what the rows would become, and not one of
  // them has been written yet.
  const staged: Array<{ id: string; values: Omit<MatchGameRow, "id" | "matchId" | "index"> }> = [];
  for (const patch of patches) {
    const row = byIndex.get(patch.index);
    if (!row) return fail(`This series has no game ${patch.index + 1}.`);
    const refusal =
      scoreRefusal(patch.scoreA, patch.index + 1) ?? scoreRefusal(patch.scoreB, patch.index + 1);
    if (refusal) return fail(refusal);

    const values = {
      // Through the same normaliser `config.modeSequence` is read with, so
      // the mode a manager records and the mode the stage planned are the
      // same string when they are the same mode (R-153 / UC-19 E1).
      mode: patch.mode === undefined ? row.mode : normaliseModeName(patch.mode),
      map: patch.map === undefined ? row.map : cleanText(patch.map, 60),
      referee: patch.referee === undefined ? row.referee : cleanText(patch.referee, NAME_MAX),
      scoreA: readScore(patch.scoreA, row.scoreA),
      scoreB: readScore(patch.scoreB, row.scoreB),
      played: patch.played === undefined ? row.played : patch.played === true,
      sideChosen:
        patch.sideChosen === undefined ? row.sideChosen : normalisePlaySide(patch.sideChosen),
    };
    staged.push({ id: row.id, values });
    byIndex.set(patch.index, { ...row, ...values });
  }

  const finalGames = [...byIndex.values()].sort((x, y) => x.index - y.index);
  const shape = seriesRefusal({
    bestOf: match.bestOf,
    elimination: resolved.elimination,
    games: finalGames,
  });
  if (shape) return fail(shape);

  // Pass two: write.
  for (const row of staged) {
    await tx.update(matchGames).set(row.values).where(eq(matchGames.id, row.id));
  }

  const durationWasGiven = options.durationMin !== undefined;
  const state = {
    slot: match.slot,
    scheduledAt: iso(match.scheduledAt),
    finishedAt: iso(match.finishedAt),
    durationMin: durationWasGiven ? (options.durationMin ?? null) : match.durationMin,
    bestOf: match.bestOf,
    winnerOverrideId: match.winnerOverrideId,
    games: finalGames.map((g) => ({ played: g.played, scoreA: g.scoreA, scoreB: g.scoreB })),
  };
  syncFinish(state, durationWasGiven, options.now);

  await tx
    .update(matches)
    .set({
      finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
      durationMin: state.durationMin,
    })
    .where(eq(matches.id, matchId));

  // Before the re-flow, so a round that has just been paired is laid out with
  // the rest of its day rather than sitting at no time until the next write.
  await advanceSwiss(tx, match.eventId);
  await reflow(tx, match.eventId);

  return withData({
    finishedAt: state.finishedAt,
    durationMin: state.durationMin,
    flagged: flagsBetween(
      snapshotOf(boardBefore),
      snapshotOf(await formatFor(match.eventId, tx)),
      match.slot
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Swiss, round by round                                              */
/* ------------------------------------------------------------------ */

/**
 * **Pair the next Swiss round, once the round before it is complete** (R-71 /
 * UC-18 swiss).
 *
 * A Swiss cannot be generated up front. Round 1 is the seeding — top half
 * against bottom half — and every round after it pairs the table as it stands,
 * so it exists only once the round before it is in. That makes this the one
 * part of the format engine that grows while the event is being played, and it
 * is called from the two writes that can complete a round: recording games, and
 * an override settling a drawn one.
 *
 * ## The pairing is written down, not re-derived
 *
 * `config.swissRounds` keeps the seed pairs of each round as it is made. The
 * alternative — pairing from the table on every read — would silently re-pair a
 * round that has already been played the moment somebody corrects an earlier
 * score, which is the one thing a stored result must never do to a board. It is
 * the same argument as `matches.first_side_choice`: a decision taken in front
 * of a room is a fact, not a function.
 *
 * ## Nothing here decides a result
 *
 * Which matches are over is `status === "done"`, straight off the resolver —
 * so a void match counts as settled and a drawn *table* game counts as played,
 * while a drawn decider waits for the manager. Re-deriving any of that here is
 * how a Swiss comes to pair a round the board says is still live.
 */
async function advanceSwiss(database: Database, eventId: string): Promise<number> {
  const stageRows = await readStageRows(database, eventId);
  const swiss = stageRows.filter((row) => row.kind === "swiss");
  if (swiss.length === 0) return 0;

  const view = await formatFor(eventId, database);
  if (!view) return 0;

  const teamRows = await readTeams(database, eventId);
  const seeded = seedOrderOf(teamRows);
  let added = 0;

  for (const stage of swiss) {
    const resolved = view.stages.find((entry) => entry.id === stage.id);
    if (!resolved) continue;

    const config = normaliseStageConfig("swiss", stage.config as Partial<StageConfig>);
    const rounds = [...new Set(resolved.spec.matches.map((match) => match.round))];
    const last = rounds.length ? Math.max(...rounds) : 0;
    if (last < 1 || last >= config.rounds) continue;

    // Every round so far, not only the last: the table the next round is paired
    // from counts all of them, so one unfinished match anywhere means the order
    // is still moving.
    const stored = await readMatchRows(database, [stage.id]);
    if (stored.length === 0) continue;
    const bySlot = new Set(stored.map((row) => row.slot));
    const onBoard = resolved.matches.filter((match) => bySlot.has(match.slot));
    if (onBoard.length === 0) continue;
    if (!onBoard.every((match) => match.status === "done" || match.status === "void")) continue;

    const seedOf = new Map<string, number>();
    resolved.seeds.forEach((teamId, index) => {
      if (teamId) seedOf.set(teamId, index + 1);
    });

    const order = resolved.standings
      .map((row) => seedOf.get(row.id))
      .filter((seed): seed is number => seed !== undefined);
    if (order.length < 2) continue;

    const played = onBoard
      .map((match) => [seedOf.get(match.teamAId ?? ""), seedOf.get(match.teamBId ?? "")])
      .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);

    const { pairs } = swissNextRound(order, played);
    if (pairs.length === 0) continue;

    const next: StageConfig = {
      ...config,
      swissRounds: { ...config.swissRounds, [String(last + 1)]: pairs },
    };
    await database
      .update(stages)
      .set({ config: next as unknown as StageConfigJson })
      .where(eq(stages.id, stage.id));

    // Generated from the updated config rather than from `pairs` directly, so
    // the new round's series length, mode sequence and coin come from the same
    // one place every other match in the stage got them from.
    const spec = generateStage("swiss", teamRows.length, next);
    const fresh = spec.matches.filter((match) => !bySlot.has(match.slot));
    await insertGenerated(database, stage, fresh, seeded);
    added += fresh.length;
  }

  return added;
}

/**
 * Break a drawn series, or overturn one.
 *
 * The override has to name one of the two teams actually in the match, which
 * means resolving the slot first — a bracket slot's teams are not in its row.
 *
 * It reports the same dependent flags `recordGames` does (UC-19 3a), because it
 * is the write that settles a drawn knockout series: the slot above it goes
 * from "waiting on upper semi 1" to a named team on this one decision, and if
 * that slot already has maps against it they were played by somebody else.
 *
 * ## Every deciding read is taken after the lock
 *
 * The first select below asks one question — which event is this — because the
 * lock has to be named before it can be taken. Everything the function decides
 * on comes from the re-read underneath it, `recordGames` and `reflipMatch`
 * being the same shape. The row's **existence** is one of those decisions: a
 * regeneration committing while this transaction waited for the lock deletes
 * and re-inserts every match of its stage, and an existence check taken before
 * the wait left the `update` below hitting no rows at all and this function
 * answering `ok` with no flags — a decision reported as recorded against a row
 * that is not there.
 */
export async function setWinnerOverride(
  matchId: string,
  teamId: string | null,
  database: Database = defaultDb
): Promise<FormatResult<{ flagged: DependentFlag[] }>> {
  return database.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: matches.id, eventId: matches.eventId })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!found) return fail("That match no longer exists.");

    const event = await lockEvent(tx, found.eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    return overrideIn(tx, matchId, teamId);
  });
}

/**
 * `setWinnerOverride`'s own work, with the event already locked and its
 * refusal already made.
 *
 * Split out for {@link clearMatch}, which has to do this **and**
 * `recordGames`' work inside one transaction holding one lock. Taking the
 * lock and making the refusal stay the caller's job rather than moving in
 * here: a second `lockEvent` on a lock the transaction already holds proves
 * nothing, and the one caller that composes the two halves has to make that
 * refusal once, for both of them, before either writes anything.
 *
 * Not exported. A caller that reached it without the lock would be exactly the
 * bug the split is here to avoid.
 */
async function overrideIn(
  tx: Database,
  matchId: string,
  teamId: string | null
): Promise<FormatResult<{ flagged: DependentFlag[] }>> {
  // Re-read under the lock. `slot` decides which card is resolved, which
  // flags are reported and which one is excluded from them, and the row being
  // here at all decides whether there is anything to override.
  const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!match) return fail("That match no longer exists.");

  const boardBefore = await formatFor(match.eventId, tx);
  if (teamId) {
    const resolved = boardBefore?.stages
      .flatMap((stage) => stage.matches)
      .find((m) => m.slot === match.slot);
    if (!resolved) return fail("That match is not part of the current format.");
    if (teamId !== resolved.teamAId && teamId !== resolved.teamBId) {
      return fail("That team is not in this match.");
    }
  }

  await tx.update(matches).set({ winnerOverrideId: teamId }).where(eq(matches.id, matchId));
  // An override is a result like any other, so it is also one of the two
  // writes that can complete a Swiss round (UC-18 swiss).
  await advanceSwiss(tx, match.eventId);
  await reflow(tx, match.eventId);
  return withData({
    flagged: flagsBetween(
      snapshotOf(boardBefore),
      snapshotOf(await formatFor(match.eventId, tx)),
      match.slot
    ),
  });
}

/**
 * Re-flip a match's coin — or set it outright.
 *
 * §8.4's rule is that one team chooses the side and the other chooses the map,
 * swapping every game, and a coin decides who starts with the side. Coins get
 * tossed in front of a room, and rooms get it wrong: the toss is called before
 * the caller is ready, or the result is read out backwards and six people write
 * down the opposite of what happened. So the assignment has to be correctable.
 *
 * Passing a slot **sets** it, which is the honest tool for that case — an admin
 * who watched the coin land knows the answer and does not want another 50/50.
 * Passing nothing tosses again, which is what a toss nobody witnessed needs.
 *
 * ## Two refusals
 *
 *  - **A finished event.** Not because a coin is a result, but because a coin
 *    is what a result was played *under*: changing it rewrites the record of
 *    which team was entitled to pick the map of a game that has been played.
 *    `./archive-policy` is how that refusal is expressed everywhere else.
 *  - **A series that has started.** The same argument at match scale, and the
 *    stricter of the two: once a single game is ticked off, the whole series
 *    was played under this coin, and re-flipping it would silently re-attribute
 *    every game of it. The way out is the way out of every other recorded
 *    mistake — clear the series, then flip.
 *
 * There is no re-flow afterwards. A coin moves nobody's start time.
 *
 * ## Every deciding read is taken after the lock
 *
 * The same rule {@link setWinnerOverride} and {@link setMatchSchedule} follow,
 * and this function needs it for the one decision it makes that is not about a
 * game: **whether the row is there at all**. The first select asks one
 * question — which event is this — because the lock has to be named before it
 * can be taken; everything else comes from the reads underneath it.
 *
 * Taken before the wait, that existence check is a snapshot from before this
 * transaction queued for the lock, and UC-18 9's regeneration is what makes it
 * stale: rebuilding a stage deletes and re-inserts every match in it, so a
 * regeneration committing in that gap left the `update` below matching no rows
 * at all while this function still answered `ok` with a coin it had not
 * written. The archive refusal and the played check were always made under the
 * lock; this one was not.
 */
export async function reflipMatch(
  matchId: string,
  slot: MatchSlot | null = null,
  database: Database = defaultDb
): Promise<FormatResult<{ firstSideChoice: MatchSlot }>> {
  if (slot !== null && !isMatchSlot(slot)) {
    return fail("The side choice belongs to one of the two teams, or to neither.");
  }

  return database.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: matches.id, eventId: matches.eventId })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!found) return fail("That match no longer exists.");

    const event = await lockEvent(tx, found.eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    // Re-read under the lock. The id is all this function decides on — it
    // writes the coin rather than deriving it — so the id is all this asks
    // for; what matters is *when* it is asked.
    const [match] = await tx
      .select({ id: matches.id })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!match) return fail("That match no longer exists.");

    const played = await tx
      .select({ id: matchGames.id })
      .from(matchGames)
      .where(and(eq(matchGames.matchId, matchId), eq(matchGames.played, true)))
      .limit(1);
    if (played.length > 0) {
      return fail(
        "A game of this series has already been played, so its coin cannot be re-flipped — that would change who was entitled to pick a map that is already on the board. Clear the series first if it really was recorded wrongly."
      );
    }

    const next = slot ?? tossForFirstSideChoice();
    await tx.update(matches).set({ firstSideChoice: next }).where(eq(matches.id, matchId));
    return withData({ firstSideChoice: next });
  });
}

/**
 * A `clearMatch` refusal raised after the override has already been dropped.
 *
 * Thrown rather than returned, because a refusal returned from a transaction
 * callback commits what came before it - see `clearMatch`'s docblock. Private
 * to this module and caught by the one function that throws it, so it never
 * reaches a caller as an exception.
 */
class HalfCleared extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "HalfCleared";
  }
}

/**
 * Wipe one series back to an unplayed card.
 *
 * The old board's "Clear", carried over: it is the only way back from a score
 * typed against the wrong match. Doing it as a patch — every game unticked and
 * zeroed, the override dropped, the duration cleared — means it goes through
 * exactly the same validation and the same re-flow as recording one.
 *
 * It lives here rather than being composed in the action file, which is where
 * it used to be. Composing it there put the single most destructive operation
 * on the site outside every rule this module enforces: it reached the same two
 * writes without ever asking whether the event was finished, so a fully played
 * Bo5 on a completed tournament could be erased by an admin who meant to clear
 * the card below it. The refusal has to be attached to the *operation*, and the
 * operation therefore has to be a function.
 *

 * ## One transaction, and one lock across both halves (R-39 / UC-09 6b)
 *
 * It used to be two transactions - `setWinnerOverride` then `recordGames`,
 * each taking the lock and making the refusal again on the way past. Two
 * transactions is two chances to be interrupted, and the window between them
 * was the one that mattered: an admin marking the event finished in it left the
 * override **dropped and committed** while the games refused, so the most
 * destructive operation on the site was also the one that could stop half way
 * and report that it had done nothing. Both halves now run inside one
 * transaction holding one `lockEvent`, and the refusal is made once for both -
 * {@link overrideIn} and {@link recordGamesIn} are those halves with the lock
 * and the refusal lifted out of them.
 *
 * ## Which makes this the one place in this module that rolls back
 *
 * Nothing here calls `tx.rollback()`, and a refusal returned from inside a
 * transaction callback **commits** - which is why `recordGamesIn` decides
 * everything before it writes anything. That is not enough on its own here:
 * the override is dropped first, so a refusal from `recordGamesIn` afterwards
 * (a `gameCount` past the end of the series, a slot that has left the format)
 * would be a refusal returned over a committed half-clear. Those are therefore
 * thrown, which is what rolls the transaction back, and turned back into the
 * same sentence out here. `overrideIn` needs no such thing: every one of its
 * refusals is decided before it writes.
 *
 * ## Its dependent flags are measured around the whole operation
 *
 * The override is dropped first, and that is itself what unresolves everything
 * downstream - so neither half can see the board as it stood before the clear
 * began, and the snapshot is taken once, here, under the lock and before
 * either of them runs. The diff is a report rather than a decision: nothing is
 * refused on the strength of it (UC-19 3a).
 */
export async function clearMatch(
  matchId: string,
  gameCount: number,
  database: Database = defaultDb
): Promise<FormatResult<{ flagged: DependentFlag[] }>> {
  try {
    return await database.transaction(async (tx) => {
      const [found] = await tx
        .select({ id: matches.id, eventId: matches.eventId })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!found) return fail("That match no longer exists.");

      const event = await lockEvent(tx, found.eventId);
      if (!event) return fail("That event no longer exists.");

      const locked = lockRefusal(event);
      if (locked) return fail(locked);

      // Re-read under the lock, as both halves do: `slot` is what the flags
      // below are measured against, and the row being here at all decides
      // whether there is a series to clear.
      const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
      if (!match) return fail("That match no longer exists.");

      const before = snapshotOf(await formatFor(match.eventId, tx));

      const cleared = await overrideIn(tx, matchId, null);
      if (!cleared.ok) return cleared;

      const recorded = await recordGamesIn(
        tx,
        matchId,
        Array.from({ length: Math.max(0, gameCount) }, (_, index) => ({
          index,
          map: "",
          referee: "",
          scoreA: 0,
          scoreB: 0,
          played: false,
        })),
        { durationMin: null }
      );
      if (!recorded.ok) throw new HalfCleared(recorded.error);

      return withData({
        flagged: flagsBetween(
          before,
          snapshotOf(await formatFor(match.eventId, tx)),
          match.slot
        ),
      });
    });
  } catch (error) {
    if (error instanceof HalfCleared) return fail(error.refusal);
    throw error;
  }
}

/**
 * Move one match, then re-flow the rest of its day.
 *
 * `applySchedule` below lays a whole event out from a start time per day, which
 * is the setting §10 describes and the one the schedule screen offers. This is
 * the other half of the same job and the one the *results* screen needs: a
 * match that actually kicked off twenty minutes late is a fact about that
 * match, not a new plan for the day, and recording it is how the day's anchor
 * moves without re-running an auto-fill over results that already exist.
 *
 * The re-flow afterwards is not optional. `durationMin` is derived from the gap
 * between the start and the finish, and every later block that day hangs off
 * when this one ends — so changing a start and leaving the rest alone would
 * leave the board internally inconsistent, which is exactly what `recordGames`
 * goes to the trouble of preventing.
 *
 * ## It marks the stage hand-edited, and that is the point of the column
 *
 * R-157 / UC-19 E2: a moved start time marks its stage hand-edited, so it is
 * never regenerated automatically. Only *this* function marks it — the auto
 * fill and the re-flow write the same column on the same rows and are not hand
 * edits, which is exactly why "has a person moved anything here" cannot be read
 * back off `scheduled_at` afterwards and has to be recorded as it happens.
 *
 * The re-flow below moves later matches of the same day, and those shifts are
 * consequences rather than edits: one manager moving one match does not mark
 * three stages.
 *
 * ## A start that has not moved is not a hand edit either
 *
 * The caller is a form, and a form posts every field it holds whether or not
 * anybody touched it: `recordGamesAction` calls this whenever `scheduledAt` is
 * *present*, and the Results tab's card always holds the match's own start. So
 * recording a scoreline — or opening a card that has no start time at all and
 * pressing Save — marked the stage hand-edited, for ever, having moved nothing.
 *
 * That is not a cosmetic lie. `stageTouchOf` reads the mark, so the stage stops
 * being rebuilt automatically when the teams change (UC-18 9); `StageClearing`
 * reads it, so the rebuild dialog claims "start times in this stage were moved
 * by hand"; and `MatchesState` reads it, so the Format tab blames hand-moved
 * times for an out-of-date stage nobody has touched. R-157's mark belongs to a
 * *move*, so an instruction that lands on the instant already stored returns
 * the stored one and writes nothing — including no re-flow, since nothing moved
 * for the rest of the day to follow.
 *
 * ## Which is why the comparison is read after the lock
 *
 * The lock-ordering rule `recordGames` and `setWinnerOverride` follow, and this
 * function needs it for the same reason they do — see `setWinnerOverride`'s
 * docblock. The first select asks one question, which event is this, because the
 * lock has to be named before it can be taken; `scheduled_at` comes from the
 * re-read underneath it.
 *
 * Taken before the wait, that instant is stale by the time it is compared, and
 * `reflow` is what makes it stale: it rewrites `scheduled_at` for every later
 * match of the day, and `recordGamesAction` posts `scheduledAt` on every
 * scoreline, so a card read before queueing for the lock is comparing the
 * manager's value against a pre-reflow instant. Two ways that goes wrong, and
 * both are the early return above firing on a move that was really asked for:
 * it writes nothing, and it answers with the stale instant — breaking the
 * promise below that the screen shows where the match actually ended up.
 */
export async function setMatchSchedule(
  matchId: string,
  scheduledAt: string | null,
  database: Database = defaultDb
): Promise<FormatResult<{ scheduledAt: string | null }>> {
  return database.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: matches.id, eventId: matches.eventId })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!found) return fail("That match no longer exists.");

    const event = await lockEvent(tx, found.eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    // Re-read under the lock. `scheduled_at` decides whether this is a move at
    // all, `stage_id` decides which stage is marked hand-edited, and the row
    // being here at all decides whether there is anything to move.
    const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!match) return fail("That match no longer exists.");

    let at: Date | null = null;
    if (scheduledAt) {
      at = new Date(scheduledAt);
      if (Number.isNaN(at.getTime())) return fail("That start time is not a time.");
    }

    // Compared as instants rather than as the strings or the `Date` objects:
    // the browser sends an ISO stamp and the column comes back as a `Date`, so
    // `===` on either would call every unchanged start a move.
    if (iso(at) === iso(match.scheduledAt)) {
      return withData({ scheduledAt: iso(match.scheduledAt) });
    }

    await tx.update(matches).set({ scheduledAt: at }).where(eq(matches.id, matchId));
    await tx
      .update(stages)
      .set({ handEditedAt: new Date() })
      .where(eq(stages.id, match.stageId));
    await reflow(tx, match.eventId);

    // Read back rather than echo: the re-flow may well have moved it again, and
    // the screen should show where the match actually ended up.
    const [after] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    return withData({ scheduledAt: iso(after?.scheduledAt ?? null) });
  });
}

/* ------------------------------------------------------------------ */
/* The schedule                                                       */
/* ------------------------------------------------------------------ */

/**
 * Lay the running order out from a start time per day (§10).
 *
 * A day left blank is skipped rather than guessed at, and a match that has
 * already been played keeps the slot it actually ran in.
 */
export async function applySchedule(
  eventId: string,
  dayStarts: Array<string | null>,
  database: Database = defaultDb
): Promise<FormatResult<{ scheduled: number }>> {
  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const plan = await schedulablePlan(tx, event);
    if (!plan) return fail("Generate the matches before scheduling them.");

    autoSchedule(plan.state, plan.blocks, dayStarts, plan.settings.timing);
    await writeSchedule(tx, plan.rows, plan.state);
    return withData({ scheduled: plan.state.filter((m) => m.scheduledAt).length });
  });
}

/** Re-flow every day from what has actually happened, without moving the anchors. */
async function reflow(database: Database, eventId: string): Promise<void> {
  const event = await readEvent(database, eventId);
  if (!event) return;
  const plan = await schedulablePlan(database, event);
  if (!plan) return;
  recalculateSchedule(plan.state, plan.blocks, { timing: plan.settings.timing });
  await writeSchedule(database, plan.rows, plan.state);
}

type SchedulablePlan = {
  rows: MatchRow[];
  state: Array<{ slot: string; scheduledAt: string | null; finishedAt: string | null; durationMin: number | null }>;
  blocks: PlannedBlock[];
  settings: ScheduleSettings;
};

async function schedulablePlan(
  database: Database,
  event: EventRow
): Promise<SchedulablePlan | null> {
  const [teamRows, stageRows] = await Promise.all([
    readTeams(database, event.id),
    readStageRows(database, event.id),
  ]);
  if (stageRows.length === 0) return null;

  const rows = await readMatchRows(
    database,
    stageRows.map((s) => s.id)
  );
  if (rows.length === 0) return null;

  const settings = scheduleSettingsFrom(event.config);
  const specs = stageRows.map((row) =>
    generateStage(kindOf(row), teamRows.length, row.config as Partial<StageConfig>)
  );

  return {
    rows,
    state: rows.map((row) => ({
      slot: row.slot,
      scheduledAt: iso(row.scheduledAt),
      finishedAt: iso(row.finishedAt),
      durationMin: row.durationMin,
    })),
    blocks: planBlocks(specs, scheduleOptionsFrom(settings)),
    settings,
  };
}

/** Write back only the rows whose start actually moved. */
async function writeSchedule(
  database: Database,
  rows: MatchRow[],
  state: SchedulablePlan["state"]
): Promise<void> {
  const bySlot = new Map(state.map((m) => [m.slot, m]));
  for (const row of rows) {
    const next = bySlot.get(row.slot);
    if (!next) continue;
    const before = iso(row.scheduledAt);
    if (before === next.scheduledAt) continue;
    await database
      .update(matches)
      .set({ scheduledAt: next.scheduledAt ? new Date(next.scheduledAt) : null })
      .where(eq(matches.id, row.id));
  }
}

/* ------------------------------------------------------------------ */
/* Re-exports the pages will want                                     */
/* ------------------------------------------------------------------ */

export type {
  GameChoice,
  MatchBracket,
  MatchGameRecord,
  PlannedBlock,
  ResolvedMatch,
  Standing,
  TeamRef,
};
export type { MatchSlot, PlaySide };
