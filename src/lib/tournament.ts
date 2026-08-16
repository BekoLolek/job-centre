import { addMinutesTo } from "./time";
import type {
  Captain,
  DraftState,
  Game,
  GameMode,
  Match,
  ResolvedMatch,
  Standing,
  Timing,
  Tournament,
  TournamentView,
} from "./types";

/** Starting point for the schedule auto-fill. The admin can change all four. */
export const DEFAULT_TIMING: Timing = {
  convoy: 30,
  domination: 15,
  betweenGames: 5,
  betweenSeries: 10,
};

export function normaliseTiming(input: Partial<Timing> | undefined | null): Timing {
  const clamp = (value: unknown, fallback: number, max: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
  };
  return {
    convoy: clamp(input?.convoy, DEFAULT_TIMING.convoy, 600) || DEFAULT_TIMING.convoy,
    domination:
      clamp(input?.domination, DEFAULT_TIMING.domination, 600) || DEFAULT_TIMING.domination,
    betweenGames: clamp(input?.betweenGames, DEFAULT_TIMING.betweenGames, 240),
    betweenSeries: clamp(input?.betweenSeries, DEFAULT_TIMING.betweenSeries, 240),
  };
}

export const POINTS = { win: 3, draw: 1, loss: 0 };

/** Round robin is a single convoy/convergence map; a series decider is always domination. */
export function modeForGame(bestOf: number, gameNumber: number): GameMode {
  if (bestOf === 1) return "convoy";
  return gameNumber === bestOf ? "domination" : "convoy";
}

export function blankGamesFor(bestOf: 1 | 3 | 5): Game[] {
  return blankGames(bestOf);
}

function blankGames(bestOf: 1 | 3 | 5): Game[] {
  return Array.from({ length: bestOf }, (_, i) => ({
    mode: modeForGame(bestOf, i + 1),
    map: "",
    referee: "",
    scoreA: 0,
    scoreB: 0,
    played: false,
  }));
}

function match(
  partial: Omit<
    Match,
    "games" | "scheduledAt" | "finishedAt" | "durationMin" | "winnerOverride"
  >
): Match {
  return {
    ...partial,
    scheduledAt: null,
    finishedAt: null,
    durationMin: null,
    games: blankGames(partial.bestOf),
    winnerOverride: null,
  };
}

/** Round robin: three rounds of two parallel matches, so nobody sits out a round. */
const RR_ROUNDS: Array<Array<[string, string]>> = [
  [
    ["c1", "c2"],
    ["c3", "c4"],
  ],
  [
    ["c1", "c3"],
    ["c2", "c4"],
  ],
  [
    ["c1", "c4"],
    ["c2", "c3"],
  ],
];

export function seedTournament(): Tournament {
  const matches: Match[] = [];

  RR_ROUNDS.forEach((round, i) => {
    for (const [a, b] of round) {
      matches.push(
        match({
          id: `rr-${a}-${b}`,
          kind: "rr",
          slot: null,
          phase: i + 1,
          label: `Round ${i + 1}`,
          bestOf: 1,
          teamA: a,
          teamB: b,
        })
      );
    }
  });

  const bracket: Array<[Match["slot"], number, string, 1 | 3 | 5]> = [
    ["ubsf1", 1, "Upper semi 1", 3],
    ["ubsf2", 1, "Upper semi 2", 3],
    ["ubf", 2, "Upper final", 3],
    ["lbr1", 2, "Lower round 1", 3],
    ["lbf", 3, "Lower final · bronze", 3],
    ["gf", 4, "Grand final", 5],
  ];

  for (const [slot, phase, label, bestOf] of bracket) {
    matches.push(
      match({
        id: slot as string,
        kind: "bracket",
        slot,
        phase,
        label,
        bestOf,
        teamA: null,
        teamB: null,
      })
    );
  }

  return { matches, seedOverride: null, timing: { ...DEFAULT_TIMING } };
}

// --- results ------------------------------------------------------------------------

function gameWins(m: Match): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const g of m.games) {
    if (!g.played) continue;
    if (g.scoreA > g.scoreB) a++;
    else if (g.scoreB > g.scoreA) b++;
  }
  return { a, b };
}

function seriesTarget(bestOf: number) {
  return Math.floor(bestOf / 2) + 1;
}

/** All games played, or one side already out of reach. */
function isDecided(m: Match, wins: { a: number; b: number }) {
  if (m.winnerOverride) return true;
  const target = seriesTarget(m.bestOf);
  if (wins.a >= target || wins.b >= target) return true;
  return m.games.every((g) => g.played);
}

/** Whether the games alone (or an override) settle the match — teams are not needed. */
export function isMatchDecided(m: Match): boolean {
  return isDecided(m, gameWins(m));
}

function outcome(m: Match): {
  wins: { a: number; b: number };
  winner: "a" | "b" | null;
  done: boolean;
} {
  const wins = gameWins(m);
  const done = isDecided(m, wins);
  if (!done) return { wins, winner: null, done };
  if (m.winnerOverride) {
    if (m.winnerOverride === m.teamA) return { wins, winner: "a", done };
    if (m.winnerOverride === m.teamB) return { wins, winner: "b", done };
  }
  if (wins.a > wins.b) return { wins, winner: "a", done };
  if (wins.b > wins.a) return { wins, winner: "b", done };
  return { wins, winner: null, done }; // a draw, or awaiting an override
}

// --- standings ----------------------------------------------------------------------

export function standingsFor(state: DraftState): Standing[] {
  const rows = new Map<string, Standing>();
  for (const c of state.captains) {
    rows.set(c.id, {
      id: c.id,
      name: c.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      diff: 0,
      points: 0,
    });
  }

  for (const m of state.tournament.matches) {
    if (m.kind !== "rr" || !m.teamA || !m.teamB) continue;
    const game = m.games[0];
    if (!game?.played) continue;
    const a = rows.get(m.teamA);
    const b = rows.get(m.teamB);
    if (!a || !b) continue;

    a.played++;
    b.played++;
    a.scoreFor += game.scoreA;
    a.scoreAgainst += game.scoreB;
    b.scoreFor += game.scoreB;
    b.scoreAgainst += game.scoreA;

    if (game.scoreA > game.scoreB) {
      a.won++;
      b.lost++;
      a.points += POINTS.win;
      b.points += POINTS.loss;
    } else if (game.scoreB > game.scoreA) {
      b.won++;
      a.lost++;
      b.points += POINTS.win;
      a.points += POINTS.loss;
    } else {
      a.drawn++;
      b.drawn++;
      a.points += POINTS.draw;
      b.points += POINTS.draw;
    }
  }

  for (const row of rows.values()) row.diff = row.scoreFor - row.scoreAgainst;

  return sortStandings([...rows.values()], state);
}

/**
 * Points, then a mini-league among everyone still level (which collapses to head-to-head
 * for a straight two-way tie), then map differential, then maps won.
 */
function sortStandings(rows: Standing[], state: DraftState): Standing[] {
  const miniPoints = (group: Standing[]) => {
    const ids = new Set(group.map((r) => r.id));
    const pts = new Map(group.map((r) => [r.id, 0]));
    for (const m of state.tournament.matches) {
      if (m.kind !== "rr" || !m.teamA || !m.teamB) continue;
      if (!ids.has(m.teamA) || !ids.has(m.teamB)) continue;
      const game = m.games[0];
      if (!game?.played) continue;
      if (game.scoreA > game.scoreB) pts.set(m.teamA, (pts.get(m.teamA) ?? 0) + POINTS.win);
      else if (game.scoreB > game.scoreA)
        pts.set(m.teamB, (pts.get(m.teamB) ?? 0) + POINTS.win);
      else {
        pts.set(m.teamA, (pts.get(m.teamA) ?? 0) + POINTS.draw);
        pts.set(m.teamB, (pts.get(m.teamB) ?? 0) + POINTS.draw);
      }
    }
    return pts;
  };

  const byPoints = [...rows].sort((x, y) => y.points - x.points);
  const out: Standing[] = [];
  let i = 0;
  while (i < byPoints.length) {
    let j = i;
    while (j + 1 < byPoints.length && byPoints[j + 1].points === byPoints[i].points) j++;
    const group = byPoints.slice(i, j + 1);
    if (group.length > 1) {
      const mini = miniPoints(group);
      group.sort(
        (x, y) =>
          (mini.get(y.id) ?? 0) - (mini.get(x.id) ?? 0) ||
          y.diff - x.diff ||
          y.scoreFor - x.scoreFor ||
          x.name.localeCompare(y.name)
      );
    }
    out.push(...group);
    i = j + 1;
  }
  return out;
}

export function seedsFor(state: DraftState): string[] | null {
  if (state.tournament.seedOverride?.length === 4) return state.tournament.seedOverride;
  const rr = state.tournament.matches.filter((m) => m.kind === "rr");
  if (!rr.every((m) => m.games[0]?.played)) return null;
  return standingsFor(state).map((r) => r.id);
}

// --- bracket resolution ---------------------------------------------------------------

const NOTES: Partial<Record<string, string>> = {
  lbr1: "Loser is 4th",
  lbf: "Loser takes bronze",
  gf: "Winner is champion",
};

/** Shown in place of a team name while the slot is still waiting on an earlier result. */
const SLOT_SOURCES: Record<string, [string, string]> = {
  ubsf1: ["Seed 1", "Seed 4"],
  ubsf2: ["Seed 2", "Seed 3"],
  ubf: ["Upper semi 1 winner", "Upper semi 2 winner"],
  lbr1: ["Upper semi 1 loser", "Upper semi 2 loser"],
  lbf: ["Upper final loser", "Lower round 1 winner"],
  gf: ["Upper final winner", "Lower final winner"],
};

export function resolveMatches(state: DraftState): ResolvedMatch[] {
  const names = new Map(state.captains.map((c: Captain) => [c.id, c.name]));
  const seeds = seedsFor(state);
  const byId = new Map(state.tournament.matches.map((m) => [m.id, m]));

  const winners = new Map<string, string | null>();
  const losers = new Map<string, string | null>();
  const teams = new Map<string, { a: string | null; b: string | null }>();

  const settle = (id: string, a: string | null, b: string | null) => {
    const m = byId.get(id);
    if (!m) return;
    teams.set(id, { a, b });
    const withTeams = { ...m, teamA: a, teamB: b };
    const { winner } = outcome(withTeams);
    winners.set(id, winner === "a" ? a : winner === "b" ? b : null);
    losers.set(id, winner === "a" ? b : winner === "b" ? a : null);
  };

  for (const m of state.tournament.matches) {
    if (m.kind === "rr") settle(m.id, m.teamA, m.teamB);
  }

  settle("ubsf1", seeds?.[0] ?? null, seeds?.[3] ?? null);
  settle("ubsf2", seeds?.[1] ?? null, seeds?.[2] ?? null);
  settle("ubf", winners.get("ubsf1") ?? null, winners.get("ubsf2") ?? null);
  settle("lbr1", losers.get("ubsf1") ?? null, losers.get("ubsf2") ?? null);
  settle("lbf", losers.get("ubf") ?? null, winners.get("lbr1") ?? null);
  settle("gf", winners.get("ubf") ?? null, winners.get("lbf") ?? null);

  return state.tournament.matches.map((m) => {
    const t = teams.get(m.id) ?? { a: m.teamA, b: m.teamB };
    const withTeams = { ...m, teamA: t.a, teamB: t.b };
    const { wins, winner, done } = outcome(withTeams);
    const anyPlayed = m.games.some((g) => g.played);
    // A drawn round-robin map is a finished match. A drawn bracket series is not —
    // somebody has to advance, so it waits on the admin's override.
    const settled = m.kind === "rr" ? done : done && !!winner;
    const [sourceA, sourceB] = SLOT_SOURCES[m.id] ?? ["TBD", "TBD"];
    return {
      ...withTeams,
      nameA: t.a ? (names.get(t.a) ?? sourceA) : sourceA,
      nameB: t.b ? (names.get(t.b) ?? sourceB) : sourceB,
      gamesWonA: wins.a,
      gamesWonB: wins.b,
      winner: winner === "a" ? t.a : winner === "b" ? t.b : null,
      loser: winner === "a" ? t.b : winner === "b" ? t.a : null,
      status: settled ? "done" : anyPlayed ? "live" : "pending",
      needsDecision: m.kind === "bracket" && done && !winner && !!t.a && !!t.b,
      note: NOTES[m.id] ?? null,
    };
  });
}

export function placementsFor(matches: ResolvedMatch[]) {
  const find = (id: string) => matches.find((m) => m.id === id);
  const gf = find("gf");
  const lbf = find("lbf");
  const lbr1 = find("lbr1");
  if (!gf?.winner || !gf.loser || !lbf?.loser || !lbr1?.loser) return null;
  return { first: gf.winner, second: gf.loser, third: lbf.loser, fourth: lbr1.loser };
}

export function toTournamentView(state: DraftState, isAdmin: boolean): TournamentView {
  const matches = resolveMatches(state);
  return {
    now: Date.now(),
    isAdmin,
    teams: state.captains.map((c) => ({ id: c.id, name: c.name, roster: c.roster })),
    standings: standingsFor(state),
    seeds: seedsFor(state),
    timing: normaliseTiming(state.tournament.timing),
    matches,
    placements: placementsFor(matches),
  };
}

// --- schedule auto-fill ---------------------------------------------------------------

/** Longest a series can run, in minutes, including the breaks between its own games. */
export function seriesMinutes(bestOf: 1 | 3 | 5, timing: Timing): number {
  const games = Array.from({ length: bestOf }, (_, i) =>
    modeForGame(bestOf, i + 1) === "domination" ? timing.domination : timing.convoy
  );
  return games.reduce((sum, m) => sum + m, 0) + (bestOf - 1) * timing.betweenGames;
}

type Phase = { day: 1 | 2; label: string; ids: string[]; bestOf: 1 | 3 | 5 };

const PHASES: Phase[] = [
  { day: 1, label: "Round robin 1", ids: ["rr-c1-c2", "rr-c3-c4"], bestOf: 1 },
  { day: 1, label: "Round robin 2", ids: ["rr-c1-c3", "rr-c2-c4"], bestOf: 1 },
  { day: 1, label: "Round robin 3", ids: ["rr-c1-c4", "rr-c2-c3"], bestOf: 1 },
  { day: 1, label: "Upper semis", ids: ["ubsf1", "ubsf2"], bestOf: 3 },
  { day: 1, label: "Upper final + lower round 1", ids: ["ubf", "lbr1"], bestOf: 3 },
  { day: 2, label: "Lower final · bronze", ids: ["lbf"], bestOf: 3 },
  { day: 2, label: "Grand final", ids: ["gf"], bestOf: 5 },
];

export type PlannedPhase = Phase & { offsetMin: number; lengthMin: number };

/**
 * Both days laid out block by block. Matches inside a block run in parallel, so the next
 * block starts one series break after the longest series in this one finishes.
 */
export function schedulePlan(timing: Timing): PlannedPhase[] {
  const cursor = { 1: 0, 2: 0 };
  return PHASES.map((phase) => {
    const lengthMin = seriesMinutes(phase.bestOf, timing);
    const offsetMin = cursor[phase.day];
    cursor[phase.day] = offsetMin + lengthMin + timing.betweenSeries;
    return { ...phase, offsetMin, lengthMin };
  });
}

/** Wall-clock length of each day: last block's end, without a trailing break. */
export function dayMinutes(timing: Timing): { day1: number; day2: number } {
  const plan = schedulePlan(timing);
  const endOf = (day: 1 | 2) =>
    plan
      .filter((p) => p.day === day)
      .reduce((max, p) => Math.max(max, p.offsetMin + p.lengthMin), 0);
  return { day1: endOf(1), day2: endOf(2) };
}

/**
 * Stamps every match with a start time from the plan. Day starts arrive as absolute
 * instants, so adding minutes is real elapsed time and stays correct across zones.
 * A day left blank is skipped.
 */
export function autoSchedule(state: DraftState, day1: string, day2: string, timing: Timing) {
  const byId = new Map(state.tournament.matches.map((m) => [m.id, m]));
  const starts: Record<1 | 2, string> = { 1: day1, 2: day2 };

  for (const phase of schedulePlan(timing)) {
    const start = starts[phase.day];
    const at = start ? addMinutesTo(start, phase.offsetMin) : null;
    if (!at) continue;
    for (const id of phase.ids) {
      const m = byId.get(id);
      // A match that has already been played keeps the slot it actually ran in.
      if (m && !m.finishedAt) m.scheduledAt = at;
    }
  }
  // Pass the day starts through: an explicit auto-fill is the admin stating when the day
  // begins, and it must win over the historical start of anything already played.
  recalculateSchedule(state, { timing, anchors: { 1: day1, 2: day2 } });
}

/**
 * Re-flows each day from what has actually happened.
 *
 * Matches inside a block run in parallel, so the block is over only once the slowest of
 * them finishes — that is when the break starts, and every later block on that day shifts
 * with it. Blocks that have not been played yet fall back to their planned length. Days
 * are independent: day 1 running late never moves day 2, which has its own start time.
 */
export function recalculateSchedule(
  state: DraftState,
  opts: { timing?: Timing; anchors?: Partial<Record<1 | 2, string>> } = {}
) {
  const timing = normaliseTiming(opts.timing ?? state.tournament.timing);
  const byId = new Map(state.tournament.matches.map((m) => [m.id, m]));
  const plan = schedulePlan(timing);
  const latest = (stamps: string[]) => stamps.reduce((max, s) => (s > max ? s : max));

  for (const day of [1, 2] as const) {
    const phases = plan.filter((p) => p.day === day);
    const first = phases.findIndex((p) => p.ids.some((id) => byId.get(id)?.scheduledAt));
    if (first < 0) continue; // this day was never given a start time

    // Anchor priority: an explicit day start, then the first block's first *unplayed*
    // match. Sniffing a played match's start would drag the day back to when that match
    // happened to run, which is not where the admin just said the day begins.
    const firstBlock = phases[first].ids
      .map((id) => byId.get(id))
      .filter((m): m is Match => Boolean(m));
    const anchor = opts.anchors?.[day];
    let cursor: string | null =
      // addMinutesTo(_, 0) normalises: a naive datetime-local value becomes an instant,
      // and anything unparseable becomes null and falls through.
      (anchor ? addMinutesTo(anchor, 0) : null) ||
      firstBlock.find((m) => !m.finishedAt && m.scheduledAt)?.scheduledAt ||
      firstBlock.find((m) => m.scheduledAt)?.scheduledAt ||
      null;

    for (const phase of phases.slice(first)) {
      if (!cursor) break;
      const matches = phase.ids
        .map((id) => byId.get(id))
        .filter((m): m is Match => Boolean(m));
      if (matches.length === 0) continue;

      for (const m of matches) if (!m.finishedAt) m.scheduledAt = cursor;

      const ends = matches.map(
        (m) => m.finishedAt ?? addMinutesTo(cursor as string, phase.lengthMin)
      );
      const known = ends.filter((e): e is string => Boolean(e));
      cursor = known.length === matches.length ? addMinutesTo(latest(known), timing.betweenSeries) : null;
    }
  }
}

/**
 * Keeps finishedAt and durationMin in step after an edit. An explicit duration wins;
 * otherwise the finish is stamped now and the duration derived from the scheduled start.
 */
export function syncFinish(m: Match, durationWasGiven: boolean, now = new Date()) {
  if (!isMatchDecided(m)) {
    m.finishedAt = null;
    return;
  }
  if (!m.finishedAt) {
    // A match cannot end before it starts — guards against recording against a
    // schedule that is still in the future.
    const stamp = now.toISOString();
    m.finishedAt = m.scheduledAt && stamp < m.scheduledAt ? m.scheduledAt : stamp;
  }

  if (durationWasGiven && m.scheduledAt && m.durationMin !== null) {
    m.finishedAt = addMinutesTo(m.scheduledAt, m.durationMin) ?? m.finishedAt;
    return;
  }
  if (m.durationMin === null && m.scheduledAt) {
    const mins = Math.round(
      (Date.parse(m.finishedAt) - Date.parse(m.scheduledAt)) / 60_000
    );
    // Ignore nonsense windows — a stale schedule shouldn't invent a 3-day match.
    if (mins > 0 && mins <= 1440) m.durationMin = mins;
  }
}
