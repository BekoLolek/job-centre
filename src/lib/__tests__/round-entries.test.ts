import { describe, expect, it } from "vitest";
import {
  type RoundEntry,
  type RoundRow,
  type RoundScoring,
  roundEntriesProblem,
  roundMovedRefusal,
  roundMovedSince,
  unseatedRefusal,
} from "@/lib/events-policy";

/*
 * Task 88's pure half — R-224, R-227, R-230, R-233 / UC-45 3c, 3d, 3e, 4b.
 *
 * The refusals a round save makes are reachable on the screen only by typing,
 * and this suite is a node environment with nothing to type into — so each
 * decision is a plain function over plain data, asserted directly, the way
 * Task 87's `roundScoringLosses` and Task 80's `standingOn` were. The screen
 * and the server action call these same functions, which is what makes "the
 * sentence on the panel is the sentence the save refuses with" true rather
 * than hoped.
 *
 * Every refusal is matched as the whole sentence with `toBe`, and the wrong
 * sentence is asserted absent with `not.toContain` — Task 78's lesson that a
 * `toContain` on a shared phrase passes on the wrong refusal.
 */

const SIX: RoundScoring = {
  rounds: [{ name: null }, { name: null }, { name: "Semis" }, { name: null }, { name: null }, { name: "Final" }],
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

const names: Record<string, string> = { alice: "Alice", bob: "Bob", cass: "Cass" };
const nameOf = (userId: string) => names[userId] ?? userId;

const entry = (
  userId: string,
  score: number | null,
  bonuses: Record<string, number> = {}
): RoundEntry => ({ userId, score, bonuses });

const row = (userId: string, score: number, bonuses: Record<string, number> = {}): RoundRow => ({
  userId,
  score,
  bonuses,
});

/* --------------------------------------------------------------------- */
/* What a round may hold (UC-45 3, 3a, 3b, 3c, 3d)                       */
/* --------------------------------------------------------------------- */

describe("what a round's entries may be", () => {
  it("accepts whole scores, blanks, and a bonus earned more than once", () => {
    const entries = [
      entry("alice", 10, { "Sub-0.5 answer": 2 }),
      entry("bob", null),
      entry("cass", -3, { "Gold run": 1, "Sub-0.5 answer": 1 }),
    ];
    expect(roundEntriesProblem(SIX, 1, entries, nameOf)).toBeNull();
    expect(roundEntriesProblem(SIX, 6, entries, nameOf)).toBeNull();
  });

  it("refuses a round that is not on the night's card", () => {
    expect(roundEntriesProblem(SIX, 7, [entry("alice", 1)], nameOf)).toBe(
      "This night has 6 rounds, so there is no round 7 to score."
    );
    expect(roundEntriesProblem(SIX, 0, [], nameOf)).toBe(
      "This night has 6 rounds, so there is no round 0 to score."
    );
    expect(roundEntriesProblem(SIX, 2.5, [], nameOf)).toBe(
      "This night has 6 rounds, so there is no round 2.5 to score."
    );
  });

  it("refuses a score that is not a whole number, naming the player (3d)", () => {
    const said = roundEntriesProblem(SIX, 1, [entry("alice", 10), entry("bob", 7.5)], nameOf);
    expect(said).toBe(
      "Bob's score has to be a whole number. A fraction of a second is a bonus, not a score."
    );
    expect(said).not.toContain("left blank");
    expect(said).not.toContain("not one of this night's bonuses");
    // NaN is not a whole number either — "1o" typed into the box.
    expect(roundEntriesProblem(SIX, 1, [entry("alice", Number.NaN)], nameOf)).toBe(
      "Alice's score has to be a whole number. A fraction of a second is a bonus, not a score."
    );
  });

  it("refuses a bonus awarded to a player left blank, naming them (3c)", () => {
    const said = roundEntriesProblem(
      SIX,
      6,
      [entry("alice", 10), entry("bob", null, { "Gold run": 1 })],
      nameOf
    );
    expect(said).toBe(
      'Bob was left blank for Final but given "Gold run". Somebody who did not play a round cannot have earned anything in it.'
    );
    expect(said).not.toContain("whole number");
    expect(said).not.toContain("holds no seat");
  });

  it("names the round by the manager's name for it, or Round N", () => {
    expect(
      roundEntriesProblem(SIX, 2, [entry("bob", null, { "Gold run": 1 })], nameOf)
    ).toContain("left blank for Round 2");
    expect(
      roundEntriesProblem(SIX, 3, [entry("bob", null, { "Gold run": 1 })], nameOf)
    ).toContain("left blank for Semis");
  });

  it("refuses a bonus the setup does not define, so an unknown key never counts nothing in silence", () => {
    // Task 86 decided an undefined key counts nothing rather than throwing, and
    // UC-44 4d keeps that unreachable from the panel. This is the other door.
    const said = roundEntriesProblem(SIX, 1, [entry("alice", 10, { Clutch: 1 })], nameOf);
    expect(said).toBe(
      'Alice was given "Clutch", which is not one of this night\'s bonuses. Add it on the Scoring panel first.'
    );
    expect(said).not.toContain("left blank");
  });

  it("refuses a count below one or not whole, naming the player and the bonus", () => {
    const zero = roundEntriesProblem(SIX, 1, [entry("alice", 10, { "Gold run": 0 })], nameOf);
    expect(zero).toBe(
      'Alice cannot earn "Gold run" fewer than once, or a fraction of a time. Take the award back instead.'
    );
    expect(roundEntriesProblem(SIX, 1, [entry("alice", 10, { "Gold run": -1 })], nameOf)).toBe(zero);
    expect(roundEntriesProblem(SIX, 1, [entry("alice", 10, { "Gold run": 1.5 })], nameOf)).toBe(zero);
    expect(roundEntriesProblem(SIX, 1, [entry("alice", 10, { "Gold run": Number.NaN })], nameOf)).toBe(zero);
    expect(zero).not.toContain("whole number");
  });

  it("refuses one player listed twice", () => {
    expect(roundEntriesProblem(SIX, 1, [entry("alice", 1), entry("alice", 2)], nameOf)).toBe(
      "Alice appears twice in this round. Each player has one line."
    );
  });

  it("names the first problem in list order, so the screen points at one line", () => {
    const said = roundEntriesProblem(
      SIX,
      1,
      [entry("alice", 1.5), entry("bob", null, { "Gold run": 1 })],
      nameOf
    );
    expect(said).toContain("Alice");
    expect(said).not.toContain("Bob");
  });
});

/* --------------------------------------------------------------------- */
/* Who may be scored (UC-45 3e)                                          */
/* --------------------------------------------------------------------- */

describe("who holds a seat", () => {
  const scorable = new Set(["alice", "bob"]);

  it("lets every scored player through when all hold a seat", () => {
    expect(unseatedRefusal([entry("alice", 1), entry("bob", 2)], scorable, nameOf)).toBeNull();
  });

  it("refuses a score for somebody holding no seat, naming them and pointing at Applicants", () => {
    const said = unseatedRefusal([entry("alice", 1), entry("cass", 4)], scorable, nameOf);
    expect(said).toBe(
      "Cass holds no seat in this event, so they cannot be scored. Accept them on Applicants first."
    );
    expect(said).not.toContain("whole number");
  });

  it("does not refuse a blank line for somebody who has since lost their seat", () => {
    // A withdrawal between the page loading and Save must not block the whole
    // round over a player who is not even being scored.
    expect(unseatedRefusal([entry("alice", 1), entry("cass", null)], scorable, nameOf)).toBeNull();
  });

  it("does refuse a bonus-only line for them, because that would write a row", () => {
    // Unreachable past `roundEntriesProblem` (a blank cannot carry a bonus), but
    // this function is asked on its own and must not depend on the order.
    expect(unseatedRefusal([entry("cass", null, { "Gold run": 1 })], scorable, nameOf)).toContain(
      "Cass holds no seat"
    );
  });
});

/* --------------------------------------------------------------------- */
/* Has the round moved since the screen loaded it? (UC-45 4b)            */
/* --------------------------------------------------------------------- */

describe("whether a round moved", () => {
  it("has not moved when the rows are the same, whatever their order", () => {
    const a = [row("alice", 10, { "Gold run": 1 }), row("bob", 8)];
    const b = [row("bob", 8, {}), row("alice", 10, { "Gold run": 1 })];
    expect(roundMovedSince(a, b)).toBe(false);
    expect(roundMovedSince([], [])).toBe(false);
  });

  it("ignores the order of the bonus keys on a row", () => {
    const a = [row("alice", 10, { "Gold run": 1, "Sub-0.5 answer": 2 })];
    const b = [row("alice", 10, { "Sub-0.5 answer": 2, "Gold run": 1 })];
    expect(roundMovedSince(a, b)).toBe(false);
  });

  it("has moved when a score changed", () => {
    expect(roundMovedSince([row("alice", 10)], [row("alice", 11)])).toBe(true);
  });

  it("has moved when a bonus arrived that the screen never saw — the award a stale save would strip", () => {
    expect(roundMovedSince([row("alice", 10)], [row("alice", 10, { "Gold run": 1 })])).toBe(true);
    expect(
      roundMovedSince([row("alice", 10, { "Gold run": 1 })], [row("alice", 10, { "Gold run": 2 })])
    ).toBe(true);
  });

  it("has moved when a player was scored or blanked since", () => {
    expect(roundMovedSince([], [row("bob", 8)])).toBe(true);
    expect(roundMovedSince([row("bob", 8)], [])).toBe(true);
    expect(roundMovedSince([row("bob", 8)], [row("alice", 8)])).toBe(true);
  });

  it("says what happened and what the screen now shows, naming the round", () => {
    expect(roundMovedRefusal("Final")).toBe(
      "Somebody else saved Final while you were on it. What they stored is shown now. Check it, and save again if it needs changing."
    );
    expect(roundMovedRefusal("Round 2")).toContain("saved Round 2 while");
  });
});
