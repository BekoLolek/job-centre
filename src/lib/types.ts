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
  updatedAt: number;
};

export type Role = "admin" | "captain";

export type Session = {
  role: Role;
  username: string;
  /** Captain id (c1..c4); null for admin. */
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
  /** Admin only. */
  mainPool: string[] | null;
  reservePool: string[] | null;
  mainPoolCount: number;
  reservePoolCount: number;
};
