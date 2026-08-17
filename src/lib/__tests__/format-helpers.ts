import type { GeneratedStage } from "@/lib/bracket";
import { MAX_TEAMS, MIN_TEAMS, parseSource, seriesTarget } from "@/lib/format-policy";
import {
  type MatchRecord,
  type ResolvedMatch,
  type TeamRef,
  StageResolution,
  blankGamesFor,
} from "@/lib/format-resolve";

/** Team ids `t1`…`tN`, seeded in order, so "t1 beats t2" reads as "the better seed". */
export function makeTeams(count: number): TeamRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Team ${i + 1}`,
    seed: i + 1,
  }));
}

/** Every generated match as an untouched stored row. */
export function blankRecords(stage: GeneratedStage): MatchRecord[] {
  return stage.matches.map((match) => ({
    slot: match.slot,
    bestOf: match.bestOf,
    teamAId: null,
    teamBId: null,
    sourceA: match.sourceA,
    sourceB: match.sourceB,
    scheduledAt: null,
    finishedAt: null,
    durationMin: null,
    winnerOverrideId: null,
    games: blankGamesFor(match),
  }));
}

/** Win a series for one side by taking the minimum number of games. */
export function winSeries(record: MatchRecord, side: "a" | "b"): void {
  const target = seriesTarget(record.bestOf);
  record.games.forEach((game, i) => {
    if (i >= target) return;
    game.scoreA = side === "a" ? 1 : 0;
    game.scoreB = side === "b" ? 1 : 0;
    game.played = true;
  });
}

/** Draw every game of a series, which is how a bracket slot stalls. */
export function drawSeries(record: MatchRecord): void {
  for (const game of record.games) {
    game.scoreA = 1;
    game.scoreB = 1;
    game.played = true;
  }
}

export type PlayOptions = {
  teams?: TeamRef[];
  seeds?: Array<string | null> | null;
  /** Which side wins. The default is the better seed, so results are deterministic. */
  pick?: (a: string, b: string, slot: string) => string;
};

export type PlayedStage = {
  records: MatchRecord[];
  matches: ResolvedMatch[];
  resolution: StageResolution;
  teams: TeamRef[];
};

/**
 * Play a whole stage through, one resolvable match at a time.
 *
 * Nothing here knows the shape of the bracket: it repeatedly asks the resolver
 * which matches now have two teams and are not finished, plays those, and goes
 * round again. If the generated sources are wrong the loop simply stops early
 * and the assertions catch it, which is exactly what the property tests want.
 */
export function playStage(stage: GeneratedStage, options: PlayOptions = {}): PlayedStage {
  const teams = options.teams ?? makeTeams(stage.teamCount);
  const rank = new Map(teams.map((team, i) => [team.id, i]));
  const pick =
    options.pick ??
    ((a: string, b: string) => ((rank.get(a) ?? 0) <= (rank.get(b) ?? 0) ? a : b));

  const records = blankRecords(stage);
  const seeds = options.seeds === undefined ? teams.map((t) => t.id) : options.seeds;
  let resolution = new StageResolution({ stage, matches: records, teams, seeds });

  for (let pass = 0; pass < 200; pass += 1) {
    resolution = new StageResolution({ stage, matches: records, teams, seeds });
    let progressed = false;
    for (const match of resolution.matches()) {
      if (match.status === "done" || match.status === "void") continue;
      if (!match.teamAId || !match.teamBId) continue;
      const record = records.find((r) => r.slot === match.slot);
      if (!record) continue;
      const winner = pick(match.teamAId, match.teamBId, match.slot);
      winSeries(record, winner === match.teamAId ? "a" : "b");
      progressed = true;
    }
    if (!progressed) break;
  }

  resolution = new StageResolution({ stage, matches: records, teams, seeds });
  return { records, matches: resolution.matches(), resolution, teams };
}

/** Every team count the platform supports. */
export const TEAM_COUNTS = Array.from(
  { length: MAX_TEAMS - MIN_TEAMS + 1 },
  (_, i) => MIN_TEAMS + i
);

/** The seeds a stage's matches draw on directly. */
export function seedSources(stage: GeneratedStage): number[] {
  const out: number[] = [];
  for (const match of stage.matches) {
    for (const raw of [match.sourceA, match.sourceB]) {
      const ref = parseSource(raw);
      if (ref?.kind === "seed") out.push(ref.seed);
    }
  }
  return out;
}
