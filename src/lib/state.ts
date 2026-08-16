import { mutateState, readState } from "./storage";
import { captainAccounts } from "./users";
import { normaliseTiming, seedTournament } from "./tournament";
import type { DraftState, DraftView, Phase, Result, Session, WheelId } from "./types";

export const SPIN_DURATION_MS = 6500;
const DEFAULT_BALANCE = Number(process.env.DEFAULT_BALANCE || 1000);

export function seedState(): DraftState {
  return {
    captains: captainAccounts().map((c) => ({
      id: c.id,
      name: c.name,
      balance: DEFAULT_BALANCE,
      roster: [],
    })),
    mainPool: [],
    reservePool: [],
    activeWheel: "main",
    spin: null,
    currentPlayer: null,
    bids: {},
    lastResult: null,
    history: [],
    tournament: seedTournament(),
    updatedAt: Date.now(),
  };
}

/**
 * Keeps the stored captain rows in step with the configured accounts. The team name is
 * always derived from the login name, so renaming a captain in the env vars renames their
 * team everywhere without a reset.
 */
function reconcileCaptains(state: DraftState): DraftState {
  // States written before the tournament tracker existed have no bracket yet.
  if (!state.tournament?.matches?.length) state.tournament = seedTournament();
  state.tournament.timing = normaliseTiming(state.tournament.timing);
  // Games recorded before the referee field existed have no value for it.
  for (const m of state.tournament.matches) {
    for (const g of m.games) g.referee = g.referee ?? "";
  }

  state.captains = captainAccounts().map((acc) => {
    const existing = state.captains.find((c) => c.id === acc.id);
    return {
      id: acc.id,
      name: acc.name,
      balance: existing?.balance ?? DEFAULT_BALANCE,
      roster: existing?.roster ?? [],
    };
  });
  return state;
}

export async function loadState(): Promise<DraftState> {
  const stored = await readState();
  return reconcileCaptains(stored ?? seedState());
}

export function updateState(
  fn: (state: DraftState) => DraftState | void
): Promise<DraftState> {
  return mutateState((state) => fn(reconcileCaptains(state)), seedState);
}

export function poolFor(state: DraftState, wheel: WheelId): string[] {
  return wheel === "main" ? state.mainPool : state.reservePool;
}

export function setPool(state: DraftState, wheel: WheelId, pool: string[]) {
  if (wheel === "main") state.mainPool = pool;
  else state.reservePool = pool;
}

export function phaseOf(state: DraftState, now = Date.now()): Phase {
  if (state.spin && now < state.spin.startedAt + state.spin.durationMs) return "spinning";
  if (state.currentPlayer) return "bidding";
  if (state.lastResult) return "resolved";
  return "idle";
}

export function allBidsIn(state: DraftState): boolean {
  return state.captains.every((c) => c.id in state.bids);
}

export function toView(state: DraftState, session: Session): DraftView {
  const now = Date.now();
  const phase = phaseOf(state, now);
  const isAdmin = session.role === "admin";
  // Nobody sees a rival's number until the admin resolves the lot — and then only
  // the winning bid becomes public.
  const reveal = isAdmin;

  return {
    now,
    role: session.role,
    username: session.username,
    captainId: session.captainId,
    phase,
    captains: state.captains.map((c) => ({
      id: c.id,
      name: c.name,
      balance: c.balance,
      roster: c.roster,
      hasBid: c.id in state.bids,
      bid: reveal || c.id === session.captainId ? (state.bids[c.id] ?? null) : null,
    })),
    activeWheel: state.activeWheel,
    spin: state.spin,
    // During the spin the name is withheld from the payload; the wheel animation
    // reveals it at the same moment for everyone.
    currentPlayer: phase === "spinning" ? null : state.currentPlayer,
    lastResult: state.lastResult,
    // The full record, not a window — a draft's prices are the point of keeping it.
    history: state.history,
    allBidsIn: allBidsIn(state),
    activePool: poolFor(state, state.activeWheel),
    mainPool: isAdmin ? state.mainPool : null,
    reservePool: isAdmin ? state.reservePool : null,
    mainPoolCount: state.mainPool.length,
    reservePoolCount: state.reservePool.length,
  };
}

export function recordResult(state: DraftState, result: Result) {
  state.lastResult = result;
  state.history = [result, ...state.history].slice(0, 1000);
  state.spin = null;
  state.currentPlayer = null;
  state.bids = {};
}

export function undoLast(state: DraftState): string | null {
  const last = state.history[0];
  if (!last) return "Nothing to undo";

  const pool = poolFor(state, last.fromWheel);
  if (last.action === "award" && last.winnerId) {
    const captain = state.captains.find((c) => c.id === last.winnerId);
    if (captain) {
      captain.balance += last.amount ?? 0;
      const idx = captain.roster.lastIndexOf(last.player);
      if (idx >= 0) captain.roster.splice(idx, 1);
    }
    if (!pool.includes(last.player)) pool.push(last.player);
  } else if (last.action === "discard") {
    if (!pool.includes(last.player)) pool.push(last.player);
  } else if (last.action === "reserve") {
    state.reservePool = state.reservePool.filter((p) => p !== last.player);
    if (!state.mainPool.includes(last.player)) state.mainPool.push(last.player);
  }

  state.history = state.history.slice(1);
  state.lastResult = state.history[0] ?? null;
  state.spin = null;
  state.currentPlayer = null;
  state.bids = {};
  return null;
}
