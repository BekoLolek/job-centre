export type WheelId = "main" | "reserve";

export type Captain = {
  id: string;
  name: string;
  balance: number;
  roster: string[];
};

export type Spin = {
  wheel: WheelId;
  /** Snapshot of the pool at spin time — clients animate against this exact order. */
  pool: string[];
  targetIndex: number;
  startedAt: number;
  durationMs: number;
  turns: number;
};

export type ResultAction = "award" | "discard" | "reserve";

export type Result = {
  player: string;
  action: ResultAction;
  fromWheel: WheelId;
  winnerId: string | null;
  winnerName: string | null;
  amount: number | null;
  at: number;
};

export type GameMode = "convoy" | "domination";

export type Game = {
  mode: GameMode;
  map: string;
  referee: string;
  scoreA: number;
  scoreB: number;
  played: boolean;
};

export type BracketSlot = "ubsf1" | "ubsf2" | "ubf" | "lbr1" | "lbf" | "gf";

export type Match = {
  id: string;
  kind: "rr" | "bracket";
  slot: BracketSlot | null;
  /** Round-robin round 1–3, or bracket phase 1–4. Blocks in the same phase run in parallel. */
  phase: number;
  label: string;
  bestOf: 1 | 3 | 5;
  /** Fixed for round robin; null for bracket slots, which resolve from earlier results. */
  teamA: string | null;
  teamB: string | null;
  /** An absolute instant (ISO 8601, UTC). Rendered in each viewer's own zone. */
  scheduledAt: string | null;
  /** When the match actually finished — stamped the moment it becomes decided. */
  finishedAt: string | null;
  durationMin: number | null;
  games: Game[];
  /** Set by the admin when the games alone don't settle it (e.g. a drawn decider). */
  winnerOverride: string | null;
};

/** Minutes. Drives the schedule auto-fill and the estimate shown next to it. */
export type Timing = {
  convoy: number;
  domination: number;
  betweenGames: number;
  betweenSeries: number;
};

export type Tournament = {
  matches: Match[];
  /** Admin-set seed order (captain ids, best first). Overrides the computed standings. */
  seedOverride: string[] | null;
  timing: Timing;
};

export type Standing = {
  id: string;
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  scoreFor: number;
  scoreAgainst: number;
  diff: number;
  points: number;
};

export type ResolvedMatch = Match & {
  teamA: string | null;
  teamB: string | null;
  nameA: string;
  nameB: string;
  gamesWonA: number;
  gamesWonB: number;
  winner: string | null;
  loser: string | null;
  status: "pending" | "live" | "done";
  /** Bracket only: every game is in but nobody won it, so the admin must pick. */
  needsDecision: boolean;
  /** Human note for what is at stake, e.g. "Loser is 4th". */
  note: string | null;
};

export type TournamentView = {
  now: number;
  isAdmin: boolean;
  teams: Array<{ id: string; name: string; roster: string[] }>;
  standings: Standing[];
  seeds: string[] | null;
  timing: Timing;
  matches: ResolvedMatch[];
  placements: { first: string; second: string; third: string; fourth: string } | null;
};

export type DraftState = {
  captains: Captain[];
  mainPool: string[];
  reservePool: string[];
  activeWheel: WheelId;
  spin: Spin | null;
  currentPlayer: string | null;
  /** captainId -> bid amount. Presence of a key means "bid submitted". */
  bids: Record<string, number>;
  lastResult: Result | null;
  history: Result[];
  tournament: Tournament;
  updatedAt: number;
};

export type Role = "admin" | "captain" | "observer";

export type Session = {
  role: Role;
  username: string;
  /** Captain id (c1..c4); null for admin and observers. */
  captainId: string | null;
};

export type Phase = "idle" | "spinning" | "bidding" | "resolved";

/** What the browser actually receives — bid amounts are stripped for captains. */
export type DraftView = {
  now: number;
  role: Role;
  username: string;
  captainId: string | null;
  phase: Phase;
  captains: Array<{
    id: string;
    name: string;
    balance: number;
    roster: string[];
    hasBid: boolean;
    /** Only populated for the admin, or for the captain's own row. */
    bid: number | null;
  }>;
  activeWheel: WheelId;
  spin: Spin | null;
  currentPlayer: string | null;
  lastResult: Result | null;
  history: Result[];
  allBidsIn: boolean;
  /** Names on the wheel everyone is currently looking at — sent to captains too. */
  activePool: string[];
  /** Admin only: the full lists, including the reserve wheel while it is still hidden. */
  mainPool: string[] | null;
  reservePool: string[] | null;
  mainPoolCount: number;
  reservePoolCount: number;
};
