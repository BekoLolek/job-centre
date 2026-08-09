import type {
  Captain,
  DraftState,
  Game,
  GameMode,
  Match,
  ResolvedMatch,
  Standing,
  Tournament,
  TournamentView,
} from "./types";

/** Agreed timings, in minutes. Used by the schedule auto-fill. */
export const TIMING = {
  convoy: 30,
  domination: 15,
  betweenGames: 5,
  betweenSeries: 10,
};

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
    scoreA: 0,
    scoreB: 0,
    played: false,
  }));
}

function match(
  partial: Omit<Match, "games" | "scheduledAt" | "durationMin" | "winnerOverride">
): Match {
  return {
    ...partial,
    scheduledAt: null,
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

  return { matches, seedOverride: null };
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
    return {
      ...withTeams,
      nameA: t.a ? (names.get(t.a) ?? "—") : "—",
      nameB: t.b ? (names.get(t.b) ?? "—") : "—",
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
    matches,
    placements: placementsFor(matches),
  };
}

// --- schedule auto-fill ---------------------------------------------------------------

/** Longest a series can run, in minutes, including the breaks between its own games. */
export function seriesMinutes(bestOf: 1 | 3 | 5): number {
  const games = Array.from({ length: bestOf }, (_, i) =>
    modeForGame(bestOf, i + 1) === "domination" ? TIMING.domination : TIMING.convoy
  );
  return games.reduce((sum, m) => sum + m, 0) + (bestOf - 1) * TIMING.betweenGames;
}

const DAY1_PHASES: Array<{ ids: string[]; bestOf: 1 | 3 | 5 }> = [
  { ids: ["rr-c1-c2", "rr-c3-c4"], bestOf: 1 },
  { ids: ["rr-c1-c3", "rr-c2-c4"], bestOf: 1 },
  { ids: ["rr-c1-c4", "rr-c2-c3"], bestOf: 1 },
  { ids: ["ubsf1", "ubsf2"], bestOf: 3 },
  { ids: ["ubf", "lbr1"], bestOf: 3 },
];

const DAY2_PHASES: Array<{ ids: string[]; bestOf: 1 | 3 | 5 }> = [
  { ids: ["lbf"], bestOf: 3 },
  { ids: ["gf"], bestOf: 5 },
];

function addMinutes(stamp: string, minutes: number): string {
  const [date, time] = stamp.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const at = new Date(y, mo - 1, d, h, mi + minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Walks the two days block by block. Matches inside a block run in parallel, so the next
 * block starts one series break after the longest series in the current one finishes.
 */
export function autoSchedule(state: DraftState, day1: string, day2: string) {
  const byId = new Map(state.tournament.matches.map((m) => [m.id, m]));
  const run = (phases: typeof DAY1_PHASES, start: string) => {
    let cursor = start;
    for (const phase of phases) {
      for (const id of phase.ids) {
        const m = byId.get(id);
        if (m) m.scheduledAt = cursor;
      }
      cursor = addMinutes(cursor, seriesMinutes(phase.bestOf) + TIMING.betweenSeries);
    }
    return cursor;
  };
  if (day1) run(DAY1_PHASES, day1);
  if (day2) run(DAY2_PHASES, day2);
}
