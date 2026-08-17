/**
 * Results, resolved on read (docs/platform-plan.md §1.1, §8.5).
 *
 * The generalised form of what the current board already does: a slot's teams
 * are *derived* from earlier results every time they are asked for, never
 * written down. Correcting a score three days later re-propagates the whole
 * bracket, because there is nothing downstream to be stale.
 *
 * What changes from `./tournament` is only where the wiring comes from. The old
 * module carries a six-entry table of hardcoded sources and a `settle` call per
 * slot; here the sources are generated (`./bracket`) and this module walks them,
 * so the identical logic covers 2 to 8 teams, four formats and any bracket shape
 * without gaining a branch.
 *
 * Three behaviours are carried over deliberately, because they are right:
 *
 *  1. **Placeholders.** An unresolved slot shows where it is waiting on —
 *     "Upper semi 1 loser", "Seed 4", "Group A #2" — rather than "TBD".
 *  2. **A drawn series stalls.** A drawn table game is a finished match worth a
 *     point each; a drawn elimination series is not finished at all, because
 *     somebody has to advance. It waits on the admin's override and nothing
 *     downstream of it resolves in the meantime.
 *  3. **The override is checked against the match.** Naming a team that is not
 *     in the match is ignored rather than obeyed.
 */

import type { GeneratedMatch, GeneratedStage, MatchBracket, PlacementRule } from "./bracket";
import {
  type PointsRule,
  type StageConfig,
  type Tiebreaker,
  modesFor,
  parseSource,
  seriesTarget,
} from "./format-policy";

/* ------------------------------------------------------------------ */
/* What a stored match looks like                                     */
/* ------------------------------------------------------------------ */

/** One game of one series — a `match_games` row, without its ids. */
export type MatchGameRecord = {
  index: number;
  mode: string;
  map: string;
  referee: string;
  scoreA: number;
  scoreB: number;
  played: boolean;
};

/** A `matches` row, without its ids, plus its games. */
export type MatchRecord = {
  slot: string;
  bestOf: number;
  /** Set directly for a table game; null for a bracket slot that resolves. */
  teamAId: string | null;
  teamBId: string | null;
  sourceA: string | null;
  sourceB: string | null;
  scheduledAt: string | null;
  finishedAt: string | null;
  durationMin: number | null;
  winnerOverrideId: string | null;
  games: MatchGameRecord[];
};

export type TeamRef = { id: string; name: string; seed?: number | null };

export type ResolveInput = {
  /** The generated spec — labels, notes, sources and the placement table. */
  stage: GeneratedStage;
  /** Stored rows. An empty list resolves the spec as a preview. */
  matches: MatchRecord[];
  teams: TeamRef[];
  /**
   * The seeding, best first, as team ids. A null entry is a seed that is not
   * settled yet. Absent, the teams' own `seed` column is used, and failing that
   * the order they arrive in.
   */
  seeds?: Array<string | null> | null;
};

export type MatchStatus = "pending" | "live" | "done" | "void";

export type ResolvedMatch = MatchRecord &
  Pick<
    GeneratedMatch,
    "round" | "phase" | "bracket" | "group" | "label" | "displayLabel" | "roundLabel" | "note" | "elimination" | "modes"
  > & {
    /** The resolved teams — the whole point of the module. */
    teamAId: string | null;
    teamBId: string | null;
    nameA: string;
    nameB: string;
    gamesWonA: number;
    gamesWonB: number;
    winner: string | null;
    loser: string | null;
    status: MatchStatus;
    /** Every game is in, nobody won it, and both teams are known. */
    needsDecision: boolean;
    /** True for a bracket reset that the grand final made unnecessary. */
    skipped: boolean;
  };

/* ------------------------------------------------------------------ */
/* Series arithmetic                                                  */
/* ------------------------------------------------------------------ */

/** A fresh, unplayed series for a generated match. */
export function blankGamesFor(match: { modes: string[] }): MatchGameRecord[] {
  return match.modes.map((mode, i) => ({
    index: i,
    mode,
    map: "",
    referee: "",
    scoreA: 0,
    scoreB: 0,
    played: false,
  }));
}

/** The same, from a stage config and a series length. */
export function blankGames(config: StageConfig, bestOf: number): MatchGameRecord[] {
  return blankGamesFor({ modes: modesFor(config, bestOf) });
}

function gameWins(games: MatchGameRecord[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const game of games) {
    if (!game.played) continue;
    if (game.scoreA > game.scoreB) a += 1;
    else if (game.scoreB > game.scoreA) b += 1;
  }
  return { a, b };
}

/**
 * Whether the games alone (or an override) settle a match — the teams are not
 * needed, which is what lets an admin record a series before the slot above it
 * has resolved.
 */
export function isMatchDecided(match: Pick<MatchRecord, "bestOf" | "games" | "winnerOverrideId">): boolean {
  if (match.winnerOverrideId) return true;
  const wins = gameWins(match.games);
  const target = seriesTarget(match.bestOf);
  if (wins.a >= target || wins.b >= target) return true;
  // An empty series is not a finished one, however vacuously `every` agrees.
  return match.games.length >= match.bestOf && match.games.every((g) => g.played);
}

/* ------------------------------------------------------------------ */
/* Standings (§8.5 — already format-agnostic, now per stage)          */
/* ------------------------------------------------------------------ */

export type Standing = {
  id: string;
  name: string;
  group: string | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  /** Maps won and lost. Equal to the match count in a Bo1 table. */
  gamesWon: number;
  gamesLost: number;
  scoreFor: number;
  scoreAgainst: number;
  diff: number;
  points: number;
};

function blankStanding(team: TeamRef, group: string | null): Standing {
  return {
    id: team.id,
    name: team.name,
    group,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    gamesWon: 0,
    gamesLost: 0,
    scoreFor: 0,
    scoreAgainst: 0,
    diff: 0,
    points: 0,
  };
}

/** One table game, already resolved to two teams. */
type TableGame = { a: string; b: string; wins: { a: number; b: number }; scoreA: number; scoreB: number };

function tableFrom(games: TableGame[], teams: TeamRef[], group: string | null, points: PointsRule): Standing[] {
  const rows = new Map<string, Standing>();
  for (const team of teams) rows.set(team.id, blankStanding(team, group));

  for (const game of games) {
    const a = rows.get(game.a);
    const b = rows.get(game.b);
    if (!a || !b) continue; // a match pointing at a team that no longer exists

    a.played += 1;
    b.played += 1;
    a.scoreFor += game.scoreA;
    a.scoreAgainst += game.scoreB;
    b.scoreFor += game.scoreB;
    b.scoreAgainst += game.scoreA;
    a.gamesWon += game.wins.a;
    a.gamesLost += game.wins.b;
    b.gamesWon += game.wins.b;
    b.gamesLost += game.wins.a;

    if (game.wins.a > game.wins.b) {
      a.won += 1;
      b.lost += 1;
      a.points += points.win;
      b.points += points.loss;
    } else if (game.wins.b > game.wins.a) {
      b.won += 1;
      a.lost += 1;
      b.points += points.win;
      a.points += points.loss;
    } else {
      a.drawn += 1;
      b.drawn += 1;
      a.points += points.draw;
      b.points += points.draw;
    }
  }

  for (const row of rows.values()) row.diff = row.scoreFor - row.scoreAgainst;
  return [...rows.values()];
}

/**
 * Points first, then the configured tiebreakers in order.
 *
 * `mini_league` — the default, and what the current board does — re-runs the
 * table over only the matches between everyone still level, which collapses to
 * head-to-head for a straight two-way tie without needing to say so.
 */
function sortStandings(
  rows: Standing[],
  games: TableGame[],
  points: PointsRule,
  tiebreakers: Tiebreaker[]
): Standing[] {
  const miniPoints = (group: Standing[]): Map<string, number> => {
    const ids = new Set(group.map((r) => r.id));
    const scored = new Map(group.map((r) => [r.id, 0]));
    for (const game of games) {
      if (!ids.has(game.a) || !ids.has(game.b)) continue;
      if (game.wins.a > game.wins.b) scored.set(game.a, (scored.get(game.a) ?? 0) + points.win);
      else if (game.wins.b > game.wins.a) scored.set(game.b, (scored.get(game.b) ?? 0) + points.win);
      else {
        scored.set(game.a, (scored.get(game.a) ?? 0) + points.draw);
        scored.set(game.b, (scored.get(game.b) ?? 0) + points.draw);
      }
    }
    return scored;
  };

  const byPoints = [...rows].sort((x, y) => y.points - x.points);
  const out: Standing[] = [];
  let i = 0;

  while (i < byPoints.length) {
    let j = i;
    while (j + 1 < byPoints.length && byPoints[j + 1].points === byPoints[i].points) j += 1;
    const tied = byPoints.slice(i, j + 1);

    if (tied.length > 1) {
      // Head-to-head only means anything for exactly two teams; for three it is
      // a mini-league by another name, so it is left to that rule to state.
      const mini = miniPoints(tied);
      tied.sort((x, y) => {
        for (const rule of tiebreakers) {
          const delta =
            rule === "mini_league" || (rule === "head_to_head" && tied.length === 2)
              ? (mini.get(y.id) ?? 0) - (mini.get(x.id) ?? 0)
              : rule === "wins"
                ? y.won - x.won
                : rule === "diff"
                  ? y.diff - x.diff
                  : rule === "score_for"
                    ? y.scoreFor - x.scoreFor
                    : rule === "name"
                      ? x.name.localeCompare(y.name)
                      : 0;
          if (delta !== 0) return delta;
        }
        return x.name.localeCompare(y.name);
      });
    }

    out.push(...tied);
    i = j + 1;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* The resolver                                                       */
/* ------------------------------------------------------------------ */

type Outcome = {
  winner: string | null;
  loser: string | null;
  decided: boolean;
  wins: { a: number; b: number };
  anyPlayed: boolean;
  skipped: boolean;
};

const NOTHING: Outcome = {
  winner: null,
  loser: null,
  decided: false,
  wins: { a: 0, b: 0 },
  anyPlayed: false,
  skipped: false,
};

/**
 * Everything one stage knows: the resolved matches, the tables, the seeding it
 * hands on and the placements it has settled.
 *
 * Built once and shared, because the four answers are computed from each other
 * — the playoff half of a group stage cannot resolve until its group tables
 * have, and the placements cannot be read until the bracket has.
 */
export class StageResolution {
  readonly stage: GeneratedStage;
  private readonly records = new Map<string, MatchRecord>();
  private readonly names = new Map<string, string>();
  private readonly teams: TeamRef[];
  private readonly seeds: Array<string | null>;
  private readonly outcomes = new Map<string, Outcome>();
  private readonly sides = new Map<string, { a: string | null; b: string | null }>();
  private readonly tables = new Map<string, Standing[]>();
  private readonly visiting = new Set<string>();
  private resolved: ResolvedMatch[] | null = null;

  constructor(input: ResolveInput) {
    this.stage = input.stage;
    this.teams = input.teams;
    for (const team of input.teams) this.names.set(team.id, team.name);
    for (const record of input.matches) this.records.set(record.slot, record);
    this.seeds = seedingFrom(input);
  }

  /** The team holding seed `n` (1-based), or null while it is undecided. */
  seedTeam(n: number): string | null {
    return this.seeds[n - 1] ?? null;
  }

  /** Where a source reference points right now. */
  refTeam(raw: string | null | undefined): string | null {
    const ref = parseSource(raw);
    if (!ref) return null;
    switch (ref.kind) {
      case "seed":
        return this.seedTeam(ref.seed);
      case "winner":
        return this.outcome(ref.slot).winner;
      case "loser":
        return this.outcome(ref.slot).loser;
      case "group": {
        const table = this.groupRanking(ref.group);
        return table?.[ref.rank - 1] ?? null;
      }
    }
  }

  /** What a source reference should print while it is still waiting. */
  placeholder(raw: string | null | undefined): string {
    const ref = parseSource(raw);
    if (!ref) return "TBD";
    switch (ref.kind) {
      case "seed":
        return `Seed ${ref.seed}`;
      case "winner":
        return `${this.labelOf(ref.slot)} winner`;
      case "loser":
        return `${this.labelOf(ref.slot)} loser`;
      case "group":
        return `Group ${ref.group.toUpperCase()} #${ref.rank}`;
    }
  }

  labelOf(slot: string): string {
    return this.stage.bySlot[slot]?.label ?? slot;
  }

  /** The two teams in a slot: whatever is stored, else whatever the sources say. */
  teamsIn(slot: string): { a: string | null; b: string | null } {
    const cached = this.sides.get(slot);
    if (cached) return cached;

    const record = this.records.get(slot);
    const spec = this.stage.bySlot[slot];
    const sourceA = record?.sourceA ?? spec?.sourceA ?? null;
    const sourceB = record?.sourceB ?? spec?.sourceB ?? null;
    const sides = {
      a: record?.teamAId ?? this.refTeam(sourceA),
      b: record?.teamBId ?? this.refTeam(sourceB),
    };
    this.sides.set(slot, sides);
    return sides;
  }

  /**
   * Who won a slot, and whether it is over.
   *
   * The cycle guard is not paranoia: sources are stored text, and an admin (or
   * a bad import) can point two slots at each other. A cycle resolves to
   * "nothing known" rather than a stack overflow.
   */
  outcome(slot: string): Outcome {
    const cached = this.outcomes.get(slot);
    if (cached) return cached;
    if (this.visiting.has(slot)) return NOTHING;
    this.visiting.add(slot);

    const result = this.computeOutcome(slot);
    this.visiting.delete(slot);
    this.outcomes.set(slot, result);
    return result;
  }

  private computeOutcome(slot: string): Outcome {
    const record = this.records.get(slot);
    const spec = this.stage.bySlot[slot];
    if (!record && !spec) return NOTHING;

    const skipped = this.isSkipped(slot);
    if (skipped) return { ...NOTHING, skipped: true };

    const bestOf = record?.bestOf ?? spec?.bestOf ?? 1;
    const games = record?.games ?? [];
    const wins = gameWins(games);
    const anyPlayed = games.some((g) => g.played);
    const { a, b } = this.teamsIn(slot);
    const override = record?.winnerOverrideId ?? null;
    const decided = isMatchDecided({ bestOf, games, winnerOverrideId: override });

    if (!decided) return { winner: null, loser: null, decided: false, wins, anyPlayed, skipped: false };

    // An override naming somebody who is not in the match is a stale form, not
    // an instruction.
    if (override && (override === a || override === b)) {
      return {
        winner: override,
        loser: override === a ? b : a,
        decided: true,
        wins,
        anyPlayed,
        skipped: false,
      };
    }
    if (wins.a > wins.b) return { winner: a, loser: b, decided: true, wins, anyPlayed, skipped: false };
    if (wins.b > wins.a) return { winner: b, loser: a, decided: true, wins, anyPlayed, skipped: false };
    // A draw: finished for a table game, waiting on an admin for a bracket one.
    return { winner: null, loser: null, decided: true, wins, anyPlayed, skipped: false };
  }

  /**
   * A bracket reset that the grand final made unnecessary.
   *
   * It is the one thing a source reference cannot express: the reset happens
   * only when the side that came up through the lower bracket — side B of the
   * grand final by construction — wins it.
   */
  private isSkipped(slot: string): boolean {
    if (slot !== this.stage.resetSlot) return false;
    const spec = this.stage.bySlot[slot];
    const parent = parseSource(spec?.sourceA);
    if (!parent || parent.kind !== "winner") return false;
    const final = this.outcome(parent.slot);
    if (!final.decided || !final.winner) return false;
    return final.winner === this.teamsIn(parent.slot).a;
  }

  /** The table for one group, or the whole stage when `group` is null. */
  table(group: string | null): Standing[] {
    const key = group ?? "";
    const cached = this.tables.get(key);
    if (cached) return cached;

    const inGroup = (team: TeamRef): boolean => {
      if (!group) return true;
      const seeds = this.stage.groups.find((g) => g.key === group)?.seeds ?? [];
      return seeds.some((seed) => this.seedTeam(seed) === team.id);
    };

    const games: TableGame[] = [];
    for (const spec of this.stage.matches) {
      if (spec.bracket !== "rr") continue;
      if (group && spec.group !== group) continue;
      const record = this.records.get(spec.slot);
      const { a, b } = this.teamsIn(spec.slot);
      if (!a || !b) continue;
      const bestOf = record?.bestOf ?? spec.bestOf;
      const played = record?.games ?? [];
      if (!isMatchDecided({ bestOf, games: played, winnerOverrideId: record?.winnerOverrideId ?? null })) {
        continue;
      }
      const wins = gameWins(played);
      games.push({
        a,
        b,
        wins,
        scoreA: played.reduce((sum, g) => sum + (g.played ? g.scoreA : 0), 0),
        scoreB: played.reduce((sum, g) => sum + (g.played ? g.scoreB : 0), 0),
      });
    }

    const teams = this.teams.filter(inGroup);
    const rows = sortStandings(
      tableFrom(games, teams, group, this.stage.config.points),
      games,
      this.stage.config.points,
      this.stage.config.tiebreakers
    );
    this.tables.set(key, rows);
    return rows;
  }

  /**
   * The finishing order of one group, or null while it is still being played.
   *
   * Null rather than a partial table on purpose, and for the same reason
   * `seedsFor` refuses to seed a bracket off an unfinished round robin: a
   * bracket slot filled from a table that is still moving is a slot that will
   * silently change its mind.
   */
  groupRanking(group: string): string[] | null {
    const specs = this.stage.matches.filter((m) => m.bracket === "rr" && m.group === group);
    if (specs.length === 0) return null;
    for (const spec of specs) {
      const record = this.records.get(spec.slot);
      const bestOf = record?.bestOf ?? spec.bestOf;
      if (
        !isMatchDecided({
          bestOf,
          games: record?.games ?? [],
          winnerOverrideId: record?.winnerOverrideId ?? null,
        })
      ) {
        return null;
      }
    }
    return this.table(group).map((row) => row.id);
  }

  /** Every match, in generated order, with anything stored but unknown appended. */
  matches(): ResolvedMatch[] {
    if (this.resolved) return this.resolved;

    const seen = new Set<string>();
    const out: ResolvedMatch[] = [];

    for (const spec of this.stage.matches) {
      seen.add(spec.slot);
      out.push(this.resolveOne(spec.slot, spec));
    }
    for (const [slot] of this.records) {
      if (!seen.has(slot)) out.push(this.resolveOne(slot, null));
    }

    this.resolved = out;
    return out;
  }

  private resolveOne(slot: string, spec: GeneratedMatch | null): ResolvedMatch {
    const record = this.records.get(slot);
    const outcome = this.outcome(slot);
    const { a, b } = this.teamsIn(slot);
    const sourceA = record?.sourceA ?? spec?.sourceA ?? null;
    const sourceB = record?.sourceB ?? spec?.sourceB ?? null;
    const bestOf = record?.bestOf ?? spec?.bestOf ?? 1;
    const elimination = spec?.elimination ?? true;

    // A drawn table game is a finished match. A drawn elimination series is not
    // — somebody has to advance, so it waits on the admin's override.
    const settled = elimination ? outcome.decided && !!outcome.winner : outcome.decided;
    const status: MatchStatus = outcome.skipped
      ? "void"
      : settled
        ? "done"
        : outcome.anyPlayed
          ? "live"
          : "pending";

    return {
      slot,
      bestOf,
      sourceA,
      sourceB,
      scheduledAt: record?.scheduledAt ?? null,
      finishedAt: record?.finishedAt ?? null,
      durationMin: record?.durationMin ?? null,
      winnerOverrideId: record?.winnerOverrideId ?? null,
      games: record?.games ?? (spec ? blankGamesFor(spec) : []),
      round: spec?.round ?? 0,
      phase: spec?.phase ?? 0,
      bracket: (spec?.bracket ?? "rr") as MatchBracket,
      group: spec?.group ?? null,
      label: spec?.label ?? slot,
      displayLabel: spec?.displayLabel ?? slot,
      roundLabel: spec?.roundLabel ?? slot,
      note: spec?.note ?? null,
      elimination,
      modes: spec?.modes ?? [],
      teamAId: a,
      teamBId: b,
      nameA: (a && this.names.get(a)) || this.placeholder(sourceA),
      nameB: (b && this.names.get(b)) || this.placeholder(sourceB),
      gamesWonA: outcome.wins.a,
      gamesWonB: outcome.wins.b,
      winner: outcome.winner,
      loser: outcome.loser,
      status,
      needsDecision: elimination && outcome.decided && !outcome.winner && !!a && !!b,
      skipped: outcome.skipped,
    };
  }

  /** Who has finished where, as far as the results allow. */
  placements(): Array<{ position: number; shared: number; teamId: string }> {
    const out: Array<{ position: number; shared: number; teamId: string }> = [];
    const rules: PlacementRule[] = [...this.stage.placements];

    // A played bracket reset takes over the top two places from the grand final
    // it followed.
    const reset = this.stage.resetSlot;
    if (reset && !this.outcome(reset).skipped && this.outcome(reset).decided) {
      for (const rule of rules) {
        if (rule.position <= 2) rule.slot = reset;
      }
    }

    for (const rule of rules) {
      const outcome = this.outcome(rule.slot);
      const teamId = rule.from === "winner" ? outcome.winner : outcome.loser;
      if (!teamId) continue;
      out.push({ position: rule.position, shared: rule.shared, teamId });
    }
    return out;
  }

  /** The champion, once there is one. */
  champion(): string | null {
    return this.placements().find((p) => p.position === 1)?.teamId ?? null;
  }

  /**
   * The order this stage hands to the next one — its final standings for a
   * table, its placements for a bracket. Null until it is settled, so a
   * downstream bracket never seeds off a moving target.
   */
  seeding(): string[] | null {
    if (this.stage.championSlot) {
      const placed = this.placements();
      const complete = this.stage.placements.every((rule) =>
        placed.some((p) => p.position === rule.position)
      );
      if (!complete) return null;
      return [...placed].sort((x, y) => x.position - y.position).map((p) => p.teamId);
    }
    return this.wholeTableRanking();
  }

  private wholeTableRanking(): string[] | null {
    const specs = this.stage.matches.filter((m) => m.bracket === "rr");
    if (specs.length === 0) return null;
    for (const spec of specs) {
      const record = this.records.get(spec.slot);
      if (
        !isMatchDecided({
          bestOf: record?.bestOf ?? spec.bestOf,
          games: record?.games ?? [],
          winnerOverrideId: record?.winnerOverrideId ?? null,
        })
      ) {
        return null;
      }
    }
    return this.table(null).map((row) => row.id);
  }
}

/* ------------------------------------------------------------------ */
/* Function-shaped entry points                                       */
/* ------------------------------------------------------------------ */

/**
 * The seeding a stage starts from: the caller's explicit order, else the teams'
 * own `seed` column, else the order they arrived in.
 */
export function seedingFrom(input: ResolveInput): Array<string | null> {
  if (input.seeds && input.seeds.length) return [...input.seeds];
  const seeded = input.teams.filter((t) => typeof t.seed === "number");
  if (seeded.length === input.teams.length && seeded.length > 0) {
    return [...input.teams]
      .sort((x, y) => (x.seed as number) - (y.seed as number))
      .map((t) => t.id);
  }
  return input.teams.map((t) => t.id);
}

/** Resolve a stage. The generalised `resolveMatches`. */
export function resolveMatches(input: ResolveInput): ResolvedMatch[] {
  return new StageResolution(input).matches();
}

/** One stage's table, optionally for a single group. */
export function standingsFor(input: ResolveInput, group: string | null = null): Standing[] {
  return new StageResolution(input).table(group);
}

/** Who finished where. The generalised `placementsFor`. */
export function placementsFor(
  input: ResolveInput
): Array<{ position: number; shared: number; teamId: string }> {
  return new StageResolution(input).placements();
}

/** The seeds a following stage should start from, or null while it is unsettled. */
export function seedsFor(input: ResolveInput): string[] | null {
  return new StageResolution(input).seeding();
}
