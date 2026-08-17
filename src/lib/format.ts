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
 * ## What is deliberately not stored
 *
 * Labels, stakes notes, phases, placements and the whole schedule plan. All of
 * them are functions of `(kind, teamCount, config)`, which is stored, so a
 * column for any of them would be a second copy that can disagree — the same
 * argument that keeps `balance_left` off `teams` and `applications_open` off
 * `events`.
 */

import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  type Database,
  type EventRow,
  type MatchGameRow,
  type MatchRow,
  type Stage,
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
} from "./bracket";
import type { EventResult } from "./events";
import {
  type FormatTiming,
  type StageConfig,
  type StageKind,
  MAX_DAYS,
  MAX_TEAMS,
  isStageKind,
  normaliseFormatTiming,
  normaliseStageConfig,
} from "./format-policy";
import {
  type MatchGameRecord,
  type MatchRecord,
  type ResolvedMatch,
  type Standing,
  StageResolution,
  type TeamRef,
  blankGamesFor,
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

    const existing = await readStageRows(tx, eventId);
    const keep = new Set(input.map((s) => s.id).filter((id): id is string => Boolean(id)));
    const removed = existing.filter((row) => !keep.has(row.id));

    for (const row of removed) {
      if (await stageHasResults(tx, row.id)) {
        return fail(`"${row.name ?? row.kind}" has results recorded, so it cannot be removed.`);
      }
    }
    if (removed.length) {
      await tx.delete(stages).where(
        inArray(
          stages.id,
          removed.map((r) => r.id)
        )
      );
    }

    const byId = new Map(existing.map((row) => [row.id, row]));
    const out: Stage[] = [];

    for (const [sort, stage] of input.entries()) {
      const kind = stage.kind as StageKind;
      const config = normaliseStageConfig(kind, stage.config ?? null);
      const name = cleanText(stage.name, NAME_MAX) || defaultStageName(kind);
      const current = stage.id ? byId.get(stage.id) : undefined;

      if (stage.id && !current) return fail("One of those stages no longer exists.");

      if (current) {
        // Changing the shape of a stage that has been played is not an edit.
        if (kind !== current.kind && (await stageHasResults(tx, current.id))) {
          return fail(`"${current.name ?? current.kind}" has results recorded, so its format cannot change.`);
        }
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

    if (await stageHasResults(tx, stageId)) {
      return fail("This stage already has results, so it cannot be regenerated.");
    }

    const teamRows = await readTeams(tx, stage.eventId);
    if (teamRows.length < 2) return fail("Add at least two teams before generating a bracket.");
    if (teamRows.length > MAX_TEAMS) return fail(`An event can have at most ${MAX_TEAMS} teams.`);

    const kind = kindOf(stage);
    const spec = generateStage(kind, teamRows.length, stage.config as Partial<StageConfig>);
    const seeded = seedOrderOf(teamRows);

    await tx.delete(matches).where(eq(matches.stageId, stageId));

    for (const match of spec.matches) {
      // A table game's pairing is known from the start; a bracket slot's is not,
      // and writing a guess into it would defeat the whole resolve-on-read idea.
      const direct = match.bracket === "rr";
      const [row] = await tx
        .insert(matches)
        .values({
          stageId,
          eventId: stage.eventId,
          slot: match.slot,
          round: match.round,
          phase: match.phase,
          bestOf: match.bestOf,
          teamAId: direct ? teamFromSource(match.sourceA, seeded) : null,
          teamBId: direct ? teamFromSource(match.sourceB, seeded) : null,
          sourceA: match.sourceA,
          sourceB: match.sourceB,
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
          }))
        );
      }
    }

    return withData({ created: spec.matches.length });
  });
}

/** The teams in seed order — the `seed` column when it is set, else the sort order. */
function seedOrderOf(rows: Team[]): string[] {
  const seeded = rows.filter((row) => typeof row.seed === "number");
  if (seeded.length === rows.length && rows.length > 0) {
    return [...rows].sort((x, y) => (x.seed as number) - (y.seed as number)).map((r) => r.id);
  }
  return rows.map((r) => r.id);
}

function teamFromSource(source: string, seeded: string[]): string | null {
  const match = /^seed:([1-9][0-9]*)$/.exec(source);
  return match ? (seeded[Number(match[1]) - 1] ?? null) : null;
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
};

function score(value: unknown, current: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 999 ? parsed : current;
}

/**
 * Record part of a series, then keep the finish, the duration and the rest of
 * the day in step.
 *
 * The three follow from each other and cannot be left to the caller: ticking
 * off the deciding game finishes the match, which fixes its duration, which
 * moves every later block of that day (§10). Doing them in one transaction is
 * what stops a page ever showing a finished match inside a block that has not
 * ended.
 */
export async function recordGames(
  matchId: string,
  patches: GamePatch[],
  options: { durationMin?: number | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<FormatResult<{ finishedAt: string | null; durationMin: number | null }>> {
  return database.transaction(async (tx) => {
    const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!match) return fail("That match no longer exists.");

    const event = await lockEvent(tx, match.eventId);
    if (!event) return fail("That event no longer exists.");

    const current = await tx
      .select()
      .from(matchGames)
      .where(eq(matchGames.matchId, matchId))
      .orderBy(asc(matchGames.index));
    const byIndex = new Map(current.map((row) => [row.index, row]));

    for (const patch of patches) {
      const row = byIndex.get(patch.index);
      if (!row) return fail(`This series has no game ${patch.index + 1}.`);
      const next = {
        mode: patch.mode === undefined ? row.mode : cleanText(patch.mode, 40),
        map: patch.map === undefined ? row.map : cleanText(patch.map, 60),
        referee: patch.referee === undefined ? row.referee : cleanText(patch.referee, NAME_MAX),
        scoreA: score(patch.scoreA, row.scoreA),
        scoreB: score(patch.scoreB, row.scoreB),
        played: patch.played === undefined ? row.played : patch.played === true,
      };
      await tx.update(matchGames).set(next).where(eq(matchGames.id, row.id));
      byIndex.set(patch.index, { ...row, ...next });
    }

    const durationWasGiven = options.durationMin !== undefined;
    const state = {
      slot: match.slot,
      scheduledAt: iso(match.scheduledAt),
      finishedAt: iso(match.finishedAt),
      durationMin: durationWasGiven ? (options.durationMin ?? null) : match.durationMin,
      bestOf: match.bestOf,
      winnerOverrideId: match.winnerOverrideId,
      games: [...byIndex.values()]
        .sort((x, y) => x.index - y.index)
        .map((g) => ({ played: g.played, scoreA: g.scoreA, scoreB: g.scoreB })),
    };
    syncFinish(state, durationWasGiven, options.now);

    await tx
      .update(matches)
      .set({
        finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
        durationMin: state.durationMin,
      })
      .where(eq(matches.id, matchId));

    await reflow(tx, match.eventId);

    return withData({ finishedAt: state.finishedAt, durationMin: state.durationMin });
  });
}

/**
 * Break a drawn series, or overturn one.
 *
 * The override has to name one of the two teams actually in the match, which
 * means resolving the slot first — a bracket slot's teams are not in its row.
 */
export async function setWinnerOverride(
  matchId: string,
  teamId: string | null,
  database: Database = defaultDb
): Promise<FormatResult> {
  return database.transaction(async (tx) => {
    const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!match) return fail("That match no longer exists.");

    const event = await lockEvent(tx, match.eventId);
    if (!event) return fail("That event no longer exists.");

    if (teamId) {
      const view = await formatFor(match.eventId, tx);
      const resolved = view?.stages
        .flatMap((stage) => stage.matches)
        .find((m) => m.slot === match.slot);
      if (!resolved) return fail("That match is not part of the current format.");
      if (teamId !== resolved.teamAId && teamId !== resolved.teamBId) {
        return fail("That team is not in this match.");
      }
    }

    await tx.update(matches).set({ winnerOverrideId: teamId }).where(eq(matches.id, matchId));
    await reflow(tx, match.eventId);
    return withData(null);
  });
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
 */
export async function setMatchSchedule(
  matchId: string,
  scheduledAt: string | null,
  database: Database = defaultDb
): Promise<FormatResult<{ scheduledAt: string | null }>> {
  return database.transaction(async (tx) => {
    const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!match) return fail("That match no longer exists.");

    const event = await lockEvent(tx, match.eventId);
    if (!event) return fail("That event no longer exists.");

    let at: Date | null = null;
    if (scheduledAt) {
      at = new Date(scheduledAt);
      if (Number.isNaN(at.getTime())) return fail("That start time is not a time.");
    }

    await tx.update(matches).set({ scheduledAt: at }).where(eq(matches.id, matchId));
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

export type { MatchBracket, MatchGameRecord, PlannedBlock, ResolvedMatch, Standing, TeamRef };
