import { describe, expect, it } from "vitest";
import type { SettledLot } from "@/lib/draft-policy";
import {
  completionSentence,
  lotLine,
  lotSentence,
  stageLabel,
  teamNameFor,
  undoPlan,
  undoTarget,
} from "../story";
import type { LotContext } from "../story";

/**
 * The room says three things nobody can check against the database while it is
 * happening: what became of a lot, what the undo button is about to reverse,
 * and whether the draft is over. Each is a sentence read out loud in front of
 * everyone, so each is pinned here.
 *
 * The undo cases matter most. `voidLastLot` picks the newest non-voided lot by
 * `openedAt` and an **open** lot qualifies, so the button does two different
 * jobs depending on whether somebody is on the block — and the one it does not
 * announce is the one that loses an award.
 */

const players = {
  "u-ash": { displayName: "Ash" },
  "u-nova": { displayName: "Nova" },
};

const teams = [
  { id: "t-red", name: "Rivals Red" },
  { id: "t-blue", name: "Rivals Blue" },
];

const ctx: LotContext = { players, teams };

function lot(overrides: Partial<SettledLot> = {}): SettledLot {
  return {
    id: "lot-1",
    playerUserId: "u-ash",
    status: "awarded",
    fromKind: "main",
    winnerTeamId: "t-red",
    price: 250,
    closedAt: 1000,
    voidedAt: null,
    ...overrides,
  };
}

describe("teamNameFor", () => {
  it("names a team", () => {
    expect(teamNameFor(teams, "t-blue")).toBe("Rivals Blue");
  });

  it("says something honest for a team it does not hold, rather than nothing", () => {
    expect(teamNameFor(teams, "t-gone")).toBe("an unknown team");
    expect(teamNameFor(teams, null)).toBe("an unknown team");
  });
});

describe("lotLine", () => {
  it("carries the price separately so a list can set it in the money face", () => {
    const line = lotLine(lot(), ctx);
    expect(line.player).toBe("Ash");
    expect(line.outcome).toBe("→ Rivals Red");
    expect(line.price).toBe(250);
    expect(line.tone).toBe("gold");
  });

  it("never repeats the price of a voided lot — the row would still read as a sale", () => {
    // The winner and the price are deliberately left on the row by `voidLot`.
    const line = lotLine(lot({ status: "voided", voidedAt: 2000 }), ctx);
    expect(line.outcome).toBe("→ undone");
    expect(line.price).toBeNull();
    expect(line.tone).toBe("ember");
  });

  it("distinguishes held over from taken off the list", () => {
    expect(lotLine(lot({ status: "reserved", winnerTeamId: null, price: null }), ctx).outcome).toBe(
      "→ held over"
    );
    expect(
      lotLine(lot({ status: "discarded", winnerTeamId: null, price: null }), ctx).outcome
    ).toBe("→ taken off the list");
  });

  it("falls back to a name rather than a blank when the player is unknown", () => {
    expect(lotLine(lot({ playerUserId: "u-ghost" }), ctx).player).toBe("Unknown player");
  });
});

describe("lotSentence", () => {
  it("reads as the room would say it", () => {
    expect(lotSentence(lot(), ctx)).toBe("Ash went to Rivals Red for 250.");
    expect(lotSentence(lot({ status: "reserved" }), ctx)).toBe(
      "Ash was held over for the reserve pool."
    );
    expect(lotSentence(lot({ status: "discarded" }), ctx)).toBe(
      "Ash was taken off the list."
    );
    expect(lotSentence(lot({ status: "voided" }), ctx)).toBe("Ash's lot was undone.");
  });
});

describe("undoTarget", () => {
  it("is the open lot when there is one — which is what voidLastLot picks", () => {
    const target = undoTarget({
      lot: { id: "lot-open" },
      history: [lot({ id: "lot-old" })],
    });
    expect(target).toEqual({ kind: "open", id: "lot-open" });
  });

  it("skips lots that have already been voided", () => {
    const target = undoTarget({
      lot: null,
      history: [
        lot({ id: "lot-3", status: "voided" }),
        lot({ id: "lot-2" }),
        lot({ id: "lot-1" }),
      ],
    });
    expect(target).toEqual({ kind: "settled", lot: expect.objectContaining({ id: "lot-2" }) });
  });

  it("is nothing at all on an untouched draft", () => {
    expect(undoTarget({ lot: null, history: [] })).toBeNull();
  });
});

describe("undoPlan", () => {
  it("says an award will be reversed and the money given back", () => {
    const plan = undoPlan({ lot: null, history: [lot()] }, players, teams);
    expect(plan.available).toBe(true);
    expect(plan.label).toBe("Undo the last lot");
    expect(plan.sentence).toBe(
      "Undo takes Ash off Rivals Red, gives back 250 and returns them to the main pool."
    );
  });

  it("returns a player to the pool they were drawn from, not always the main one", () => {
    const plan = undoPlan(
      { lot: null, history: [lot({ status: "discarded", fromKind: "reserve" })] },
      players,
      teams
    );
    expect(plan.sentence).toBe("Undo puts Ash back into the reserve pool.");
  });

  it("warns that a live lot is what gets cancelled, and that no money moves", () => {
    const plan = undoPlan(
      {
        lot: { id: "lot-open", playerUserId: "u-nova" } as never,
        history: [lot()],
      },
      players,
      teams
    );
    expect(plan.label).toBe("Cancel this lot");
    expect(plan.sentence).toContain("Nova");
    expect(plan.sentence).toContain("No money moves.");
  });

  it("does not name the player while the wheel is still hiding them", () => {
    const plan = undoPlan(
      { lot: { id: "lot-open", playerUserId: null } as never, history: [] },
      players,
      teams
    );
    expect(plan.available).toBe(true);
    expect(plan.sentence).toBe(
      "Undo cancels the lot that is being spun for. No money moves."
    );
  });

  it("is unavailable, and says why, on an untouched draft", () => {
    const plan = undoPlan({ lot: null, history: [] }, players, teams);
    expect(plan.available).toBe(false);
    expect(plan.sentence).toContain("nothing to undo");
  });
});

describe("completionSentence", () => {
  const base = {
    teams: [{ id: "t-red", name: "Rivals Red" }],
  } as never as Parameters<typeof completionSentence>[0];

  it("says nothing while the draft is running", () => {
    expect(
      completionSentence({
        ...base,
        completion: { complete: false, reason: "in_progress", short: [], playersLeft: 4 },
      })
    ).toBeNull();
  });

  it("celebrates full rosters", () => {
    expect(
      completionSentence({
        ...base,
        completion: { complete: true, reason: "rosters_full", short: [], playersLeft: 2 },
      })
    ).toBe("Every roster is full. The draft is done.");
  });

  it("names the teams left short when the pool runs out — the case an admin must act on", () => {
    expect(
      completionSentence({
        ...base,
        completion: {
          complete: true,
          reason: "pool_empty",
          short: [{ teamId: "t-red", slotsLeft: 2 }],
          playersLeft: 0,
        },
      })
    ).toBe("The pool is empty and there are still slots to fill: Rivals Red (2 short).");
  });
});

describe("stageLabel", () => {
  it("tracks the phase", () => {
    expect(stageLabel("spinning", true)).toBe("Spinning");
    expect(stageLabel("bidding", true)).toBe("Bidding open");
    expect(stageLabel("bidding", false)).toBe("Standby");
    expect(stageLabel("idle", false)).toBe("Standby");
    expect(stageLabel("resolved", false)).toBe("Standby");
  });
});
