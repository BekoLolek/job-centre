import { seedTournament } from "@/lib/tournament";
import type { Captain, DraftState, Match, Result, Session, WheelId } from "@/lib/types";

/** Four captains with stable, alphabetical names so ordering assertions stay readable. */
export const CAPTAIN_NAMES: Record<string, string> = {
  c1: "Alpha",
  c2: "Bravo",
  c3: "Charlie",
  c4: "Delta",
};

export function makeCaptains(names: Record<string, string> = CAPTAIN_NAMES): Captain[] {
  return Object.entries(names).map(([id, name]) => ({
    id,
    name,
    balance: 1000,
    roster: [],
  }));
}

export function makeState(over: Partial<DraftState> = {}): DraftState {
  return {
    captains: makeCaptains(),
    mainPool: [],
    reservePool: [],
    activeWheel: "main",
    spin: null,
    currentPlayer: null,
    bids: {},
    lastResult: null,
    history: [],
    tournament: seedTournament(),
    updatedAt: 0,
    ...over,
  };
}

export function matchIn(state: DraftState, id: string): Match {
  const m = state.tournament.matches.find((x) => x.id === id);
  if (!m) throw new Error(`no match ${id}`);
  return m;
}

/** Mark a single game of a series as played with the given score. */
export function playGame(
  state: DraftState,
  id: string,
  index: number,
  scoreA: number,
  scoreB: number
) {
  const g = matchIn(state, id).games[index];
  if (!g) throw new Error(`no game ${index} in ${id}`);
  g.scoreA = scoreA;
  g.scoreB = scoreB;
  g.played = true;
}

/** Round robin is a single map. */
export function playRr(state: DraftState, id: string, scoreA: number, scoreB: number) {
  playGame(state, id, 0, scoreA, scoreB);
}

/** Play the first N games of a series, in order. */
export function playSeries(state: DraftState, id: string, scores: Array<[number, number]>) {
  scores.forEach(([a, b], i) => playGame(state, id, i, a, b));
}

export const RR_IDS = [
  "rr-c1-c2",
  "rr-c3-c4",
  "rr-c1-c3",
  "rr-c2-c4",
  "rr-c1-c4",
  "rr-c2-c3",
] as const;

/**
 * A full round robin whose table finishes c2, c1, c3, c4:
 * c1 and c2 both take 6 points, and the head-to-head (c2 won it) outranks c1's
 * much better map difference. c3 and c4 both take 3, split by their head-to-head.
 */
export function playFullRoundRobin(state: DraftState) {
  playRr(state, "rr-c1-c2", 0, 1);
  playRr(state, "rr-c3-c4", 1, 0);
  playRr(state, "rr-c1-c3", 5, 0);
  playRr(state, "rr-c2-c4", 0, 1);
  playRr(state, "rr-c1-c4", 5, 0);
  playRr(state, "rr-c2-c3", 1, 0);
}

export function makeResult(over: Partial<Result> = {}): Result {
  return {
    player: "Nova",
    action: "award",
    fromWheel: "main" as WheelId,
    winnerId: "c1",
    winnerName: "Alpha",
    amount: 120,
    at: 1_700_000_000_000,
    ...over,
  };
}

export function makeSession(over: Partial<Session> = {}): Session {
  return { role: "admin", username: "admin", captainId: null, ...over };
}
