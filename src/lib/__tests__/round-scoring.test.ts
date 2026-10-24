import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ROUNDS,
  type RoundScoreRow,
  type RoundSetup,
  rankRounds,
} from "@/lib/round-scoring";

/**
 * What a round-scored night's table says (UC-46 1, 2, 2a / R-228, R-231,
 * R-232, R-238; docs/decisions/006-round-scored-events.md).
 *
 * Plain data in, plain data out, and no randomness anywhere: every expected
 * answer below is written out by hand, so a wrong rule fails on a number a
 * reader can check against the fixture above it.
 *
 * **Every rule here is tested in both directions.** A points game (Popsauce,
 * highest total wins) and a placing game (Fall Guys, lowest total wins) are
 * the same table read the other way up, and each of the four rules has a
 * low-wins twin that the obvious implementation gets wrong — so a test that
 * only covers higher-wins is half a test.
 */

/** A night, with defaults so each test states only what it is about. */
function setup(over: Partial<RoundSetup> = {}): RoundSetup {
  return {
    lowWins: over.lowWins ?? false,
    bonuses: over.bonuses ?? [],
  };
}

/** One player's score in one round. */
function row(
  roundIndex: number,
  userId: string,
  score: number,
  bonuses: Record<string, number> = {}
): RoundScoreRow {
  return { roundIndex, userId, score, bonuses };
}

/** The ranking as `[userId, position, total]` triples, in order — what most of these assert. */
function table(setupIn: RoundSetup, rows: RoundScoreRow[]): Array<[string, number, number]> {
  return rankRounds(setupIn, rows).map((rank) => [rank.userId, rank.position, rank.total]);
}

/* ------------------------------------------------------------------ */
/* UC-46 1: every round added up                                      */
/* ------------------------------------------------------------------ */

describe("the total", () => {
  it("is every round added up, so the night's winner need not win any round", () => {
    // Ann takes round 1 outright and fades; Bob wins nothing and takes the night.
    const rows = [
      row(1, "ann", 10),
      row(1, "bob", 5),
      row(2, "ann", 1),
      row(2, "bob", 5),
      row(3, "ann", 1),
      row(3, "bob", 5),
    ];

    expect(table(setup(), rows)).toEqual([
      ["bob", 1, 15],
      ["ann", 2, 12],
    ]);
  });

  it("is every round added up when the lowest total wins, read the other way", () => {
    // Ann places 1st in round 1 and then last twice; Bob is 4th every time.
    const rows = [
      row(1, "ann", 1),
      row(1, "bob", 4),
      row(2, "ann", 9),
      row(2, "bob", 4),
      row(3, "ann", 9),
      row(3, "bob", 4),
    ];

    expect(table(setup({ lowWins: true }), rows)).toEqual([
      ["bob", 1, 12],
      ["ann", 2, 19],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-45 3a / R-228: a blank round                                    */
/* ------------------------------------------------------------------ */

describe("a blank round", () => {
  it("counts as that round's worst recorded score when the highest total wins", () => {
    // Bob sat out round 2. The worst anybody scored in it was Cat's 2, so Bob
    // takes 2 for it — not 0, which would be a 2-point gift nobody earned.
    const rows = [
      row(1, "ann", 10),
      row(1, "bob", 4),
      row(1, "cat", 7),
      row(2, "ann", 10),
      row(2, "cat", 2),
    ];

    expect(table(setup(), rows)).toEqual([
      ["ann", 1, 20],
      ["cat", 2, 9],
      ["bob", 3, 6],
    ]);
  });

  it("counts as that round's worst recorded score when the lowest total wins", () => {
    // The twin, and the case R-228 was written for: with low-wins a zero is
    // the best mark on the board, so `?? 0` would hand Bob the night for the
    // round he did not play. The worst recorded in round 2 is Cat's 5.
    const rows = [
      row(1, "ann", 1),
      row(1, "bob", 3),
      row(1, "cat", 2),
      row(2, "ann", 2),
      row(2, "cat", 5),
    ];

    expect(table(setup({ lowWins: true }), rows)).toEqual([
      ["ann", 1, 3],
      ["cat", 2, 7],
      ["bob", 3, 8],
    ]);
  });

  /**
   * The decision, pinned so the next reader knows it was chosen: "worst" is
   * worst *among the players who scored that round*, not worst anywhere in the
   * night. So a score arriving in a round moves what a blank in that round is
   * worth — which is right, because a blank means "finished behind everyone
   * who played", and who played is a fact about the round.
   */
  it("is worth whatever the round's scorers make it, so a new score in that round moves it", () => {
    const before = [row(1, "ann", 4), row(1, "bob", 4), row(1, "cat", 3), row(2, "ann", 10)];
    const after = [...before, row(2, "cat", 2)];

    // Alone in round 2, Ann's 10 is both the best and the worst recorded, so
    // Bob's and Cat's blanks are each worth 10 and Bob is level with her.
    expect(table(setup(), before)).toEqual([
      ["ann", 1, 14],
      ["bob", 1, 14],
      ["cat", 3, 13],
    ]);
    // Cat's 2 is now the worst in round 2, and Bob's blank is worth 2.
    expect(table(setup(), after)).toEqual([
      ["ann", 1, 14],
      ["bob", 2, 6],
      ["cat", 3, 5],
    ]);
  });

  it("in a round nobody scored changes nobody's total", () => {
    // The same two rounds, once numbered 1 and 2 and once 1 and 3. Round 2 in
    // the second night was never scored: it is a label with nothing under it,
    // not a round everybody was blank for.
    const consecutive = [row(1, "ann", 10), row(1, "bob", 4), row(2, "ann", 3), row(2, "bob", 8)];
    const withGap = [row(1, "ann", 10), row(1, "bob", 4), row(3, "ann", 3), row(3, "bob", 8)];

    expect(table(setup(), withGap)).toEqual(table(setup(), consecutive));
    expect(table(setup(), withGap)).toEqual([
      ["ann", 1, 13],
      ["bob", 2, 12],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* R-231 and the Constraint: a bonus is in the player's favour         */
/* ------------------------------------------------------------------ */

describe("a bonus", () => {
  const FAST = { key: "fast", value: 2 };

  it("adds when the highest total wins, as many times as it was earned", () => {
    const rows = [row(1, "ann", 10, { fast: 2 }), row(1, "bob", 10)];

    expect(table(setup({ bonuses: [FAST] }), rows)).toEqual([
      ["ann", 1, 14],
      ["bob", 2, 10],
    ]);
  });

  it("subtracts when the lowest total wins — the same bonus, the same value, the other arithmetic", () => {
    // The Constraint: a bonus helps the player whichever way the event scores.
    // Adding it here would turn a reward into a two-place penalty.
    const rows = [row(1, "ann", 10, { fast: 2 }), row(1, "bob", 10)];

    expect(table(setup({ lowWins: true, bonuses: [FAST] }), rows)).toEqual([
      ["ann", 1, 6],
      ["bob", 2, 10],
    ]);
  });

  /**
   * A key the setup does not define is worth nothing, in both directions.
   *
   * UC-44 4d refuses deleting an awarded bonus, so this should not happen; but
   * this ranking is read by the public page, so it stays total rather than
   * throwing — the same choice `scoreChampionship` makes for a member placed
   * twice.
   */
  it("that the setup does not define counts nothing", () => {
    const rows = [row(1, "ann", 10, { gone: 3 }), row(1, "bob", 10)];

    expect(table(setup({ bonuses: [FAST] }), rows)).toEqual([
      ["ann", 1, 10],
      ["bob", 1, 10],
    ]);
    expect(table(setup({ lowWins: true, bonuses: [FAST] }), rows)).toEqual([
      ["ann", 1, 10],
      ["bob", 1, 10],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-46 2a / R-232, R-238: equal totals share a place                 */
/* ------------------------------------------------------------------ */

describe("equal totals", () => {
  /**
   * The *shape* matters to code this module does not touch. `placementValue`
   * in `./championship-policy` reads `pointsTable[position - 1]`, so 1, 1, 3
   * pays the first row twice and nobody the second — which is what UC-46 5d
   * promises. 1, 1, 2 would quietly pay the second row to the third player.
   */
  it("share a place, and the place below is empty", () => {
    const rows = [row(1, "ann", 10), row(1, "bob", 10), row(1, "cat", 5)];

    expect(table(setup(), rows)).toEqual([
      ["ann", 1, 10],
      ["bob", 1, 10],
      ["cat", 3, 5],
    ]);
  });

  it("share a place lower down the table too, and skip the one below it", () => {
    const rows = [row(1, "ann", 10), row(1, "bob", 8), row(1, "cat", 8), row(1, "dan", 1)];

    expect(table(setup(), rows).map(([, position]) => position)).toEqual([1, 2, 2, 4]);
  });

  it("share a place when the lowest total wins", () => {
    const rows = [row(1, "ann", 3), row(1, "bob", 3), row(1, "cat", 9)];

    expect(table(setup({ lowWins: true }), rows)).toEqual([
      ["ann", 1, 3],
      ["bob", 1, 3],
      ["cat", 3, 9],
    ]);
  });

  it("are decided after the bonuses, not before them", () => {
    // Level on raw scores, split by a bonus; the place below the pair is 2, not 3.
    const rows = [row(1, "ann", 10), row(1, "bob", 10, { fast: 1 }), row(1, "cat", 10)];

    expect(table(setup({ bonuses: [{ key: "fast", value: 1 }] }), rows)).toEqual([
      ["bob", 1, 11],
      ["ann", 2, 10],
      ["cat", 2, 10],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-46 5a: a player with no score in any round                      */
/* ------------------------------------------------------------------ */

describe("a player with a score in no round", () => {
  /**
   * They were there and played nothing, which is not a finishing place; the
   * season gives them the taking-part points through UC-33 3b's existing path.
   * Decision 006 makes the absence of a row the only representation of "did
   * not play", so `rankRounds` takes rows and nothing else — there is no
   * participant list for such a player to be ranked last from.
   */
  it("is not in the ranking at all, rather than last in it", () => {
    const ranked = rankRounds(setup(), [row(1, "ann", 10), row(1, "bob", 4)]);

    expect(ranked.map((rank) => rank.userId)).toEqual(["ann", "bob"]);
    expect(rankRounds(setup(), [])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The module itself                                                  */
/* ------------------------------------------------------------------ */

describe("the module", () => {
  /**
   * Nothing in here may reach Postgres or import anything that does: the
   * ranking is read by a client component and previewed before anything is
   * saved. Asserted over the source rather than the module graph because an
   * `import type` leaves no trace at runtime and a value import of `@/db`
   * would drag drizzle into every screen that renders a table.
   */
  it("imports nothing", () => {
    const source = readFileSync(path.join("src", "lib", "round-scoring.ts"), "utf8");
    const imports = source.match(/^\s*import\b.*$/gm) ?? [];

    expect(source.length).toBeGreaterThan(100);
    expect(imports).toEqual([]);
  });

  it("caps a night at 32 rounds, the number the table's CHECK clause carries", () => {
    // Pinned against the live constraint in src/db/__tests__/round-scoring-max-rounds.test.ts.
    expect(MAX_ROUNDS).toBe(32);
  });
});
