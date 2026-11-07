import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT_CONFIG, type DraftConfig } from "@/lib/draft-policy";
import { type RosterSizing, eventShapeFrom, rosterSizingFrom } from "@/lib/events-policy";
import { UNSIZED_ROSTER_NOTE } from "../TeamCard";
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
    // Replaced below by `ceilingFor`, which re-derives it from the config and
    // the sizing.
    roster: {
      size: 1,
      captainCount: 1,
      target: 6,
      cap: 6,
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

/**
 * The places on a team, as the Format panel states them under "players on a
 * team" — through the real reader over a stored shape, never a literal, for
 * the reason `rosterSizingFrom`'s docblock gives: a hand-built sizing is the
 * first place target and cap could disagree.
 */
function sized(places: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({
      eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: places } },
    }),
    0
  );
}

/**
 * The other two of the three states (R-250 / UC-49 1a, 1b), through the same
 * reader: a count of `teams` over `accepted` people. Eighteen into four is
 * 5, 5, 4, 4 — a cap of five and no target; one person into four sides is a
 * deal `planSides` refuses, so no figure at all.
 */
function counted(teams: number, accepted: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({
      eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: teams } },
    }),
    accepted
  );
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

    const ceiling = ceilingFor(subject, config({ mustFillRoster: true }), sized(6));

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

    const ceiling = ceilingFor(subject, config(), sized(3));

    expect(ceiling.roster.slotsLeft).toBe(1);
    expect(ceiling.max).toBe(400);
    expect(ceiling.sentence).toBe("One slot left, so Rivals Red can bid the whole 400 on it.");
  });

  it("gives back the whole balance when the rule is off", () => {
    const subject = team({ balance: 1000 });
    const ceiling = ceilingFor(subject, config({ mustFillRoster: false }), sized(6));

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

    const ceiling = ceilingFor(subject, config(), sized(2));

    expect(ceiling.max).toBe(0);
    expect(ceiling.sentence).toBe("Rivals Red is full at 2 — nothing left to buy.");
  });

  it("calls a roster full at its cap, which under a count of teams is the only figure there is", () => {
    const sizing = counted(4, 18);
    expect(sizing).toEqual({ target: null, cap: 5 });

    const subject = team({
      members: [
        { teamId: "team-1", userId: "captain-1", price: 0, isCaptain: true },
        ...["p1", "p2", "p3", "p4"].map((userId) => ({
          teamId: "team-1",
          userId,
          price: 10,
          isCaptain: false,
        })),
      ],
    });

    const ceiling = ceilingFor(subject, config(), sizing);

    expect(ceiling.max).toBe(0);
    expect(ceiling.sentence).toBe("Rivals Red is full at 5 — nothing left to buy.");
  });

  it("says the panel has no figure, in the words every roster surface uses, rather than 'full at null'", () => {
    /*
     * Task 108 found this sentence reading "Rivals Red is full at null" and
     * routed around it in the bid box; the admin's Draft tab still reached it
     * through `BidCeiling`. A roster with no cap is not full — nobody has been
     * sized — so the sentence is the shared one, not the full one.
     */
    const sizing = counted(4, 1);
    expect(sizing).toEqual({ target: null, cap: null });

    const ceiling = ceilingFor(team(), config({ mustFillRoster: true }), sizing);

    expect(ceiling.sentence).toBe(UNSIZED_ROSTER_NOTE);
    expect(ceiling.sentence).not.toContain("null");
    expect(ceiling.max).toBe(0);
    expect(ceiling.stuck).toBe(false);
  });

  it("counts the captain against the target, per §14", () => {
    const withCaptain = ceilingFor(team(), config(), sized(6));
    const withoutCaptain = ceilingFor(
      team({ captainUserId: null, members: [] }),
      config(),
      sized(6)
    );

    expect(withCaptain.roster.slotsLeft).toBe(5);
    expect(withoutCaptain.roster.slotsLeft).toBe(6);
  });

  it("flags a team that cannot reach the minimum bid at all", () => {
    // Five slots left holds 4 × 100 back, leaving 50 — under the 100 minimum.
    const subject = team({ balance: 450 });
    const ceiling = ceilingFor(subject, config({ minBid: 100, mustFillRoster: true }), sized(6));

    expect(ceiling.max).toBe(50);
    expect(ceiling.stuck).toBe(true);
  });

  it("re-derives the roster from the sizing rather than trusting the team's own", () => {
    // The team arrives carrying a roster computed against six places; asked
    // for four it must answer for four, because that is the panel's figure.
    const ceiling = ceilingFor(team(), config(), sized(4));

    expect(ceiling.roster.target).toBe(4);
    expect(ceiling.roster.slotsLeft).toBe(3);
    expect(ceiling.max).toBe(998);
  });

  it("prices every team against one config", () => {
    const rows = ceilingsFor(
      [team({ id: "a", name: "A" }), team({ id: "b", name: "B", balance: 500, members: [] })],
      config(),
      sized(6)
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
