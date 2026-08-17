/**
 * The rules a draft obeys — all of them, in one place, with no database.
 *
 * docs/platform-plan.md §9 lists what an admin may configure; §14 settles the
 * one question that changes the arithmetic everywhere: **a captain occupies a
 * roster slot**. They are a `team_members` row costing nothing, they never
 * enter the pool, and every count below includes them without a special case.
 *
 * Four questions get asked from at least three places each — the admin's draft
 * console, a captain's bid panel, and the room watching:
 *
 *  1. How much may this team actually bid right now?
 *  2. Is *this* bid allowed, and if not, why not?
 *  3. Who won the lot — and is it even decided?
 *  4. What is this particular viewer allowed to see?
 *
 * Every answer is a pure function over plain data, which is what makes the
 * awkward cases cheap: a team one slot from full with £1 left, two captains
 * bidding the identical amount, an award undone after three more lots have
 * settled.
 *
 * ## The two things this module refuses to do
 *
 * There is **no stored remaining balance**, and there must never be one.
 * `balanceFor` derives it from the awarded lots every time, because the moment
 * an award is voided or a price corrected, a stored copy and the history
 * disagree — and the stored copy wins, since it is the one the bid check reads.
 * That is the same reasoning that keeps `applications_open` off the events
 * table.
 *
 * And **a tie is never broken here**. Two equal top bids are a fact about the
 * lot, not a problem to be solved with a coin flip nobody saw; `resolveLot`
 * reports it and an admin decides.
 */

import type {
  DraftBalanceMode,
  DraftBidVisibility,
  DraftBiddingMode,
  DraftLotStatus,
  DraftPoolKind,
  DraftSelectionMode,
  DraftSpin,
} from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Configuration (§9)                                                 */
/* ------------------------------------------------------------------ */

/**
 * One event's draft rules, as the rest of this module wants them: every field
 * present, every number sane. `draft_configs` is the storage; this is the shape
 * after `draftConfigFrom` has filled the gaps.
 */
export type DraftConfig = {
  /** Uniform balances, or one per team so an admin can handicap. */
  balanceMode: DraftBalanceMode;
  /** What a team starts with when nothing more specific is set. */
  defaultBalance: number;
  biddingMode: DraftBiddingMode;
  /** The floor for any bid. Zero — today's behaviour — means free is a bid. */
  minBid: number;
  /** Open bidding: how far above the standing bid a raise must go. */
  minIncrement: number;
  /** Seconds a lot stays open. Null is no timer, which is how it runs today. */
  bidTimerSeconds: number | null;
  selectionMode: DraftSelectionMode;
  reserveEnabled: boolean;
  /** How many times a reserve player may come round again. Null is unlimited. */
  reserveRounds: number | null;
  /** Roster size *including* the captain (§14). */
  rosterTarget: number;
  /** §9's blind-bid protection. */
  mustFillRoster: boolean;
  bidVisibility: DraftBidVisibility;
};

/**
 * The rules an event has before anybody configures anything.
 *
 * Deliberately today's draft: uniform balances, sealed bids, a wheel, and only
 * the admin seeing amounts while a lot is live. An event that never opens the
 * Draft tab still runs the draft the community already knows.
 */
export const DEFAULT_DRAFT_CONFIG: DraftConfig = {
  balanceMode: "uniform",
  defaultBalance: 1000,
  biddingMode: "sealed",
  minBid: 0,
  minIncrement: 1,
  bidTimerSeconds: null,
  selectionMode: "wheel",
  reserveEnabled: true,
  reserveRounds: null,
  rosterTarget: 6,
  mustFillRoster: true,
  bidVisibility: "admin_only",
};

/** Teams per event, per §8.1's "2–8". */
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 8;

/** The wheel animation, carried over from the current board unchanged. */
export const SPIN_DURATION_MS = 6500;
export const SPIN_TURNS = 6;

function whole(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function nullableWhole(value: unknown, min: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.trunc(parsed));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const BALANCE_MODES = ["uniform", "per_team"] as const;
const BIDDING_MODES = ["sealed", "open"] as const;
const SELECTION_MODES = ["wheel", "admin_pick", "fixed_order"] as const;
const VISIBILITIES = ["admin_only", "captains", "everyone"] as const;

/**
 * A complete, sane config from whatever the caller has — a database row, a
 * half-filled admin form, or nothing at all.
 *
 * One rule here is a judgement rather than a clamp, and it is worth naming:
 * **open bidding forces at least `captains` visibility.** "Bid at least ten
 * more than the current highest, which you may not see" is not a rule anybody
 * can follow, so the combination is silently upgraded rather than stored as a
 * contradiction the bid panel would have to apologise for. §9 lists the two
 * settings side by side without saying they interact; they do.
 */
export function draftConfigFrom(
  input: Partial<DraftConfig> | null | undefined
): DraftConfig {
  const source = input ?? {};
  const biddingMode = oneOf(source.biddingMode, BIDDING_MODES, DEFAULT_DRAFT_CONFIG.biddingMode);
  const wanted = oneOf(source.bidVisibility, VISIBILITIES, DEFAULT_DRAFT_CONFIG.bidVisibility);

  return {
    balanceMode: oneOf(source.balanceMode, BALANCE_MODES, DEFAULT_DRAFT_CONFIG.balanceMode),
    defaultBalance: whole(source.defaultBalance, DEFAULT_DRAFT_CONFIG.defaultBalance, 0),
    biddingMode,
    minBid: whole(source.minBid, DEFAULT_DRAFT_CONFIG.minBid, 0),
    minIncrement: whole(source.minIncrement, DEFAULT_DRAFT_CONFIG.minIncrement, 1),
    bidTimerSeconds: nullableWhole(source.bidTimerSeconds, 1),
    selectionMode: oneOf(source.selectionMode, SELECTION_MODES, DEFAULT_DRAFT_CONFIG.selectionMode),
    reserveEnabled: source.reserveEnabled ?? DEFAULT_DRAFT_CONFIG.reserveEnabled,
    reserveRounds: nullableWhole(source.reserveRounds, 1),
    rosterTarget: whole(source.rosterTarget, DEFAULT_DRAFT_CONFIG.rosterTarget, 1),
    mustFillRoster: source.mustFillRoster ?? DEFAULT_DRAFT_CONFIG.mustFillRoster,
    bidVisibility:
      biddingMode === "open" && wanted === "admin_only" ? "captains" : wanted,
  };
}

/* ------------------------------------------------------------------ */
/* The shapes the rules run on                                        */
/* ------------------------------------------------------------------ */

/** Just enough of a team to reason about it. */
export type TeamView = {
  id: string;
  name: string;
  captainUserId: string | null;
  balanceStart: number;
  seed: number | null;
  sort: number;
};

/** One roster row. A captain is `isCaptain` with `price` 0 (§14). */
export type TeamMemberView = {
  teamId: string;
  userId: string;
  price: number;
  isCaptain: boolean;
};

/** Just enough of a lot to count money against it. */
export type AwardedLotView = {
  status: DraftLotStatus;
  winnerTeamId: string | null;
  price: number | null;
};

/** One bid, as everything below wants it. */
export type BidView = {
  teamId: string;
  amount: number;
};

/* ------------------------------------------------------------------ */
/* Money and slots                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a team has left, worked out from what it has won.
 *
 * `voided` lots are skipped, which is the whole reason undo can be a status
 * rather than a delete: the row stays, says what was undone, and counts for
 * nothing. Only `awarded` spends money — a discarded or reserved lot never had
 * a price.
 *
 * The result is not clamped at zero. A negative balance means an award went
 * through that should not have, and a screen showing `-40` is a bug report;
 * a screen showing `0` is the same bug, silently.
 */
export function balanceFor(
  team: { id: string; balanceStart: number },
  lots: readonly AwardedLotView[]
): number {
  let spent = 0;
  for (const lot of lots) {
    if (lot.status !== "awarded") continue;
    if (lot.winnerTeamId !== team.id) continue;
    spent += lot.price ?? 0;
  }
  return team.balanceStart - spent;
}

export type RosterState = {
  /** Everybody on the roster, captain included. */
  size: number;
  /** Normally 1. Zero while the admin has not chosen a captain yet. */
  captainCount: number;
  target: number;
  /** Never negative — an over-filled roster has none left, not minus one. */
  slotsLeft: number;
  full: boolean;
  /** True when an admin has put more people on than the target allows. */
  overfilled: boolean;
  /**
   * The least a further player can cost. Zero when the must-fill rule is off,
   * because then nothing needs keeping back.
   */
  minPerSlot: number;
  /** Money this team must still have *after* winning the lot in front of it. */
  reserved: number;
};

/**
 * How full a roster is, and what that costs the team in spending power.
 *
 * `reserved` is the blind-bid protection from §9 expressed as money: after
 * winning the current lot there are `slotsLeft - 1` places to fill, and each of
 * those needs at least `minPerSlot`.
 *
 * ### Why `minPerSlot` has a floor of 1
 *
 * §9 says "must keep enough balance to fill their roster" without saying what a
 * slot is worth. The obvious reading — the configured minimum bid — makes the
 * setting do **nothing at all** on a default event, where the minimum bid is
 * zero and a player can in principle be had for free. A rule that is off
 * whenever it is switched on is worse than no rule, so an unpriced slot is
 * treated as costing 1: enough that a captain can never arrive at the last lot
 * with literally nothing, and small enough that it never surprises anyone.
 */
export function rosterState(
  team: { id: string },
  members: readonly TeamMemberView[],
  config: DraftConfig
): RosterState {
  const mine = members.filter((member) => member.teamId === team.id);
  const size = mine.length;
  const target = config.rosterTarget;
  const slotsLeft = Math.max(0, target - size);
  const minPerSlot = config.mustFillRoster ? Math.max(config.minBid, 1) : 0;

  return {
    size,
    captainCount: mine.filter((member) => member.isCaptain).length,
    target,
    slotsLeft,
    full: size >= target,
    overfilled: size > target,
    minPerSlot,
    reserved: minPerSlot * Math.max(0, slotsLeft - 1),
  };
}

/**
 * The most this team may legally bid on the lot in front of it.
 *
 * With the must-fill rule on, a team with three slots left cannot bid its whole
 * balance: winning takes one slot and the other two still have to be filled, so
 * `minPerSlot` × 2 stays behind. With the rule off it is simply the balance.
 *
 * A full roster gets zero, not the balance — you cannot buy a seventh player
 * for a six-player team however much money is left.
 */
export function maxBidFor(
  team: { balance: number },
  config: DraftConfig,
  roster: RosterState
): number {
  if (roster.slotsLeft <= 0) return 0;
  if (!config.mustFillRoster) return Math.max(0, team.balance);
  return Math.max(0, team.balance - roster.reserved);
}

/* ------------------------------------------------------------------ */
/* Placing a bid                                                      */
/* ------------------------------------------------------------------ */

/** Why a bid was refused. Never a bare `false` — the panel says which. */
export type BidRefusalReason =
  /** Not a whole number, or not a number at all. */
  | "not_a_whole_number"
  | "negative"
  /** Nothing is on the block, or this lot has already settled. */
  | "lot_not_open"
  /** The lot had a timer and it has run out. */
  | "bidding_ended"
  /** Every slot is taken; this team is finished drafting. */
  | "roster_full"
  /** Under the event's minimum bid. */
  | "below_minimum"
  /** Open bidding: not far enough above the standing bid. */
  | "below_increment"
  /** Sealed bidding: one bid per lot, and it is already in. */
  | "already_bid"
  /** More than they have. */
  | "over_balance"
  /** Within the balance, but it would leave the roster unfillable. */
  | "over_roster_cap"
  /** The must-fill rule leaves them unable to meet the minimum at all. */
  | "cannot_afford_minimum";

export type BidCheck =
  | { ok: true; amount: number; max: number }
  | { ok: false; reason: BidRefusalReason; message: string; max: number };

/** Just enough of a lot to decide whether a bid may land on it. */
export type LotBidView = {
  status: DraftLotStatus;
  /** When the lot opened, for the optional timer. */
  openedAt: Date;
  /** Every bid already on this lot, this team's included. */
  bids: readonly BidView[];
};

/** Whether the lot is still accepting bids at `now`. */
export function biddingOpen(lot: LotBidView, config: DraftConfig, now: Date): boolean {
  if (lot.status !== "open") return false;
  if (config.bidTimerSeconds === null) return true;
  return now.getTime() < lot.openedAt.getTime() + config.bidTimerSeconds * 1000;
}

/** When the lot stops taking bids, or null when it has no timer. */
export function bidsCloseAt(lot: LotBidView, config: DraftConfig): Date | null {
  if (config.bidTimerSeconds === null) return null;
  return new Date(lot.openedAt.getTime() + config.bidTimerSeconds * 1000);
}

/** The standing bid from anybody but `teamId`. Zero when there is none. */
function highestFrom(bids: readonly BidView[], exceptTeamId: string): number {
  let highest = 0;
  let seen = false;
  for (const bid of bids) {
    if (bid.teamId === exceptTeamId) continue;
    if (!seen || bid.amount > highest) {
      highest = bid.amount;
      seen = true;
    }
  }
  return seen ? highest : 0;
}

/**
 * May this team bid this much on this lot?
 *
 * The order of the checks is the order a captain would want to be told about
 * them: what is wrong with the number, then what is wrong with the lot, then
 * what is wrong with the roster, then what is wrong with the money. The last
 * two are deliberately distinct — "you cannot afford that" and "you can afford
 * it but then you could not fill your team" are different problems with
 * different fixes, and collapsing them into one message is how a captain ends
 * up believing the board is broken.
 */
export function canPlaceBid(
  team: { id: string; balance: number },
  amount: number,
  lot: LotBidView,
  config: DraftConfig,
  roster: RosterState,
  now: Date = new Date()
): BidCheck {
  const max = maxBidFor(team, config, roster);
  const no = (reason: BidRefusalReason, message: string): BidCheck => ({
    ok: false,
    reason,
    message,
    max,
  });

  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    return no("not_a_whole_number", "A bid has to be a whole number.");
  }
  if (amount < 0) return no("negative", "A bid cannot be negative.");

  if (lot.status !== "open") return no("lot_not_open", "Nobody is on the block right now.");
  if (!biddingOpen(lot, config, now)) {
    return no("bidding_ended", "Bidding on this player has closed.");
  }

  if (roster.slotsLeft <= 0) {
    return no("roster_full", `Your roster is full at ${roster.target}.`);
  }
  if (max < config.minBid) {
    return no(
      "cannot_afford_minimum",
      `You need to keep ${roster.reserved} back to fill your remaining ${roster.slotsLeft - 1} ` +
        `${roster.slotsLeft - 1 === 1 ? "slot" : "slots"}, which leaves you under the minimum bid.`
    );
  }

  const mine = lot.bids.find((bid) => bid.teamId === team.id);
  if (config.biddingMode === "sealed" && mine) {
    return no("already_bid", "You have already bid on this player.");
  }

  if (amount < config.minBid) {
    return no("below_minimum", `The minimum bid is ${config.minBid}.`);
  }

  if (config.biddingMode === "open") {
    const standing = highestFrom(lot.bids, team.id);
    const anyRivals = lot.bids.some((bid) => bid.teamId !== team.id);
    const floor = anyRivals ? standing + config.minIncrement : config.minBid;
    if (amount < floor) {
      return no(
        "below_increment",
        `The bid is ${standing}, so the next one has to be at least ${floor}.`
      );
    }
    if (mine && amount <= mine.amount) {
      return no("below_increment", `You have already bid ${mine.amount}.`);
    }
  }

  if (amount > team.balance) {
    return no("over_balance", `That is over your balance of ${team.balance}.`);
  }
  if (amount > max) {
    return no(
      "over_roster_cap",
      `You can bid at most ${max}: ${roster.reserved} has to stay back to fill your other ` +
        `${roster.slotsLeft - 1} ${roster.slotsLeft - 1 === 1 ? "slot" : "slots"}.`
    );
  }

  return { ok: true, amount, max };
}

/* ------------------------------------------------------------------ */
/* Settling a lot                                                     */
/* ------------------------------------------------------------------ */

export type LotResolution =
  /** Nobody bid. The lot can only be discarded or reserved. */
  | { kind: "none" }
  | {
      kind: "winner";
      teamId: string;
      amount: number;
      /** Somebody else bid too. */
      contested: boolean;
      /** The next distinct amount down, or null when there was only one bid. */
      runnerUp: number | null;
    }
  /** Two or more identical top bids. An admin decides; nothing here does. */
  | { kind: "tie"; amount: number; teamIds: string[] };

/**
 * Who won — or that nobody has, yet.
 *
 * Highest wins, and a bid of zero is still a bid: the current board lets a
 * captain claim an unwanted player for nothing, and that is a feature of a
 * draft where the last few names go cheap.
 *
 * An equal highest is **not** resolved. Earliest-bid-wins would reward a fast
 * connection, and a random pick would be a decision nobody in the room saw
 * being made. §9 does not say what to do, so this says what happened and the
 * admin says what happens next.
 */
export function resolveLot(bids: readonly BidView[]): LotResolution {
  if (bids.length === 0) return { kind: "none" };

  let top = bids[0].amount;
  for (const bid of bids) if (bid.amount > top) top = bid.amount;

  const leaders = bids.filter((bid) => bid.amount === top);
  if (leaders.length > 1) {
    return {
      kind: "tie",
      amount: top,
      teamIds: leaders.map((bid) => bid.teamId).sort(),
    };
  }

  const below = bids.filter((bid) => bid.amount < top).map((bid) => bid.amount);
  return {
    kind: "winner",
    teamId: leaders[0].teamId,
    amount: top,
    contested: bids.length > 1,
    runnerUp: below.length > 0 ? Math.max(...below) : null,
  };
}

/** Has every team that still *can* bid done so? The admin's "all in" light. */
export function allBidsIn(
  teams: ReadonlyArray<{ id: string; roster: RosterState }>,
  bids: readonly BidView[]
): boolean {
  const bidders = new Set(bids.map((bid) => bid.teamId));
  const eligible = teams.filter((team) => team.roster.slotsLeft > 0);
  if (eligible.length === 0) return false;
  return eligible.every((team) => bidders.has(team.id));
}

/* ------------------------------------------------------------------ */
/* Is the draft over?                                                 */
/* ------------------------------------------------------------------ */

export type PoolCounts = { main: number; reserve: number };

export type DraftCompletion = {
  complete: boolean;
  reason: "rosters_full" | "pool_empty" | "both" | "in_progress";
  /** Teams still short of the target, and by how much. */
  short: Array<{ teamId: string; slotsLeft: number }>;
  /** Players still waiting, counting the reserve pool only when it is on. */
  playersLeft: number;
};

/**
 * Whether there is anything left to draft.
 *
 * Two ways to finish and they are not the same: every roster full is the happy
 * one, and an empty pool with teams still short is the one an admin needs
 * telling about — hence `short`, so the screen can say "Team C is two players
 * light" rather than just going quiet.
 *
 * The reserve pool only counts when it is switched on. Names sitting in a
 * disabled reserve pool are out of the draft, not waiting in it.
 */
export function draftComplete(
  pools: PoolCounts,
  teams: ReadonlyArray<{ id: string; members: readonly TeamMemberView[] }>,
  config: DraftConfig
): DraftCompletion {
  const short: Array<{ teamId: string; slotsLeft: number }> = [];
  for (const team of teams) {
    const roster = rosterState(team, team.members, config);
    if (roster.slotsLeft > 0) short.push({ teamId: team.id, slotsLeft: roster.slotsLeft });
  }

  const playersLeft = pools.main + (config.reserveEnabled ? pools.reserve : 0);
  const rostersFull = teams.length > 0 && short.length === 0;
  const poolEmpty = playersLeft === 0;

  const reason: DraftCompletion["reason"] = rostersFull
    ? poolEmpty
      ? "both"
      : "rosters_full"
    : poolEmpty
      ? "pool_empty"
      : "in_progress";

  return { complete: rostersFull || poolEmpty, reason, short, playersLeft };
}

/* ------------------------------------------------------------------ */
/* Who sees what (§11)                                                */
/* ------------------------------------------------------------------ */

/**
 * The four people looking at a draft room.
 *
 * `player` and `observer` see the same *amounts* — which is to say none — but
 * they are not the same viewer: a player is in this draft and the room shows
 * them where they stand, whereas an observer is watching somebody else's.
 */
export type DraftRole = "admin" | "captain" | "player" | "observer";

export type DraftViewer = {
  role: DraftRole;
  userId: string | null;
  /** The team this viewer captains. Null for everybody else. */
  teamId: string | null;
};

export type DraftPhase = "idle" | "spinning" | "bidding" | "resolved";

/** A team as the room sees it, before redaction. */
export type TeamStanding = TeamView & {
  balance: number;
  roster: RosterState;
  members: TeamMemberView[];
  /** The most they could bid on the open lot. */
  maxBid: number;
  /** Their bid on the open lot, if they have one. */
  bid: number | null;
};

export type PoolPlayer = { userId: string; kind: DraftPoolKind; sort: number };

/** A lot that has settled — award, discard, reserve, or an undone one. */
export type SettledLot = {
  id: string;
  playerUserId: string;
  status: DraftLotStatus;
  fromKind: DraftPoolKind;
  winnerTeamId: string | null;
  price: number | null;
  closedAt: number | null;
  voidedAt: number | null;
};

/** The lot on the block. */
export type OpenLot = {
  id: string;
  playerUserId: string;
  fromKind: DraftPoolKind;
  openedAt: number;
  spin: DraftSpin | null;
  bids: Array<BidView & { placedAt: number }>;
  /** Null when there is no timer. */
  endsAt: number | null;
};

/** Everything the room could show, before anything is hidden. */
export type DraftSnapshot = {
  now: number;
  config: DraftConfig;
  teams: TeamStanding[];
  lot: OpenLot | null;
  /** Newest first — the full record, because prices are the point. */
  history: SettledLot[];
  pools: { main: PoolPlayer[]; reserve: PoolPlayer[] };
  /** The pool the next spin comes from. */
  activeKind: DraftPoolKind;
  completion: DraftCompletion;
};

/** A team as one particular viewer is allowed to see it. */
export type TeamCard = TeamView & {
  balance: number;
  roster: RosterState;
  members: TeamMemberView[];
  /** Always true, for everyone: *that* a team has bid is never secret. */
  hasBid: boolean;
  /** The amount, or null when this viewer may not see it yet. */
  bid: number | null;
  /** Their cap, when this viewer is entitled to know it. */
  maxBid: number | null;
};

export type DraftView = {
  now: number;
  role: DraftRole;
  phase: DraftPhase;
  config: DraftConfig;
  teams: TeamCard[];
  lot: {
    id: string;
    /** Withheld while the wheel is still turning — for everyone alike. */
    playerUserId: string | null;
    fromKind: DraftPoolKind;
    openedAt: number;
    spin: DraftSpin | null;
    endsAt: number | null;
    /** How many teams have bid. Public; the amounts are not. */
    bidCount: number;
    allBidsIn: boolean;
    /** Admin only while the lot is live: who is winning, or that it is tied. */
    resolution: LotResolution | null;
  } | null;
  history: SettledLot[];
  /** The names on the wheel everyone is looking at. */
  activePool: PoolPlayer[];
  activeKind: DraftPoolKind;
  /** Admin only: both lists, including the reserve pool while it is hidden. */
  mainPool: PoolPlayer[] | null;
  reservePool: PoolPlayer[] | null;
  mainPoolCount: number;
  reservePoolCount: number;
  completion: DraftCompletion;
  /** Where this viewer stands in this draft. */
  you: {
    userId: string | null;
    teamId: string | null;
    /** Which pool they are sitting in, if they are in one. */
    inPool: DraftPoolKind | null;
    /**
     * True when this viewer may place a bid on the open lot *right now* —
     * so false for anyone who is not a captain, false once a sealed bid is
     * already in, and false while the wheel is still turning.
     */
    canBid: boolean;
    /** Their own cap, when they have one. */
    maxBid: number | null;
  };
};

/** Is the wheel still turning at `now`? */
export function spinning(spin: DraftSpin | null, now: number): boolean {
  if (!spin) return false;
  return now < spin.startedAt + spin.durationMs;
}

/** The four states the current board already has, on the new shape. */
export function phaseOf(snapshot: {
  lot: OpenLot | null;
  history: readonly SettledLot[];
  now: number;
}): DraftPhase {
  if (snapshot.lot && spinning(snapshot.lot.spin, snapshot.now)) return "spinning";
  if (snapshot.lot) return "bidding";
  if (snapshot.history.length > 0) return "resolved";
  return "idle";
}

/** May this viewer see this team's live bid amount? */
function seesAmount(viewer: DraftViewer, teamId: string, config: DraftConfig): boolean {
  if (viewer.role === "admin") return true;
  if (viewer.teamId !== null && viewer.teamId === teamId) return true;
  if (config.bidVisibility === "everyone") return true;
  if (config.bidVisibility === "captains" && viewer.role === "captain") return true;
  return false;
}

/**
 * One snapshot, redacted for one viewer.
 *
 * This is the current board's `toView` reimplemented on the new shape, and the
 * behaviour it protects is exactly the behaviour that file's tests pin down:
 *
 *  - the **admin** sees every amount, live, and both pools;
 *  - a **captain** sees their own amount and nobody else's;
 *  - a **player** and an **observer** see no amounts at all;
 *  - *that* a team has bid is public to everyone — only the number is secret;
 *  - once a lot settles, the **winning amount is public**, permanently, under
 *    every visibility setting, because a draft whose prices are secret
 *    afterwards is not a draft anyone would run;
 *  - while the wheel is turning the player's name is withheld from *everyone*,
 *    including the admin, so the animation reveals it at the same instant in
 *    every browser.
 *
 * §9's visibility setting only widens the first three. It cannot narrow the
 * settled history, and it never hides a team's own bid from itself.
 */
export function redactDraft(snapshot: DraftSnapshot, viewer: DraftViewer): DraftView {
  const isAdmin = viewer.role === "admin";
  const config = snapshot.config;
  const phase = phaseOf(snapshot);

  const teams: TeamCard[] = snapshot.teams.map((team) => ({
    id: team.id,
    name: team.name,
    captainUserId: team.captainUserId,
    balanceStart: team.balanceStart,
    seed: team.seed,
    sort: team.sort,
    balance: team.balance,
    roster: team.roster,
    members: team.members,
    hasBid: team.bid !== null,
    bid: seesAmount(viewer, team.id, config) ? team.bid : null,
    maxBid: isAdmin || viewer.teamId === team.id ? team.maxBid : null,
  }));

  const mine = snapshot.teams.find((team) => team.id === viewer.teamId) ?? null;
  const inPool =
    viewer.userId === null
      ? null
      : (snapshot.pools.main.find((entry) => entry.userId === viewer.userId)?.kind ??
        snapshot.pools.reserve.find((entry) => entry.userId === viewer.userId)?.kind ??
        null);

  const activePool =
    snapshot.activeKind === "reserve" ? snapshot.pools.reserve : snapshot.pools.main;

  const lot = snapshot.lot;
  const stillSpinning = lot ? spinning(lot.spin, snapshot.now) : false;

  return {
    now: snapshot.now,
    role: viewer.role,
    phase,
    config,
    teams,
    lot: lot
      ? {
          id: lot.id,
          playerUserId: stillSpinning ? null : lot.playerUserId,
          fromKind: lot.fromKind,
          openedAt: lot.openedAt,
          spin: lot.spin,
          endsAt: lot.endsAt,
          bidCount: lot.bids.length,
          allBidsIn: allBidsIn(snapshot.teams, lot.bids),
          resolution: isAdmin ? resolveLot(lot.bids) : null,
        }
      : null,
    history: snapshot.history,
    activePool,
    activeKind: snapshot.activeKind,
    mainPool: isAdmin ? snapshot.pools.main : null,
    reservePool: isAdmin ? snapshot.pools.reserve : null,
    mainPoolCount: snapshot.pools.main.length,
    reservePoolCount: snapshot.pools.reserve.length,
    completion: snapshot.completion,
    you: {
      userId: viewer.userId,
      teamId: viewer.teamId,
      inPool,
      canBid:
        viewer.role === "captain" &&
        mine !== null &&
        lot !== null &&
        !stillSpinning &&
        canPlaceBid(
          { id: mine.id, balance: mine.balance },
          Math.max(config.minBid, 0),
          {
            status: "open",
            openedAt: new Date(lot.openedAt),
            bids: lot.bids,
          },
          config,
          mine.roster,
          new Date(snapshot.now)
        ).ok,
      maxBid: mine ? mine.maxBid : null,
    },
  };
}
