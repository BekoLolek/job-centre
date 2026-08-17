import { describe, expect, it } from "vitest";
import type { DraftSpin } from "@/db/schema";
import {
  type AwardedLotView,
  type BidView,
  type DraftConfig,
  type DraftSnapshot,
  type DraftViewer,
  type OpenLot,
  type PoolPlayer,
  type SettledLot,
  type TeamMemberView,
  type TeamStanding,
  DEFAULT_DRAFT_CONFIG,
  SPIN_DURATION_MS,
  allBidsIn,
  balanceFor,
  bidsCloseAt,
  biddingOpen,
  canPlaceBid,
  draftComplete,
  draftConfigFrom,
  maxBidFor,
  phaseOf,
  redactDraft,
  resolveLot,
  rosterState,
  spinning,
} from "@/lib/draft-policy";

const T0 = 1_700_000_000_000;

function config(over: Partial<DraftConfig> = {}): DraftConfig {
  return draftConfigFrom({ ...DEFAULT_DRAFT_CONFIG, ...over });
}

/** A roster of `size` people, the first of whom is the captain. */
function roster(teamId: string, size: number, price = 100): TeamMemberView[] {
  return Array.from({ length: size }, (_unused, index) => ({
    teamId,
    userId: `${teamId}-p${index}`,
    price: index === 0 ? 0 : price,
    isCaptain: index === 0,
  }));
}

function awarded(teamId: string | null, price: number | null): AwardedLotView {
  return { status: "awarded", winnerTeamId: teamId, price };
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

describe("draftConfigFrom", () => {
  it("gives an unconfigured event today's draft", () => {
    expect(draftConfigFrom(null)).toEqual(DEFAULT_DRAFT_CONFIG);
    expect(draftConfigFrom(undefined)).toEqual(DEFAULT_DRAFT_CONFIG);
    expect(draftConfigFrom({})).toEqual(DEFAULT_DRAFT_CONFIG);
  });

  it("keeps every setting it is given", () => {
    const wanted: DraftConfig = {
      balanceMode: "per_team",
      defaultBalance: 250,
      biddingMode: "open",
      minBid: 10,
      minIncrement: 5,
      bidTimerSeconds: 30,
      selectionMode: "admin_pick",
      reserveEnabled: false,
      reserveRounds: 2,
      rosterTarget: 5,
      mustFillRoster: false,
      bidVisibility: "everyone",
    };
    expect(draftConfigFrom(wanted)).toEqual(wanted);
  });

  it("clamps the numbers that cannot sensibly be small", () => {
    const clamped = draftConfigFrom({
      defaultBalance: -50,
      minBid: -1,
      minIncrement: 0,
      rosterTarget: 0,
    });
    expect(clamped.defaultBalance).toBe(0);
    expect(clamped.minBid).toBe(0);
    expect(clamped.minIncrement).toBe(1);
    expect(clamped.rosterTarget).toBe(1);
  });

  it("truncates fractions rather than storing a fractional roster", () => {
    expect(draftConfigFrom({ rosterTarget: 6.9, minBid: 12.7 })).toMatchObject({
      rosterTarget: 6,
      minBid: 12,
    });
  });

  it("treats a nonsense enum as the default rather than trusting it", () => {
    const junk = draftConfigFrom({
      biddingMode: "shouting" as DraftConfig["biddingMode"],
      selectionMode: "vibes" as DraftConfig["selectionMode"],
    });
    expect(junk.biddingMode).toBe("sealed");
    expect(junk.selectionMode).toBe("wheel");
  });

  it("refuses to leave open bidding with hidden amounts", () => {
    // "Bid ten more than a number you cannot see" is not a rule anyone can
    // follow, so the combination is upgraded rather than stored.
    expect(draftConfigFrom({ biddingMode: "open" }).bidVisibility).toBe("captains");
    expect(
      draftConfigFrom({ biddingMode: "open", bidVisibility: "everyone" }).bidVisibility
    ).toBe("everyone");
    expect(
      draftConfigFrom({ biddingMode: "sealed", bidVisibility: "admin_only" }).bidVisibility
    ).toBe("admin_only");
  });

  it("keeps null timers and reserve rounds null", () => {
    expect(draftConfigFrom({ bidTimerSeconds: null }).bidTimerSeconds).toBeNull();
    expect(draftConfigFrom({ reserveRounds: null }).reserveRounds).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Money                                                              */
/* ------------------------------------------------------------------ */

describe("balanceFor", () => {
  const team = { id: "t1", balanceStart: 1000 };

  it("is the starting balance when nothing has been won", () => {
    expect(balanceFor(team, [])).toBe(1000);
  });

  it("subtracts every awarded lot this team won", () => {
    expect(balanceFor(team, [awarded("t1", 120), awarded("t1", 80)])).toBe(800);
  });

  it("ignores lots another team won", () => {
    expect(balanceFor(team, [awarded("t2", 500)])).toBe(1000);
  });

  it("ignores discarded and reserved lots, which never had a price", () => {
    const lots: AwardedLotView[] = [
      { status: "discarded", winnerTeamId: null, price: null },
      { status: "reserved", winnerTeamId: null, price: null },
      { status: "open", winnerTeamId: null, price: null },
    ];
    expect(balanceFor(team, lots)).toBe(1000);
  });

  it("gives the money back the moment a lot is voided", () => {
    const spent: AwardedLotView[] = [awarded("t1", 300)];
    expect(balanceFor(team, spent)).toBe(700);

    // An undo flips the status and keeps the winner and the price, so the
    // history still says what happened and the balance no longer counts it.
    const undone: AwardedLotView[] = [{ status: "voided", winnerTeamId: "t1", price: 300 }];
    expect(balanceFor(team, undone)).toBe(1000);
  });

  it("reports a negative balance rather than hiding one", () => {
    expect(balanceFor(team, [awarded("t1", 1500)])).toBe(-500);
  });
});

describe("rosterState", () => {
  it("counts the captain as a roster slot (§14)", () => {
    const state = rosterState({ id: "t1" }, roster("t1", 1), config());
    expect(state.size).toBe(1);
    expect(state.captainCount).toBe(1);
    expect(state.slotsLeft).toBe(5);
    expect(state.full).toBe(false);
  });

  it("ignores members of other teams", () => {
    const members = [...roster("t1", 2), ...roster("t2", 4)];
    expect(rosterState({ id: "t1" }, members, config()).size).toBe(2);
  });

  it("is full at the target and never reports negative slots", () => {
    const full = rosterState({ id: "t1" }, roster("t1", 6), config());
    expect(full).toMatchObject({ full: true, slotsLeft: 0, overfilled: false });

    const over = rosterState({ id: "t1" }, roster("t1", 8), config());
    expect(over).toMatchObject({ full: true, slotsLeft: 0, overfilled: true });
  });

  it("reserves the minimum bid for each slot beyond the one being bid on", () => {
    // Three slots left: winning takes one, two remain at 50 apiece.
    const state = rosterState({ id: "t1" }, roster("t1", 3), config({ minBid: 50 }));
    expect(state.slotsLeft).toBe(3);
    expect(state.minPerSlot).toBe(50);
    expect(state.reserved).toBe(100);
  });

  it("treats an unpriced slot as costing one, so the rule is never a no-op", () => {
    const state = rosterState({ id: "t1" }, roster("t1", 3), config({ minBid: 0 }));
    expect(state.minPerSlot).toBe(1);
    expect(state.reserved).toBe(2);
  });

  it("reserves nothing when the must-fill rule is off", () => {
    const state = rosterState({ id: "t1" }, roster("t1", 3), config({ mustFillRoster: false }));
    expect(state.minPerSlot).toBe(0);
    expect(state.reserved).toBe(0);
  });

  it("reserves nothing on the last slot, since there is nothing left to fill", () => {
    const state = rosterState({ id: "t1" }, roster("t1", 5), config({ minBid: 50 }));
    expect(state.slotsLeft).toBe(1);
    expect(state.reserved).toBe(0);
  });
});

describe("maxBidFor — the blind-bid protection", () => {
  it("keeps one back per unfilled slot on a default event", () => {
    const state = rosterState({ id: "t1" }, roster("t1", 3), config());
    expect(state.slotsLeft).toBe(3);
    expect(maxBidFor({ balance: 1000 }, config(), state)).toBe(998);
  });

  it("is exact at the boundary", () => {
    const cfg = config({ minBid: 50 });
    const three = rosterState({ id: "t1" }, roster("t1", 3), cfg);
    // 1000 - (3 - 1) x 50
    expect(maxBidFor({ balance: 1000 }, cfg, three)).toBe(900);

    const one = rosterState({ id: "t1" }, roster("t1", 5), cfg);
    expect(maxBidFor({ balance: 1000 }, cfg, one)).toBe(1000);
  });

  it("lets a team spend everything on its final slot", () => {
    const cfg = config();
    const last = rosterState({ id: "t1" }, roster("t1", 5), cfg);
    expect(maxBidFor({ balance: 640 }, cfg, last)).toBe(640);
  });

  it("is the whole balance when the rule is switched off", () => {
    const cfg = config({ mustFillRoster: false });
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(maxBidFor({ balance: 1000 }, cfg, state)).toBe(1000);
  });

  it("is zero for a full roster, whatever the money says", () => {
    const cfg = config();
    const full = rosterState({ id: "t1" }, roster("t1", 6), cfg);
    expect(maxBidFor({ balance: 900 }, cfg, full)).toBe(0);
  });

  it("never goes below zero when the reserve is more than the balance", () => {
    const cfg = config({ minBid: 500 });
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(state.reserved).toBe(2000);
    expect(maxBidFor({ balance: 100 }, cfg, state)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Placing a bid                                                      */
/* ------------------------------------------------------------------ */

describe("canPlaceBid", () => {
  const NOW = new Date(T0);

  function lot(bids: BidView[] = [], over: { status?: "open" | "awarded" } = {}) {
    return {
      status: over.status ?? ("open" as const),
      openedAt: new Date(T0 - 1000),
      bids,
    };
  }

  function team(balance = 1000) {
    return { id: "t1", balance };
  }

  it("accepts a bid inside the cap", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    const check = canPlaceBid(team(), 400, lot(), cfg, state, NOW);
    expect(check).toMatchObject({ ok: true, amount: 400, max: 996 });
  });

  it("accepts exactly the cap and refuses one more", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 3), cfg);
    expect(canPlaceBid(team(), 998, lot(), cfg, state, NOW).ok).toBe(true);

    const over = canPlaceBid(team(), 999, lot(), cfg, state, NOW);
    expect(over).toMatchObject({ ok: false, reason: "over_roster_cap", max: 998 });
    expect(over.ok === false && over.message).toMatch(/at most 998/);
  });

  it("separates 'you cannot afford it' from 'then you could not fill your team'", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 3), cfg);
    expect(canPlaceBid(team(100), 150, lot(), cfg, state, NOW)).toMatchObject({
      reason: "over_balance",
    });
    expect(canPlaceBid(team(100), 99, lot(), cfg, state, NOW)).toMatchObject({
      reason: "over_roster_cap",
    });
  });

  it("refuses a bid that is not a whole number", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(canPlaceBid(team(), 10.5, lot(), cfg, state, NOW)).toMatchObject({
      reason: "not_a_whole_number",
    });
    expect(canPlaceBid(team(), Number.NaN, lot(), cfg, state, NOW)).toMatchObject({
      reason: "not_a_whole_number",
    });
    expect(canPlaceBid(team(), -1, lot(), cfg, state, NOW)).toMatchObject({
      reason: "negative",
    });
  });

  it("refuses a bid on a lot that has already settled", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(
      canPlaceBid(team(), 10, lot([], { status: "awarded" }), cfg, state, NOW)
    ).toMatchObject({ reason: "lot_not_open" });
  });

  it("refuses a bid once the timer has run out, and allows one on the last second", () => {
    const cfg = config({ bidTimerSeconds: 30 });
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    const opened = { status: "open" as const, openedAt: new Date(T0), bids: [] };

    expect(canPlaceBid(team(), 10, opened, cfg, state, new Date(T0 + 29_999)).ok).toBe(true);
    expect(canPlaceBid(team(), 10, opened, cfg, state, new Date(T0 + 30_000))).toMatchObject({
      reason: "bidding_ended",
    });
  });

  it("refuses a bid from a team with no slots left", () => {
    const cfg = config();
    const full = rosterState({ id: "t1" }, roster("t1", 6), cfg);
    expect(canPlaceBid(team(), 0, lot(), cfg, full, NOW)).toMatchObject({
      reason: "roster_full",
      max: 0,
    });
  });

  it("refuses a second sealed bid rather than letting it be revised", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    const check = canPlaceBid(team(), 200, lot([{ teamId: "t1", amount: 100 }]), cfg, state, NOW);
    expect(check).toMatchObject({ reason: "already_bid" });
  });

  it("takes a bid of zero, because the last few names go cheap", () => {
    const cfg = config();
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(canPlaceBid(team(), 0, lot(), cfg, state, NOW).ok).toBe(true);
  });

  it("enforces a minimum bid when the event sets one", () => {
    const cfg = config({ minBid: 25 });
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);
    expect(canPlaceBid(team(), 24, lot(), cfg, state, NOW)).toMatchObject({
      reason: "below_minimum",
    });
    expect(canPlaceBid(team(), 25, lot(), cfg, state, NOW).ok).toBe(true);
  });

  it("says so when the must-fill rule leaves a team unable to meet the minimum", () => {
    const cfg = config({ minBid: 100 });
    const state = rosterState({ id: "t1" }, roster("t1", 2), cfg);
    // Four slots left: 300 has to stay back, and 350 - 300 = 50 is under 100.
    expect(canPlaceBid(team(350), 100, lot(), cfg, state, NOW)).toMatchObject({
      reason: "cannot_afford_minimum",
    });
  });

  describe("open bidding", () => {
    const cfg = config({ biddingMode: "open", minIncrement: 10 });
    const state = rosterState({ id: "t1" }, roster("t1", 1), cfg);

    it("lets the first bid be the minimum", () => {
      expect(canPlaceBid(team(), 0, lot(), cfg, state, NOW).ok).toBe(true);
    });

    it("makes a raise clear the standing bid by the increment", () => {
      const standing = lot([{ teamId: "t2", amount: 100 }]);
      expect(canPlaceBid(team(), 109, standing, cfg, state, NOW)).toMatchObject({
        reason: "below_increment",
      });
      expect(canPlaceBid(team(), 110, standing, cfg, state, NOW).ok).toBe(true);
    });

    it("lets the same team raise its own bid, but not lower it", () => {
      const mine = lot([
        { teamId: "t1", amount: 100 },
        { teamId: "t2", amount: 150 },
      ]);
      expect(canPlaceBid(team(), 160, mine, cfg, state, NOW).ok).toBe(true);
      expect(canPlaceBid(team(), 100, mine, cfg, state, NOW)).toMatchObject({
        reason: "below_increment",
      });
    });

    it("ignores the team's own bid when working out the standing one", () => {
      const onlyMine = lot([{ teamId: "t1", amount: 500 }]);
      // Nobody else has bid, so the floor is the minimum, not 510 — but it
      // still has to beat their own 500.
      expect(canPlaceBid(team(), 501, onlyMine, cfg, state, NOW).ok).toBe(true);
      expect(canPlaceBid(team(), 400, onlyMine, cfg, state, NOW)).toMatchObject({
        reason: "below_increment",
      });
    });
  });
});

describe("biddingOpen / bidsCloseAt", () => {
  const cfg = config({ bidTimerSeconds: 60 });
  const lot = { status: "open" as const, openedAt: new Date(T0), bids: [] };

  it("has no deadline without a timer", () => {
    expect(bidsCloseAt(lot, config())).toBeNull();
    expect(biddingOpen(lot, config(), new Date(T0 + 10 ** 9))).toBe(true);
  });

  it("closes the timer exactly on the second", () => {
    expect(bidsCloseAt(lot, cfg)?.getTime()).toBe(T0 + 60_000);
    expect(biddingOpen(lot, cfg, new Date(T0 + 59_999))).toBe(true);
    expect(biddingOpen(lot, cfg, new Date(T0 + 60_000))).toBe(false);
  });

  it("is closed once the lot has settled, timer or not", () => {
    const settled = { ...lot, status: "awarded" as const };
    expect(biddingOpen(settled, config(), new Date(T0))).toBe(false);
  });

  // Nobody can bid on a name they cannot see yet, so the clock starts when the
  // wheel stops. Measured from openedAt, a 60s timer on a 6.5s spin is a 53.5s
  // timer, and the captains only find that out live.
  it("starts the timer when the wheel stops, not when the lot opened", () => {
    const spun = {
      ...lot,
      spin: {
        pool: ["a", "b"],
        targetIndex: 1,
        startedAt: T0,
        durationMs: SPIN_DURATION_MS,
        turns: 6,
      },
    };
    expect(bidsCloseAt(spun, cfg)?.getTime()).toBe(T0 + SPIN_DURATION_MS + 60_000);
    expect(biddingOpen(spun, cfg, new Date(T0 + 60_000))).toBe(true);
    expect(biddingOpen(spun, cfg, new Date(T0 + SPIN_DURATION_MS + 59_999))).toBe(true);
    expect(biddingOpen(spun, cfg, new Date(T0 + SPIN_DURATION_MS + 60_000))).toBe(false);
  });

  it("ignores a spin that somehow finished before the lot opened", () => {
    const stale = {
      ...lot,
      spin: { pool: ["a"], targetIndex: 0, startedAt: T0 - 60_000, durationMs: 1000, turns: 6 },
    };
    expect(bidsCloseAt(stale, cfg)?.getTime()).toBe(T0 + 60_000);
  });
});

/* ------------------------------------------------------------------ */
/* Settling                                                           */
/* ------------------------------------------------------------------ */

describe("resolveLot", () => {
  it("says nothing happened when nobody bid", () => {
    expect(resolveLot([])).toEqual({ kind: "none" });
  });

  it("gives it to the highest bid", () => {
    expect(
      resolveLot([
        { teamId: "t1", amount: 120 },
        { teamId: "t2", amount: 45 },
      ])
    ).toEqual({ kind: "winner", teamId: "t1", amount: 120, contested: true, runnerUp: 45 });
  });

  it("has no runner-up when only one team bid", () => {
    expect(resolveLot([{ teamId: "t1", amount: 10 }])).toEqual({
      kind: "winner",
      teamId: "t1",
      amount: 10,
      contested: false,
      runnerUp: null,
    });
  });

  it("treats a single bid of zero as a win", () => {
    expect(resolveLot([{ teamId: "t1", amount: 0 }])).toMatchObject({
      kind: "winner",
      amount: 0,
    });
  });

  it("refuses to break a tie", () => {
    expect(
      resolveLot([
        { teamId: "t2", amount: 200 },
        { teamId: "t1", amount: 200 },
        { teamId: "t3", amount: 50 },
      ])
    ).toEqual({ kind: "tie", amount: 200, teamIds: ["t1", "t2"] });
  });

  it("calls three identical bids a tie between all three", () => {
    const tied = resolveLot([
      { teamId: "a", amount: 5 },
      { teamId: "b", amount: 5 },
      { teamId: "c", amount: 5 },
    ]);
    expect(tied).toMatchObject({ kind: "tie", teamIds: ["a", "b", "c"] });
  });

  it("ties on zero as readily as on anything else", () => {
    expect(
      resolveLot([
        { teamId: "a", amount: 0 },
        { teamId: "b", amount: 0 },
      ])
    ).toMatchObject({ kind: "tie", amount: 0 });
  });
});

describe("allBidsIn", () => {
  const cfg = config();
  const open = { id: "t1", roster: rosterState({ id: "t1" }, roster("t1", 1), cfg) };
  const other = { id: "t2", roster: rosterState({ id: "t2" }, roster("t2", 1), cfg) };
  const done = { id: "t3", roster: rosterState({ id: "t3" }, roster("t3", 6), cfg) };

  it("is false while anybody who can bid has not", () => {
    expect(allBidsIn([open, other], [{ teamId: "t1", amount: 1 }])).toBe(false);
  });

  it("is true once everybody who can bid has, including zero bids", () => {
    expect(
      allBidsIn(
        [open, other],
        [
          { teamId: "t1", amount: 0 },
          { teamId: "t2", amount: 0 },
        ]
      )
    ).toBe(true);
  });

  it("does not wait on a team whose roster is already full", () => {
    expect(allBidsIn([open, done], [{ teamId: "t1", amount: 10 }])).toBe(true);
  });

  it("is false when no team can bid at all, rather than vacuously true", () => {
    expect(allBidsIn([done], [])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Completion                                                         */
/* ------------------------------------------------------------------ */

describe("draftComplete", () => {
  const cfg = config({ rosterTarget: 3 });

  function team(id: string, size: number) {
    return { id, members: roster(id, size) };
  }

  it("is not complete while rosters are short and players are waiting", () => {
    const done = draftComplete({ main: 4, reserve: 0 }, [team("t1", 1), team("t2", 1)], cfg);
    expect(done).toMatchObject({ complete: false, reason: "in_progress", playersLeft: 4 });
    expect(done.short).toEqual([
      { teamId: "t1", slotsLeft: 2 },
      { teamId: "t2", slotsLeft: 2 },
    ]);
  });

  it("is complete once every roster is full, even with names left over", () => {
    const done = draftComplete({ main: 3, reserve: 0 }, [team("t1", 3), team("t2", 3)], cfg);
    expect(done).toMatchObject({ complete: true, reason: "rosters_full", short: [] });
  });

  it("is complete with an empty pool, and says who is short", () => {
    const done = draftComplete({ main: 0, reserve: 0 }, [team("t1", 3), team("t2", 1)], cfg);
    expect(done).toMatchObject({ complete: true, reason: "pool_empty" });
    expect(done.short).toEqual([{ teamId: "t2", slotsLeft: 2 }]);
  });

  it("reports both when the pool empties on the last pick", () => {
    expect(
      draftComplete({ main: 0, reserve: 0 }, [team("t1", 3)], cfg).reason
    ).toBe("both");
  });

  it("counts the reserve pool only when the reserve pool is switched on", () => {
    const teams = [team("t1", 1)];
    expect(draftComplete({ main: 0, reserve: 3 }, teams, cfg).playersLeft).toBe(3);
    expect(
      draftComplete({ main: 0, reserve: 3 }, teams, config({ rosterTarget: 3, reserveEnabled: false }))
        .playersLeft
    ).toBe(0);
  });

  it("is not 'rosters full' when there are no teams at all", () => {
    expect(draftComplete({ main: 5, reserve: 0 }, [], cfg)).toMatchObject({
      complete: false,
      reason: "in_progress",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Redaction (§11)                                                    */
/* ------------------------------------------------------------------ */

describe("redactDraft", () => {
  const cfg = config();

  function standing(id: string, over: Partial<TeamStanding> = {}): TeamStanding {
    const members = roster(id, 1);
    const state = rosterState({ id }, members, cfg);
    return {
      id,
      name: id.toUpperCase(),
      captainUserId: `${id}-p0`,
      balanceStart: 1000,
      seed: null,
      sort: 0,
      balance: 1000,
      roster: state,
      members,
      maxBid: maxBidFor({ balance: 1000 }, cfg, state),
      bid: null,
      ...over,
    };
  }

  function spin(over: Partial<DraftSpin> = {}): DraftSpin {
    return {
      pool: ["nova", "rook", "sable"],
      targetIndex: 1,
      startedAt: T0,
      durationMs: SPIN_DURATION_MS,
      turns: 6,
      ...over,
    };
  }

  function pool(userIds: string[], kind: "main" | "reserve" = "main"): PoolPlayer[] {
    return userIds.map((userId, sort) => ({ userId, kind, sort }));
  }

  function snapshot(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
    const teams = [
      standing("t1", { bid: 120 }),
      standing("t2", { bid: 45 }),
      standing("t3"),
      standing("t4"),
    ];
    const lot: OpenLot = {
      id: "lot-1",
      playerUserId: "rook",
      fromKind: "main",
      openedAt: T0,
      spin: null,
      bids: [
        { teamId: "t1", amount: 120, placedAt: T0 + 1 },
        { teamId: "t2", amount: 45, placedAt: T0 + 2 },
      ],
      endsAt: null,
    };
    const history: SettledLot[] = [
      {
        id: "lot-0",
        playerUserId: "nova",
        status: "awarded",
        fromKind: "main",
        winnerTeamId: "t1",
        price: 300,
        closedAt: T0 - 1000,
        voidedAt: null,
      },
    ];
    return {
      now: T0 + SPIN_DURATION_MS + 1,
      config: cfg,
      teams,
      lot,
      history,
      pools: { main: pool(["rook", "sable"]), reserve: pool(["kite"], "reserve") },
      activeKind: "main",
      completion: draftComplete({ main: 2, reserve: 1 }, teams, cfg),
      ...over,
    };
  }

  const admin: DraftViewer = { role: "admin", userId: "boss", teamId: null };
  const captain: DraftViewer = { role: "captain", userId: "t2-p0", teamId: "t2" };
  const player: DraftViewer = { role: "player", userId: "rook", teamId: null };
  const observer: DraftViewer = { role: "observer", userId: null, teamId: null };

  it("shows the admin every amount and both pools", () => {
    const view = redactDraft(snapshot(), admin);
    expect(view.teams.map((team) => team.bid)).toEqual([120, 45, null, null]);
    expect(view.mainPool?.map((entry) => entry.userId)).toEqual(["rook", "sable"]);
    expect(view.reservePool?.map((entry) => entry.userId)).toEqual(["kite"]);
  });

  it("shows a captain only their own amount, and no pools", () => {
    const view = redactDraft(snapshot(), captain);
    expect(view.teams.map((team) => team.bid)).toEqual([null, 45, null, null]);
    // Who has bid stays public — only the amounts are hidden.
    expect(view.teams.map((team) => team.hasBid)).toEqual([true, true, false, false]);
    expect(view.mainPool).toBeNull();
    expect(view.reservePool).toBeNull();
  });

  it("shows a player no amounts at all, and no pools", () => {
    const view = redactDraft(snapshot(), player);
    expect(view.teams.every((team) => team.bid === null)).toBe(true);
    expect(view.mainPool).toBeNull();
  });

  it("shows an observer no amounts at all, and no pools", () => {
    const view = redactDraft(snapshot(), observer);
    expect(view.teams.every((team) => team.bid === null)).toBe(true);
    expect(view.mainPool).toBeNull();
    expect(view.reservePool).toBeNull();
  });

  it("still reports the pool sizes to everyone", () => {
    for (const viewer of [captain, player, observer]) {
      const view = redactDraft(snapshot(), viewer);
      expect(view.mainPoolCount).toBe(2);
      expect(view.reservePoolCount).toBe(1);
    }
  });

  it("sends the active wheel's names to everyone", () => {
    const reserve = snapshot({ activeKind: "reserve" });
    expect(redactDraft(reserve, observer).activePool.map((entry) => entry.userId)).toEqual([
      "kite",
    ]);
    expect(redactDraft(snapshot(), observer).activePool.map((entry) => entry.userId)).toEqual([
      "rook",
      "sable",
    ]);
  });

  it("makes the settled price public to everyone, forever", () => {
    for (const viewer of [admin, captain, player, observer]) {
      const view = redactDraft(snapshot(), viewer);
      expect(view.history[0]).toMatchObject({ winnerTeamId: "t1", price: 300 });
    }
  });

  it("withholds the player from everyone while the wheel is still turning", () => {
    const mid = snapshot({
      now: T0 + 10,
      lot: { ...snapshot().lot!, spin: spin() },
    });
    for (const viewer of [admin, captain, player, observer]) {
      const view = redactDraft(mid, viewer);
      expect(view.phase).toBe("spinning");
      expect(view.lot?.playerUserId).toBeNull();
      // The spin itself is sent, so every browser animates the same wheel.
      expect(view.lot?.spin?.targetIndex).toBe(1);
    }
  });

  it("reveals the player the instant the spin is due to end", () => {
    const done = snapshot({
      now: T0 + SPIN_DURATION_MS,
      lot: { ...snapshot().lot!, spin: spin() },
    });
    expect(redactDraft(done, observer).lot?.playerUserId).toBe("rook");
    expect(redactDraft(done, observer).phase).toBe("bidding");
  });

  it("tells only the admin who is winning an open lot", () => {
    expect(redactDraft(snapshot(), admin).lot?.resolution).toMatchObject({
      kind: "winner",
      teamId: "t1",
      amount: 120,
    });
    for (const viewer of [captain, player, observer]) {
      expect(redactDraft(snapshot(), viewer).lot?.resolution).toBeNull();
    }
  });

  it("tells everyone how many bids are in without saying what they are", () => {
    for (const viewer of [admin, captain, player, observer]) {
      expect(redactDraft(snapshot(), viewer).lot?.bidCount).toBe(2);
    }
  });

  it("shows every captain every amount when the event says so", () => {
    const open = snapshot({ config: config({ bidVisibility: "captains" }) });
    expect(redactDraft(open, captain).teams.map((team) => team.bid)).toEqual([
      120, 45, null, null,
    ]);
    // A player and an observer are still outside it.
    expect(redactDraft(open, player).teams.every((team) => team.bid === null)).toBe(true);
  });

  it("shows the room every amount when the event says everyone", () => {
    const loud = snapshot({ config: config({ bidVisibility: "everyone" }) });
    for (const viewer of [player, observer]) {
      expect(redactDraft(loud, viewer).teams.map((team) => team.bid)).toEqual([
        120, 45, null, null,
      ]);
    }
  });

  it("never hides a team's own bid from its own captain", () => {
    // Even at the tightest setting, and even when the config is nonsense.
    const view = redactDraft(snapshot(), captain);
    expect(view.teams.find((team) => team.id === "t2")?.bid).toBe(45);
  });

  it("gives a cap only to the admin and to the team it belongs to", () => {
    const forCaptain = redactDraft(snapshot(), captain);
    expect(forCaptain.teams.find((team) => team.id === "t2")?.maxBid).toBe(996);
    expect(forCaptain.teams.find((team) => team.id === "t1")?.maxBid).toBeNull();
    expect(redactDraft(snapshot(), admin).teams.every((team) => team.maxBid !== null)).toBe(true);
    expect(redactDraft(snapshot(), observer).teams.every((team) => team.maxBid === null)).toBe(
      true
    );
  });

  it("tells a viewer where they stand", () => {
    expect(redactDraft(snapshot(), player).you).toMatchObject({
      userId: "rook",
      teamId: null,
      inPool: "main",
    });
    expect(redactDraft(snapshot(), captain).you).toMatchObject({
      teamId: "t2",
      inPool: null,
      maxBid: 996,
    });
    expect(redactDraft(snapshot(), observer).you).toMatchObject({
      userId: null,
      inPool: null,
      canBid: false,
    });
  });

  it("lets a captain who has not bid bid, and nobody else", () => {
    const third: DraftViewer = { role: "captain", userId: "t3-p0", teamId: "t3" };
    expect(redactDraft(snapshot(), third).you.canBid).toBe(true);

    // t2's sealed bid is already in, so there is nothing more they may do.
    expect(redactDraft(snapshot(), captain).you.canBid).toBe(false);

    const fullMembers = roster("t3", 6);
    const filled = snapshot({
      teams: [
        standing("t3", {
          members: fullMembers,
          roster: rosterState({ id: "t3" }, fullMembers, cfg),
          maxBid: 0,
        }),
      ],
    });
    expect(redactDraft(filled, third).you.canBid).toBe(false);

    // And with nothing on the block, nobody can bid at all.
    expect(redactDraft(snapshot({ lot: null }), third).you.canBid).toBe(false);
  });

  it("copies the shared fields through untouched", () => {
    const view = redactDraft(snapshot(), captain);
    expect(view).toMatchObject({ role: "captain", activeKind: "main" });
    expect(view.now).toBe(T0 + SPIN_DURATION_MS + 1);
    expect(view.config).toEqual(cfg);
    expect(view.completion.playersLeft).toBe(3);
  });
});

describe("phaseOf and spinning", () => {
  const lot: OpenLot = {
    id: "lot-1",
    playerUserId: "rook",
    fromKind: "main",
    openedAt: T0,
    spin: {
      pool: ["nova", "rook"],
      targetIndex: 1,
      startedAt: T0,
      durationMs: SPIN_DURATION_MS,
      turns: 6,
    },
    bids: [],
    endsAt: null,
  };

  it("is idle on an untouched draft", () => {
    expect(phaseOf({ lot: null, history: [], now: T0 })).toBe("idle");
  });

  it("is spinning while the wheel is turning and bidding the moment it stops", () => {
    expect(phaseOf({ lot, history: [], now: T0 })).toBe("spinning");
    expect(phaseOf({ lot, history: [], now: T0 + SPIN_DURATION_MS - 1 })).toBe("spinning");
    expect(phaseOf({ lot, history: [], now: T0 + SPIN_DURATION_MS })).toBe("bidding");
  });

  it("is bidding immediately for a lot with no spin", () => {
    expect(phaseOf({ lot: { ...lot, spin: null }, history: [], now: T0 })).toBe("bidding");
  });

  it("is resolved when nothing is up but something has settled", () => {
    const history: SettledLot[] = [
      {
        id: "lot-0",
        playerUserId: "nova",
        status: "discarded",
        fromKind: "main",
        winnerTeamId: null,
        price: null,
        closedAt: T0,
        voidedAt: null,
      },
    ];
    expect(phaseOf({ lot: null, history, now: T0 })).toBe("resolved");
  });

  it("has no spin to run when there is none", () => {
    expect(spinning(null, T0)).toBe(false);
  });
});
