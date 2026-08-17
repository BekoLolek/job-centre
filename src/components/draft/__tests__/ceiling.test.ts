import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT_CONFIG, type DraftConfig } from "@/lib/draft-policy";
import { ceilingFor, ceilingsFor } from "../ceiling";
import { formatDelta, formatMoney } from "../money";
import { playerName } from "../types";
import type { TeamLike } from "../types";

/**
 * The bid ceiling is the one number on the admin's Draft tab that promises
 * something about the night: "the most this team can bid is 897". If it is ever
 * a different figure from the one `canPlaceBid` enforces, the screen has lied
 * to a captain — so these pin the arithmetic to `maxBidFor`'s, including the
 * cases where the rule costs nothing and the ones where it bites.
 */

function team(overrides: Partial<TeamLike> = {}): TeamLike {
  const id = overrides.id ?? "team-1";
  return {
    id,
    name: "Rivals Red",
    seed: 1,
    captainUserId: "captain-1",
    balanceStart: 1000,
    balance: 1000,
    members: [{ teamId: id, userId: "captain-1", price: 0, isCaptain: true }],
    // Replaced below by `ceilingFor`, which re-derives it from the config.
    roster: {
      size: 1,
      captainCount: 1,
      target: 6,
      slotsLeft: 5,
      full: false,
      overfilled: false,
      minPerSlot: 1,
      reserved: 4,
    },
    ...overrides,
  };
}

function config(overrides: Partial<DraftConfig> = {}): DraftConfig {
  return { ...DEFAULT_DRAFT_CONFIG, ...overrides };
}

describe("ceilingFor", () => {
  it("holds one back per unfilled slot after the current lot", () => {
    // Four on the roster of six, so three slots including the one being bid
    // for; two of those still need a pound each.
    const subject = team({
      balance: 899,
      members: [
        { teamId: "team-1", userId: "captain-1", price: 0, isCaptain: true },
        { teamId: "team-1", userId: "p1", price: 50, isCaptain: false },
        { teamId: "team-1", userId: "p2", price: 51, isCaptain: false },
      ],
    });

    const ceiling = ceilingFor(subject, config({ rosterTarget: 6, mustFillRoster: true }));

    expect(ceiling.roster.slotsLeft).toBe(3);
    expect(ceiling.roster.reserved).toBe(2);
    expect(ceiling.max).toBe(897);
    expect(ceiling.sentence).toBe(
      "With 3 slots left, the most Rivals Red can bid is 897 — 2 stays back to fill the other 2 slots."
    );
    expect(ceiling.stuck).toBe(false);
  });

  it("costs nothing on the last slot — there is nothing left to keep back for", () => {
    const subject = team({
      balance: 400,
      members: [
        { teamId: "team-1", userId: "captain-1", price: 0, isCaptain: true },
        { teamId: "team-1", userId: "p1", price: 300, isCaptain: false },
      ],
    });

    const ceiling = ceilingFor(subject, config({ rosterTarget: 3 }));

    expect(ceiling.roster.slotsLeft).toBe(1);
    expect(ceiling.max).toBe(400);
    expect(ceiling.sentence).toBe("One slot left, so Rivals Red can bid the whole 400 on it.");
  });

  it("gives back the whole balance when the rule is off", () => {
    const subject = team({ balance: 1000 });
    const ceiling = ceilingFor(subject, config({ mustFillRoster: false, rosterTarget: 6 }));

    expect(ceiling.max).toBe(1000);
    expect(ceiling.roster.reserved).toBe(0);
    expect(ceiling.sentence).toBe("With 5 slots left, Rivals Red can bid the whole 1,000.");
  });

  it("gives a full roster nothing, however much money is left", () => {
    const subject = team({
      balance: 700,
      members: [
        { teamId: "team-1", userId: "captain-1", price: 0, isCaptain: true },
        { teamId: "team-1", userId: "p1", price: 300, isCaptain: false },
      ],
    });

    const ceiling = ceilingFor(subject, config({ rosterTarget: 2 }));

    expect(ceiling.max).toBe(0);
    expect(ceiling.sentence).toBe("Rivals Red is full at 2 — nothing left to buy.");
  });

  it("counts the captain against the target, per §14", () => {
    const withCaptain = ceilingFor(team(), config({ rosterTarget: 6 }));
    const withoutCaptain = ceilingFor(
      team({ captainUserId: null, members: [] }),
      config({ rosterTarget: 6 })
    );

    expect(withCaptain.roster.slotsLeft).toBe(5);
    expect(withoutCaptain.roster.slotsLeft).toBe(6);
  });

  it("flags a team that cannot reach the minimum bid at all", () => {
    // Five slots left holds 4 × 100 back, leaving 50 — under the 100 minimum.
    const subject = team({ balance: 450 });
    const ceiling = ceilingFor(
      subject,
      config({ rosterTarget: 6, minBid: 100, mustFillRoster: true })
    );

    expect(ceiling.max).toBe(50);
    expect(ceiling.stuck).toBe(true);
  });

  it("re-derives the roster from the config rather than trusting the team's own", () => {
    // The team arrives carrying a roster computed against a target of 6; asking
    // for 4 must answer for 4, because that is the setting on screen.
    const ceiling = ceilingFor(team(), config({ rosterTarget: 4 }));

    expect(ceiling.roster.target).toBe(4);
    expect(ceiling.roster.slotsLeft).toBe(3);
    expect(ceiling.max).toBe(998);
  });

  it("prices every team against one config", () => {
    const rows = ceilingsFor(
      [team({ id: "a", name: "A" }), team({ id: "b", name: "B", balance: 500, members: [] })],
      config({ rosterTarget: 6 })
    );

    expect(rows.map((row) => row.team.name)).toEqual(["A", "B"]);
    expect(rows[0].max).toBe(996);
    // B has no captain, so six slots and five to hold back for.
    expect(rows[1].max).toBe(495);
  });
});

describe("formatMoney", () => {
  it("groups thousands and drops fractions", () => {
    expect(formatMoney(1000)).toBe("1,000");
    expect(formatMoney(0)).toBe("0");
    expect(formatMoney(1234567)).toBe("1,234,567");
    expect(formatMoney(99.9)).toBe("99");
  });

  it("keeps a negative balance visible rather than clamping it", () => {
    expect(formatMoney(-40)).toBe("-40");
  });
});

describe("formatDelta", () => {
  it("signs a change, with a real minus so columns line up", () => {
    expect(formatDelta(250)).toBe("+250");
    expect(formatDelta(-40)).toBe("−40");
    expect(formatDelta(0)).toBe("+0");
  });
});

describe("playerName", () => {
  const players = { "user-1": { displayName: "lolek" } };

  it("names somebody it knows", () => {
    expect(playerName(players, "user-1")).toBe("lolek");
  });

  it("says something rather than nothing for an id it does not have", () => {
    expect(playerName(players, "user-2")).toBe("Unknown player");
    expect(playerName(players, null)).toBe("Unknown player");
    expect(playerName(players, undefined, "Empty slot")).toBe("Empty slot");
  });
});
