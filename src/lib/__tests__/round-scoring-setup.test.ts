import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUND_SCORING,
  type RoundScoring,
  type ScoredRow,
  givenRoundName,
  roundName,
  roundScoringConfirmRefusal,
  roundScoringFrom,
  roundScoringLosses,
  roundScoringProblem,
  roundScoringSummary,
  scoresNamed,
} from "@/lib/events-policy";
import { MAX_ROUNDS, rankRounds } from "@/lib/round-scoring";
import type { EventConfig } from "@/db/schema";

/*
 * Task 87's pure half — R-225, R-226, R-229 / UC-44.
 *
 * Everything here is a plain function over plain data, for the reason
 * `events-policy.ts` gives at its top: the Scoring panel and the server action
 * refuse in the same words because they call the same function, and neither
 * needs a database to be asked. The three "confirmed first" states (UC-44 2b,
 * 3a, 4d) are reachable only by clicking in the editor, and this suite is a
 * node environment with nothing to click — so the decision is pulled out as
 * `roundScoringLosses` and asserted directly over every combination, the way
 * Task 83's `manualPostStep` and Task 80's `standingOn` were.
 */

const SIX: RoundScoring = {
  rounds: [
    { name: null },
    { name: null },
    { name: "Semis" },
    { name: null },
    { name: null },
    { name: "Final" },
  ],
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

const names: Record<string, string> = { alice: "Alice", bob: "Bob", cass: "Cass" };
const nameOf = (userId: string) => names[userId] ?? userId;

const row = (roundIndex: number, userId: string, bonuses: Record<string, number> = {}): ScoredRow => ({
  roundIndex,
  userId,
  bonuses,
});

/* --------------------------------------------------------------------- */
/* Naming a round (R-225)                                                */
/* --------------------------------------------------------------------- */

describe("what a round is called", () => {
  it("is the name given, or Round N — a day's rule", () => {
    expect(roundName({ name: "Final" }, 5)).toBe("Final");
    expect(roundName({ name: null }, 5)).toBe("Round 6");
    expect(roundName(undefined, 0)).toBe("Round 1");
  });

  it("treats a name of spaces as no name, in one place", () => {
    // `dayLabel`'s original defect, one surface further on.
    expect(givenRoundName({ name: "   " })).toBeNull();
    expect(givenRoundName({ name: "  Final " })).toBe("Final");
    expect(roundName({ name: "   " }, 2)).toBe("Round 3");
  });
});

/* --------------------------------------------------------------------- */
/* What is stored, and what absent means                                 */
/* --------------------------------------------------------------------- */

describe("the stored setup", () => {
  it("reads an event stored before this panel existed as not round-scored", () => {
    // The opposite default from `eventShapeFrom`, for the same reason: absent
    // must read as the event that exists today, and today no event on the site
    // is scored in rounds.
    expect(roundScoringFrom(null)).toBeNull();
    expect(roundScoringFrom(undefined)).toBeNull();
    expect(roundScoringFrom({})).toBeNull();
    expect(roundScoringFrom({ eventShape: { teamEvent: false } })).toBeNull();
  });

  it("reads what was stored, and hands it to the ranking as it is", () => {
    const stored = roundScoringFrom({
      roundScoring: {
        rounds: [{ name: null }, { name: "Final" }],
        lowWins: true,
        bonuses: [{ key: "Fast", value: 2 }],
      },
    });
    expect(stored).toEqual({
      rounds: [{ name: null }, { name: "Final" }],
      lowWins: true,
      bonuses: [{ key: "Fast", value: 2 }],
    });
    // `RoundScoring` extends `RoundSetup`: the stored object is the ranking's
    // input with no mapping step, so there is one vocabulary for "which way"
    // and "what a bonus is worth".
    const ranked = rankRounds(stored!, [
      { roundIndex: 1, userId: "alice", score: 3, bonuses: { Fast: 1 } },
      { roundIndex: 1, userId: "bob", score: 2, bonuses: {} },
    ]);
    expect(ranked.map((rank) => rank.userId)).toEqual(["alice", "bob"]);
  });

  it("ignores rubbish inside the key rather than crashing on it", () => {
    expect(
      roundScoringFrom({
        roundScoring: {
          rounds: [1, "x", { name: 4 }, { name: "  Semis " }],
          lowWins: "yes",
          bonuses: [{ key: 3, value: 2 }, { key: "Fast", value: "2" }, { key: "Gold", value: 5 }, "no"],
        },
      })
    ).toEqual({
      rounds: [{ name: null }, { name: null }, { name: null }, { name: "Semis" }],
      lowWins: false,
      bonuses: [{ key: "Gold", value: 5 }],
    });
  });

  it("reads a key that is not a setup at all as not round-scored", () => {
    const notSetups: EventConfig[] = [
      { roundScoring: "rounds" },
      { roundScoring: [1, 2] },
      { roundScoring: { rounds: "six" } },
      { roundScoring: { lowWins: true } },
    ];
    for (const stored of notSetups) {
      expect(roundScoringFrom(stored), JSON.stringify(stored)).toBeNull();
    }
  });

  it("starts a night that has never been set up at one round, highest wins, no bonuses", () => {
    expect(DEFAULT_ROUND_SCORING).toEqual({
      rounds: [{ name: null }],
      lowWins: false,
      bonuses: [],
    });
    expect(roundScoringProblem(DEFAULT_ROUND_SCORING)).toBeNull();
  });
});

/* --------------------------------------------------------------------- */
/* What cannot be saved (UC-44 4b, 4c)                                   */
/* --------------------------------------------------------------------- */

describe("what cannot be saved", () => {
  it("accepts the night as described", () => {
    expect(roundScoringProblem(SIX)).toBeNull();
  });

  it("holds the round count to one at least and the table's cap at most", () => {
    expect(roundScoringProblem({ ...SIX, rounds: [] })).toBe("A night has at least one round.");
    const tooMany = Array.from({ length: MAX_ROUNDS + 1 }, () => ({ name: null }));
    expect(roundScoringProblem({ ...SIX, rounds: tooMany })).toBe(
      `A night has at most ${MAX_ROUNDS} rounds.`
    );
    expect(roundScoringProblem({ ...SIX, rounds: tooMany.slice(1) })).toBeNull();
  });

  it("refuses two bonuses with one name (UC-44 4b)", () => {
    const twice = { ...SIX, bonuses: [{ key: "Fast", value: 2 }, { key: " fast ", value: 3 }] };
    expect(roundScoringProblem(twice)).toBe(
      'Two bonuses are called "fast". The scoring screen picks a bonus out by its name, so each needs its own.'
    );
  });

  it("refuses a bonus with no name, because the name is how it is awarded", () => {
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "  ", value: 2 }] })).toBe(
      "Every bonus needs a name. The scoring screen picks a bonus out by it."
    );
  });

  it("refuses a bonus worth nothing or less (UC-44 4c)", () => {
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: 0 }] })).toBe(
      '"Fast" has to be worth at least a point. A penalty is not a bonus.'
    );
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: -2 }] })).toBe(
      '"Fast" has to be worth at least a point. A penalty is not a bonus.'
    );
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: 1 }] })).toBeNull();
  });

  it("refuses a box that is not a whole number rather than reading it as a zero", () => {
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: Number.NaN }] })).toBe(
      '"Fast" has to be worth a whole number of points.'
    );
    expect(roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: 1.5 }] })).toBe(
      '"Fast" has to be worth a whole number of points.'
    );
  });

  it("words the three refusals so none is satisfied by another", () => {
    // Task 78's `toContain` escape: a refusal assertion passed because a
    // *different* refusal carried the same phrase.
    const twice = roundScoringProblem({
      ...SIX,
      bonuses: [{ key: "Fast", value: 2 }, { key: "Fast", value: 2 }],
    });
    const worthless = roundScoringProblem({ ...SIX, bonuses: [{ key: "Fast", value: 0 }] });
    expect(twice).not.toContain("worth");
    expect(worthless).not.toContain("Two bonuses");
    expect(worthless).not.toContain("whole number");
  });
});

/* --------------------------------------------------------------------- */
/* The sentence the panel states (UC-44 5)                               */
/* --------------------------------------------------------------------- */

describe("what the panel states it will do", () => {
  it("prints the use case's own sentence", () => {
    expect(roundScoringSummary(SIX)).toBe("6 rounds, highest total wins, 2 bonuses");
  });

  it("reads the other way, with one round and one or no bonuses", () => {
    expect(
      roundScoringSummary({ rounds: [{ name: null }], lowWins: true, bonuses: [{ key: "Fast", value: 1 }] })
    ).toBe("1 round, lowest total wins, 1 bonus");
    expect(roundScoringSummary(DEFAULT_ROUND_SCORING)).toBe(
      "1 round, highest total wins, no bonuses"
    );
  });
});

/* --------------------------------------------------------------------- */
/* The three destructive edits (UC-44 2b, 3a, 4d)                        */
/* --------------------------------------------------------------------- */

describe("what a save would take away", () => {
  const scored: ScoredRow[] = [
    row(1, "alice", { "Sub-0.5 answer": 2 }),
    row(1, "bob"),
    row(5, "alice"),
    row(5, "cass", { "Gold run": 1 }),
    row(6, "bob", { "Sub-0.5 answer": 1 }),
  ];

  it("names nothing when nothing is lost", () => {
    expect(roundScoringLosses(SIX, SIX, scored, nameOf)).toEqual([]);
    // Raising the count is UC-44 2a: the new round is empty, nothing re-scored.
    const seven = { ...SIX, rounds: [...SIX.rounds, { name: null }] };
    expect(roundScoringLosses(SIX, seven, scored, nameOf)).toEqual([]);
    // Renaming a round, or adding a bonus, costs nothing either.
    const renamed = { ...SIX, rounds: SIX.rounds.map((round, index) => (index === 0 ? { name: "Warm-up" } : round)) };
    expect(roundScoringLosses(SIX, renamed, scored, nameOf)).toEqual([]);
    const more = { ...SIX, bonuses: [...SIX.bonuses, { key: "Clutch", value: 3 }] };
    expect(roundScoringLosses(SIX, more, scored, nameOf)).toEqual([]);
  });

  it("names nothing on a night nobody has scored yet, whatever changes", () => {
    const flipped = { ...SIX, lowWins: true, rounds: SIX.rounds.slice(0, 1), bonuses: [] };
    expect(roundScoringLosses(SIX, flipped, [], nameOf)).toEqual([]);
    expect(roundScoringLosses(null, flipped, [], nameOf)).toEqual([]);
  });

  it("names how many scores go and from which rounds when the count is lowered (UC-44 2b)", () => {
    const four = { ...SIX, rounds: SIX.rounds.slice(0, 4) };
    expect(roundScoringLosses(SIX, four, scored, nameOf)).toEqual([
      "Cutting the night to 4 rounds discards 3 scores, from Round 5 and Final.",
    ]);
  });

  it("names the rounds by the name they were given, Round N otherwise", () => {
    const two = { ...SIX, rounds: SIX.rounds.slice(0, 2) };
    const [said] = roundScoringLosses(SIX, two, [...scored, row(3, "cass")], nameOf);
    expect(said).toBe("Cutting the night to 2 rounds discards 4 scores, from Semis, Round 5 and Final.");
  });

  it("reads one round and one score in the singular", () => {
    const one = { ...SIX, rounds: SIX.rounds.slice(0, 1) };
    expect(roundScoringLosses(SIX, one, [row(1, "alice"), row(2, "bob")], nameOf)).toEqual([
      "Cutting the night to 1 round discards 1 score, from Round 2.",
    ]);
  });

  it("names how many awards go and to whom when an awarded bonus is deleted (UC-44 4d)", () => {
    const without = { ...SIX, bonuses: [{ key: "Gold run", value: 5 }] };
    expect(roundScoringLosses(SIX, without, scored, nameOf)).toEqual([
      'Dropping "Sub-0.5 answer" takes back 3 awards, from Alice (x2) and Bob.',
    ]);
  });

  it("lets an unawarded bonus go without a word", () => {
    const without = { ...SIX, bonuses: [{ key: "Sub-0.5 answer", value: 2 }] };
    expect(roundScoringLosses(SIX, without, [row(1, "alice", { "Sub-0.5 answer": 1 })], nameOf)).toEqual(
      []
    );
  });

  it("treats a renamed bonus as the old one deleted, because the awards carry the old name", () => {
    // Task 86 decided an award whose key the setup no longer defines counts
    // nothing; this refusal is what makes that state unreachable.
    const renamed = { ...SIX, bonuses: [{ key: "Fast answer", value: 2 }, SIX.bonuses[1]] };
    expect(roundScoringLosses(SIX, renamed, scored, nameOf)).toEqual([
      'Dropping "Sub-0.5 answer" takes back 3 awards, from Alice (x2) and Bob.',
    ]);
  });

  it("does not count an award twice when its round is going anyway", () => {
    // Round 6 holds a "Sub-0.5 answer"; cutting to five takes it with the row,
    // so dropping the bonus as well takes back only the awards that survive.
    const both = { ...SIX, rounds: SIX.rounds.slice(0, 5), bonuses: [SIX.bonuses[1]] };
    expect(roundScoringLosses(SIX, both, scored, nameOf)).toEqual([
      "Cutting the night to 5 rounds discards 1 score, from Final.",
      'Dropping "Sub-0.5 answer" takes back 2 awards, from Alice (x2).',
    ]);
  });

  it("confirms a change of direction once scores exist, naming that the order inverts (UC-44 3a)", () => {
    const flipped = { ...SIX, lowWins: true };
    expect(roundScoringLosses(SIX, flipped, scored, nameOf)).toEqual([
      "Switching to lowest total wins turns the table upside down: the 5 scores already recorded rank the other way round.",
    ]);
    expect(roundScoringLosses(flipped, SIX, [row(1, "alice")], nameOf)).toEqual([
      "Switching to highest total wins turns the table upside down: the 1 score already recorded ranks the other way round.",
    ]);
  });

  it("does not ask about the direction when every recorded score is going anyway", () => {
    const flippedAndCut = { ...SIX, lowWins: true, rounds: SIX.rounds.slice(0, 1) };
    const losses = roundScoringLosses(SIX, flippedAndCut, [row(3, "alice"), row(4, "bob")], nameOf);
    expect(losses).toEqual(["Cutting the night to 1 round discards 2 scores, from Semis and Round 4."]);
  });

  it("lists all three, in the order the panel asks the questions", () => {
    const everything = {
      ...SIX,
      rounds: SIX.rounds.slice(0, 5),
      lowWins: true,
      bonuses: [SIX.bonuses[1]],
    };
    const losses = roundScoringLosses(SIX, everything, scored, nameOf);
    expect(losses.length).toBe(3);
    expect(losses[0]).toContain("Cutting the night");
    expect(losses[1]).toContain("Dropping");
    expect(losses[2]).toContain("upside down");
  });

  /*
   * Task 93 — the step UC-44 was missing. Turning round scoring off deletes
   * nothing; the decision `finishingOrdersFor` made for a shadowed typed order
   * is applied to the round rows in the same words: kept, never read, and
   * named on the screen that would have read them. So what is confirmed is a
   * naming, not a count, and the sentence says they come back as they are.
   */
  describe("turning round scoring off", () => {
    it("names every score on the board, by whose and which round, before anything is turned off", () => {
      expect(roundScoringLosses(SIX, null, scored, nameOf)).toEqual([
        "Turning round scoring off leaves 5 scores with nothing to read them: Alice in Round 1 and Round 5; Bob in Round 1 and Final; Cass in Round 5. They are kept, not deleted, and would be read again exactly as they are if this night were scored in rounds again.",
      ]);
    });

    it("asks nothing when the board is empty", () => {
      expect(roundScoringLosses(SIX, null, [], nameOf)).toEqual([]);
      expect(roundScoringLosses(null, null, [], nameOf)).toEqual([]);
    });

    it("reads one score in the singular", () => {
      expect(roundScoringLosses(SIX, null, [row(3, "cass")], nameOf)).toEqual([
        "Turning round scoring off leaves 1 score with nothing to read them: Cass in Semis. They are kept, not deleted, and would be read again exactly as they are if this night were scored in rounds again.",
      ]);
    });

    it("names the kept scores in name order, whatever order the rows arrive in", () => {
      // Task 88's note: rows within a round have no stable order.
      expect(scoresNamed(SIX, scored, nameOf)).toBe(
        "Alice in Round 1 and Round 5; Bob in Round 1 and Final; Cass in Round 5"
      );
      expect(scoresNamed(SIX, [...scored].reverse(), nameOf)).toBe(
        "Alice in Round 1 and Round 5; Bob in Round 1 and Final; Cass in Round 5"
      );
    });

    it("calls a round by its number once the setup that named it is gone", () => {
      // The panel's standing notice while the night is off: the setup — and
      // with it "Final" — is no longer stored, so each round is its number.
      expect(scoresNamed(null, scored, nameOf)).toBe(
        "Alice in Round 1 and Round 5; Bob in Round 1 and Round 6; Cass in Round 5"
      );
    });

    it("asks only that, never the three discards — nothing is cut, dropped or inverted", () => {
      const [said, ...rest] = roundScoringLosses(SIX, null, scored, nameOf);
      expect(rest).toEqual([]);
      // Task 78's `toContain` escape: no phrase from the other sentences.
      expect(said).not.toContain("Cutting");
      expect(said).not.toContain("Dropping");
      expect(said).not.toContain("upside down");
      expect(said).not.toContain("Two bonuses");
      expect(said).not.toContain("worth");
      // Nor `setPlacements`' or `saveRound`'s refusal, which it must not be mistaken for.
      expect(said).not.toContain("is scored in rounds, so");
      expect(said).not.toContain("not scored in rounds");
    });
  });

  it("turns the list into the refusal the action answers with, as one sentence set", () => {
    const losses = ["Cutting the night to 1 round discards 1 score, from Round 2."];
    expect(roundScoringConfirmRefusal(losses)).toBe(
      "Cutting the night to 1 round discards 1 score, from Round 2. Tick the box below to go ahead."
    );
    // Not a phrase any `roundScoringProblem` sentence carries.
    expect(roundScoringConfirmRefusal(losses)).not.toContain("Two bonuses");
    expect(roundScoringConfirmRefusal(losses)).not.toContain("worth");
  });
});
