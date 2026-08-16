import { describe, expect, it } from "vitest";
import {
  SPIN_DURATION_MS,
  allBidsIn,
  phaseOf,
  poolFor,
  recordResult,
  setPool,
  toView,
  undoLast,
} from "@/lib/state";
import type { DraftState, Result, Spin } from "@/lib/types";
import { makeResult, makeSession, makeState } from "./helpers";

const T0 = 1_700_000_000_000;

function makeSpin(over: Partial<Spin> = {}): Spin {
  return {
    wheel: "main",
    pool: ["Nova", "Rook", "Sable"],
    targetIndex: 1,
    startedAt: T0,
    durationMs: SPIN_DURATION_MS,
    turns: 6,
    ...over,
  };
}

describe("phaseOf", () => {
  it("is idle on a fresh state", () => {
    expect(phaseOf(makeState(), T0)).toBe("idle");
  });

  it("is spinning while the wheel is still turning", () => {
    const state = makeState({ spin: makeSpin() });
    expect(phaseOf(state, T0)).toBe("spinning");
    expect(phaseOf(state, T0 + SPIN_DURATION_MS - 1)).toBe("spinning");
  });

  it("stops spinning the instant the animation is due to end", () => {
    const state = makeState({ spin: makeSpin(), currentPlayer: "Rook" });
    expect(phaseOf(state, T0 + SPIN_DURATION_MS)).toBe("bidding");
  });

  it("is bidding once a player is on the block", () => {
    expect(phaseOf(makeState({ currentPlayer: "Rook" }), T0)).toBe("bidding");
  });

  it("prefers spinning over bidding while both are set", () => {
    const state = makeState({ spin: makeSpin(), currentPlayer: "Rook" });
    expect(phaseOf(state, T0 + 10)).toBe("spinning");
  });

  it("is resolved when the last lot is settled and nothing is up", () => {
    expect(phaseOf(makeState({ lastResult: makeResult() }), T0)).toBe("resolved");
  });

  it("prefers bidding over resolved", () => {
    const state = makeState({ currentPlayer: "Rook", lastResult: makeResult() });
    expect(phaseOf(state, T0)).toBe("bidding");
  });

  it("honours a custom spin duration", () => {
    const state = makeState({ spin: makeSpin({ durationMs: 100 }) });
    expect(phaseOf(state, T0 + 99)).toBe("spinning");
    expect(phaseOf(state, T0 + 100)).toBe("idle");
  });

  it("defaults `now` to the real clock", () => {
    const stale = makeState({ spin: makeSpin({ startedAt: Date.now() - 60_000 }) });
    expect(phaseOf(stale)).toBe("idle");
    const live = makeState({ spin: makeSpin({ startedAt: Date.now() }) });
    expect(phaseOf(live)).toBe("spinning");
  });
});

describe("allBidsIn", () => {
  it("is false with no bids", () => {
    expect(allBidsIn(makeState())).toBe(false);
  });

  it("is false while anybody is missing", () => {
    expect(allBidsIn(makeState({ bids: { c1: 10, c2: 20, c3: 0 } }))).toBe(false);
  });

  it("is true once every captain has a key, including zero bids", () => {
    expect(allBidsIn(makeState({ bids: { c1: 10, c2: 0, c3: 0, c4: 5 } }))).toBe(true);
  });

  it("ignores stray keys for captains that no longer exist", () => {
    const bids = { c1: 1, c2: 1, c3: 1, c4: 1, ghost: 99 };
    expect(allBidsIn(makeState({ bids }))).toBe(true);
  });
});

describe("poolFor / setPool", () => {
  it("reads and writes the wheel it is asked for", () => {
    const state = makeState({ mainPool: ["Nova"], reservePool: ["Rook"] });
    expect(poolFor(state, "main")).toEqual(["Nova"]);
    expect(poolFor(state, "reserve")).toEqual(["Rook"]);
    setPool(state, "reserve", ["Sable"]);
    expect(state.reservePool).toEqual(["Sable"]);
    expect(state.mainPool).toEqual(["Nova"]);
  });
});

describe("recordResult", () => {
  it("stores the result and clears the lot", () => {
    const state = makeState({
      spin: makeSpin(),
      currentPlayer: "Rook",
      bids: { c1: 50, c2: 10 },
    });
    const result = makeResult({ player: "Rook" });
    recordResult(state, result);

    expect(state.lastResult).toBe(result);
    expect(state.history[0]).toBe(result);
    expect(state.spin).toBeNull();
    expect(state.currentPlayer).toBeNull();
    expect(state.bids).toEqual({});
  });

  it("puts the newest result at the front of the history", () => {
    const state = makeState();
    recordResult(state, makeResult({ player: "First" }));
    recordResult(state, makeResult({ player: "Second" }));
    expect(state.history.map((r) => r.player)).toEqual(["Second", "First"]);
  });

  it("keeps the history at a thousand entries, dropping the oldest", () => {
    const history: Result[] = Array.from({ length: 1000 }, (_, i) =>
      makeResult({ player: `p${i}` })
    );
    const state = makeState({ history });
    recordResult(state, makeResult({ player: "newest" }));
    expect(state.history).toHaveLength(1000);
    expect(state.history[0].player).toBe("newest");
    expect(state.history.at(-1)?.player).toBe("p998");
  });
});

describe("undoLast", () => {
  it("reports when there is nothing to undo", () => {
    const state = makeState();
    expect(undoLast(state)).toBe("Nothing to undo");
  });

  it("refunds the balance, drops the player from the roster and restores the pool", () => {
    const state = makeState({ mainPool: ["Sable"] });
    state.captains[0].balance = 880;
    state.captains[0].roster = ["Nova"];
    state.history = [makeResult({ player: "Nova", amount: 120, winnerId: "c1" })];

    expect(undoLast(state)).toBeNull();
    expect(state.captains[0].balance).toBe(1000);
    expect(state.captains[0].roster).toEqual([]);
    expect(state.mainPool).toEqual(["Sable", "Nova"]);
    expect(state.history).toEqual([]);
    expect(state.lastResult).toBeNull();
  });

  it("removes only one copy of a duplicated name from the roster", () => {
    const state = makeState();
    state.captains[0].roster = ["Nova", "Rook", "Nova"];
    state.history = [makeResult({ player: "Nova", winnerId: "c1", amount: 0 })];
    undoLast(state);
    expect(state.captains[0].roster).toEqual(["Nova", "Rook"]);
  });

  it("returns an awarded player to the wheel they were spun from", () => {
    const state = makeState({ reservePool: [] });
    state.captains[0].roster = ["Nova"];
    state.history = [
      makeResult({ player: "Nova", winnerId: "c1", fromWheel: "reserve", amount: 40 }),
    ];
    undoLast(state);
    expect(state.reservePool).toEqual(["Nova"]);
    expect(state.mainPool).toEqual([]);
  });

  it("treats a missing amount as no refund", () => {
    const state = makeState();
    state.captains[0].balance = 1000;
    state.history = [makeResult({ player: "Nova", winnerId: "c1", amount: null })];
    undoLast(state);
    expect(state.captains[0].balance).toBe(1000);
  });

  it("survives an award whose captain no longer exists", () => {
    const state = makeState();
    state.history = [makeResult({ player: "Nova", winnerId: "ghost" })];
    expect(undoLast(state)).toBeNull();
    expect(state.mainPool).toEqual(["Nova"]);
  });

  it("puts a discarded player back on their wheel", () => {
    const state = makeState({ mainPool: ["Sable"] });
    state.history = [
      makeResult({ player: "Nova", action: "discard", winnerId: null, amount: null }),
    ];
    undoLast(state);
    expect(state.mainPool).toEqual(["Sable", "Nova"]);
    expect(state.captains.every((c) => c.balance === 1000)).toBe(true);
  });

  it("moves a reserved player back into the main pool", () => {
    const state = makeState({ mainPool: ["Sable"], reservePool: ["Nova", "Rook"] });
    state.history = [
      makeResult({ player: "Nova", action: "reserve", winnerId: null, amount: null }),
    ];
    undoLast(state);
    expect(state.reservePool).toEqual(["Rook"]);
    expect(state.mainPool).toEqual(["Sable", "Nova"]);
  });

  it("does not duplicate a player already sitting in the pool", () => {
    const state = makeState({ mainPool: ["Nova"] });
    state.history = [makeResult({ player: "Nova", action: "discard" })];
    undoLast(state);
    expect(state.mainPool).toEqual(["Nova"]);
  });

  it("steps back to the previous result and clears any lot in progress", () => {
    const older = makeResult({ player: "Old", action: "discard" });
    const newer = makeResult({ player: "New", action: "discard" });
    const state = makeState({
      history: [newer, older],
      lastResult: newer,
      spin: makeSpin(),
      currentPlayer: "Sable",
      bids: { c1: 5 },
    });
    undoLast(state);
    expect(state.history).toEqual([older]);
    expect(state.lastResult).toBe(older);
    expect(state.spin).toBeNull();
    expect(state.currentPlayer).toBeNull();
    expect(state.bids).toEqual({});
  });

  it("undoes several awards in turn", () => {
    const state = makeState();
    state.captains[0].balance = 700;
    state.captains[0].roster = ["Nova", "Rook"];
    state.history = [
      makeResult({ player: "Rook", winnerId: "c1", amount: 200 }),
      makeResult({ player: "Nova", winnerId: "c1", amount: 100 }),
    ];
    undoLast(state);
    expect(state.captains[0].balance).toBe(900);
    undoLast(state);
    expect(state.captains[0].balance).toBe(1000);
    expect(state.captains[0].roster).toEqual([]);
    expect(state.mainPool.sort()).toEqual(["Nova", "Rook"]);
    expect(undoLast(state)).toBe("Nothing to undo");
  });
});

describe("toView", () => {
  function full(): DraftState {
    return makeState({
      mainPool: ["Nova", "Rook"],
      reservePool: ["Sable"],
      activeWheel: "main",
      currentPlayer: "Nova",
      bids: { c1: 120, c2: 45 },
      lastResult: makeResult(),
      history: [makeResult()],
    });
  }

  it("shows the admin every bid and both pools", () => {
    const view = toView(full(), makeSession({ role: "admin" }));
    expect(view.captains.map((c) => c.bid)).toEqual([120, 45, null, null]);
    expect(view.captains.map((c) => c.hasBid)).toEqual([true, true, false, false]);
    expect(view.mainPool).toEqual(["Nova", "Rook"]);
    expect(view.reservePool).toEqual(["Sable"]);
  });

  it("shows a captain only their own bid, and no pools", () => {
    const view = toView(full(), makeSession({ role: "captain", username: "captain2", captainId: "c2" }));
    expect(view.captains.map((c) => c.bid)).toEqual([null, 45, null, null]);
    // Who has bid is still public — only the amounts are hidden.
    expect(view.captains.map((c) => c.hasBid)).toEqual([true, true, false, false]);
    expect(view.mainPool).toBeNull();
    expect(view.reservePool).toBeNull();
  });

  it("shows an observer no bid amounts at all, and no pools", () => {
    const view = toView(full(), makeSession({ role: "observer", username: "observer" }));
    expect(view.captains.every((c) => c.bid === null)).toBe(true);
    expect(view.mainPool).toBeNull();
    expect(view.reservePool).toBeNull();
  });

  it("still reports the pool sizes to everyone", () => {
    for (const session of [
      makeSession({ role: "captain", captainId: "c1" }),
      makeSession({ role: "observer" }),
    ]) {
      const view = toView(full(), session);
      expect(view.mainPoolCount).toBe(2);
      expect(view.reservePoolCount).toBe(1);
    }
  });

  it("sends the active wheel's names to everyone", () => {
    const state = full();
    expect(toView(state, makeSession({ role: "observer" })).activePool).toEqual([
      "Nova",
      "Rook",
    ]);
    state.activeWheel = "reserve";
    expect(toView(state, makeSession({ role: "observer" })).activePool).toEqual(["Sable"]);
  });

  it("withholds the current player while the wheel is still spinning", () => {
    const state = full();
    state.spin = makeSpin({ startedAt: Date.now() });
    const view = toView(state, makeSession({ role: "admin" }));
    expect(view.phase).toBe("spinning");
    expect(view.currentPlayer).toBeNull();
    expect(view.spin).toBe(state.spin);
  });

  it("reveals the current player once the spin is over", () => {
    const view = toView(full(), makeSession({ role: "observer" }));
    expect(view.phase).toBe("bidding");
    expect(view.currentPlayer).toBe("Nova");
  });

  it("copies the session identity and the shared fields onto the view", () => {
    const state = full();
    const view = toView(state, makeSession({ role: "captain", username: "captain3", captainId: "c3" }));
    expect(view).toMatchObject({
      role: "captain",
      username: "captain3",
      captainId: "c3",
      allBidsIn: false,
      activeWheel: "main",
    });
    expect(view.lastResult).toBe(state.lastResult);
    expect(view.history).toBe(state.history);
    expect(typeof view.now).toBe("number");
  });

  it("reports balances and rosters for every captain", () => {
    const state = full();
    state.captains[0].balance = 640;
    state.captains[0].roster = ["Kite"];
    const view = toView(state, makeSession({ role: "observer" }));
    expect(view.captains[0]).toMatchObject({
      id: "c1",
      name: "Alpha",
      balance: 640,
      roster: ["Kite"],
    });
  });

  it("flags allBidsIn once everybody has bid", () => {
    const state = makeState({ bids: { c1: 1, c2: 2, c3: 3, c4: 4 } });
    expect(toView(state, makeSession()).allBidsIn).toBe(true);
  });
});
