import { afterEach, describe, expect, it } from "vitest";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { dealTeams, planTeams, shuffled } from "@/lib/random-teams";

/**
 * The arithmetic and the shuffle behind UC-41 (R-216).
 *
 * `random-teams-db.test.ts` proves the write; this file proves the only two
 * things that are hard about the pure half. **Is the shuffle actually
 * uniform** — asserted by enumerating the whole output space of a three-player
 * shuffle rather than by looking at one run, because "it came out different
 * that time" is what the broken version also does. And **do the sizes add up**
 * — including the case the use-case is specifically about, a count that does
 * not divide.
 *
 * Nothing here calls `Math.random`, and the last describe block proves that
 * rather than asserting it: it removes `Math.random` from the global object and
 * runs the whole shuffle again.
 */

/**
 * A seeded generator — the "known sequence" the plan asks the test to hand in.
 *
 * A plain linear congruential generator, written out here rather than
 * imported, because the point is that the *test* owns the numbers: an
 * assignment predicted from this is predicted from arithmetic anybody can redo
 * on paper, and it changes only if the shuffle changes.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A generator that reads a fixed list, so a draw can be aimed exactly. */
function fromList(draws: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (index >= draws.length) throw new Error("the shuffle asked for more numbers than the test gave it");
    return draws[index++];
  };
}

const PEOPLE = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `p${index + 1}`);

function unwrap(result: ReturnType<typeof planTeams>) {
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

/* ------------------------------------------------------------------ */
/* The shuffle is uniform, and every seat is reachable                */
/* ------------------------------------------------------------------ */

describe("the shuffle", () => {
  it("produces an exactly predicted order from a known sequence", () => {
    // Five draws for six items: positions 5 down to 1, and nothing for
    // position 0, which has no partner left to draw from. A sixth draw would
    // mean the loop ran once too often, and `fromList` throws rather than
    // quietly returning undefined.
    expect(shuffled(["a", "b", "c", "d", "e", "f"], fromList([0.9, 0.1, 0.5, 0.8, 0.3]))).toEqual(
      ["b", "e", "d", "c", "a", "f"]
    );
  });

  it("asks for exactly one number per position above the first", () => {
    let asked = 0;
    shuffled(PEOPLE(6), () => {
      asked += 1;
      return 0;
    });
    // Five, not six: the final iteration would swap element 0 with itself and
    // burn a number, which is what makes a predicted assignment unpredictable.
    expect(asked).toBe(5);
  });

  it("can reach every one of the six orders of three players — nobody is stranded", () => {
    /*
     * The off-by-one this is here for: a partner drawn from `0 .. index - 1`
     * instead of `0 .. index` still shuffles, still looks random, and makes a
     * third of the permutations unreachable. Enumerating the whole space is
     * the only assertion that sees it — a single run passes either way.
     *
     * Three items means two draws, of 3 and 2 possible values: six sequences,
     * which must map onto all six permutations.
     */
    const seen = new Set<string>();
    for (let first = 0; first < 3; first += 1) {
      for (let second = 0; second < 2; second += 1) {
        // Nudged off the boundary so `floor(random * n)` lands on the intended
        // index rather than on the edge between two of them.
        const draws = [first / 3 + 0.0001, second / 2 + 0.0001];
        seen.add(shuffled(["x", "y", "z"], fromList(draws)).join(""));
      }
    }

    expect([...seen].sort()).toEqual(["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"]);
  });

  it("lets the last player stay last — the placement the off-by-one forbids", () => {
    /*
     * The sharpest single assertion against `random() * index`. Under that bug
     * the partner for position `index` is drawn from `0 .. index - 1`, so the
     * element sitting at the top can never be chosen as its own partner and is
     * therefore *always* moved. A draw of 0.9 over six items picks partner 5
     * for position 5, which is a no-op, and p6 stays where it started.
     *
     * Aimed with an explicit draw rather than swept over seeds: whether a weak
     * generator happens to emit a number below 1/6 in its first few outputs is
     * a fact about the generator, not about the shuffle.
     */
    expect(shuffled(PEOPLE(6), fromList([0.9, 0, 0, 0, 0]))).toEqual([
      "p2",
      "p3",
      "p4",
      "p5",
      "p1",
      "p6",
    ]);
  });

  it("can move the first player to the last seat and the last to the first", () => {
    // The other end of the same question, and the one a reader checks first.
    expect(shuffled(PEOPLE(6), fromList([0, 0.5, 0.5, 0.5, 0.5]))).toEqual([
      "p6",
      "p4",
      "p2",
      "p5",
      "p3",
      "p1",
    ]);
  });

  it("keeps everybody and invents nobody", () => {
    const order = shuffled(PEOPLE(14), seeded(99));
    expect([...order].sort()).toEqual([...PEOPLE(14)].sort());
  });

  it("leaves the list it was given alone", () => {
    const people = PEOPLE(5);
    shuffled(people, seeded(3));
    expect(people).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });
});

/* ------------------------------------------------------------------ */
/* How many teams, and how big (UC-41 4, 4a, 4b)                      */
/* ------------------------------------------------------------------ */

describe("planning the teams", () => {
  it("divides evenly when it can — twelve at six a side is two full teams", () => {
    expect(unwrap(planTeams(12, 6))).toEqual({ teams: 2, sizes: [6, 6], short: [] });
  });

  it("spreads the remainder one per team rather than leaving one team short (UC-41 4a)", () => {
    /*
     * The headline case. Sixteen players at six a side is three teams, and the
     * naive answer is 6, 6, 4 — one team two players light while the others
     * are full, which on the night is the team that cannot field a comp. The
     * rule is one extra per team until the remainder runs out.
     */
    expect(unwrap(planTeams(16, 6)).sizes).toEqual([6, 5, 5]);
    expect(unwrap(planTeams(16, 6)).sizes).not.toEqual([6, 6, 4]);
  });

  it("never lets two teams differ by more than one player", () => {
    // The property the round-robin spread is for, over every count that makes
    // a legal number of teams at both sizes.
    for (const teamSize of [3, 6]) {
      for (let people = teamSize + 1; people <= teamSize * MAX_TEAMS; people += 1) {
        const plan = unwrap(planTeams(people, teamSize));
        expect(Math.max(...plan.sizes) - Math.min(...plan.sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("seats everybody — the sizes always add back up to the people", () => {
    for (const teamSize of [3, 6]) {
      for (let people = teamSize + 1; people <= teamSize * MAX_TEAMS; people += 1) {
        const plan = unwrap(planTeams(people, teamSize));
        expect(plan.sizes.reduce((sum, size) => sum + size, 0)).toBe(people);
      }
    }
  });

  it("names which teams are short, by position, and says nothing when none are", () => {
    expect(unwrap(planTeams(16, 6)).short).toEqual([2, 3]);
    expect(unwrap(planTeams(11, 6)).short).toEqual([2]);
    expect(unwrap(planTeams(17, 6)).short).toEqual([3]);
    expect(unwrap(planTeams(12, 6)).short).toEqual([]);
    expect(unwrap(planTeams(9, 3)).short).toEqual([]);
  });

  it("sizes 3v3 teams at three, not at six", () => {
    // The whole reason the format is stored: the same head count makes
    // different teams depending on the admin's call, and the site follows it
    // rather than guessing.
    expect(unwrap(planTeams(12, 3)).sizes).toEqual([3, 3, 3, 3]);
    expect(unwrap(planTeams(12, 6)).sizes).toEqual([6, 6]);
  });

  it("marks every team short when there are barely enough for two", () => {
    expect(unwrap(planTeams(8, 6))).toEqual({ teams: 2, sizes: [4, 4], short: [1, 2] });
  });
});

/* ------------------------------------------------------------------ */
/* The refusals (UC-41 4b)                                            */
/* ------------------------------------------------------------------ */

describe("refusing to plan", () => {
  it("names the count and the team size when there are too few people (UC-41 4b)", () => {
    const result = planTeams(4, 6);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // Both numbers, because "not enough players" leaves the admin to work out
    // how many more they need.
    expect(result.error).toContain("4");
    expect(result.error).toContain("6");
  });

  it("reads one player as singular", () => {
    const result = planTeams(1, 6);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("1 player is");
  });

  it(`refuses one team's worth exactly — ${MIN_TEAMS} teams is the minimum`, () => {
    const result = planTeams(6, 6);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("one team");
    expect(result.error).toContain(String(MIN_TEAMS));
  });

  it("accepts one more than that, which is two sides", () => {
    expect(unwrap(planTeams(7, 6)).teams).toBe(2);
  });

  it(`refuses more than ${MAX_TEAMS} teams' worth, naming the figure it would need`, () => {
    const result = planTeams(6 * MAX_TEAMS + 1, 6);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain(String(MAX_TEAMS + 1));
    expect(result.error).toContain(String(MAX_TEAMS));
  });

  it("accepts exactly the ceiling", () => {
    expect(unwrap(planTeams(6 * MAX_TEAMS, 6)).teams).toBe(MAX_TEAMS);
  });

  it("refuses a nonsense team size or head count rather than dividing by it", () => {
    expect(planTeams(12, 0).ok).toBe(false);
    expect(planTeams(12, -6).ok).toBe(false);
    expect(planTeams(12, 2.5).ok).toBe(false);
    expect(planTeams(-1, 6).ok).toBe(false);
    expect(planTeams(6.5, 6).ok).toBe(false);
    expect(planTeams(Number.NaN, 6).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Dealing them out                                                   */
/* ------------------------------------------------------------------ */

describe("dealing the teams", () => {
  it("produces an exactly predicted assignment from a seeded generator", () => {
    // Fourteen players at six a side: three teams of 5, 5, 4. The expectation
    // below is the output of this generator and this shuffle, computed once
    // and pinned — if either changes, this is the test that says so.
    const plan = unwrap(planTeams(14, 6));
    expect(plan.sizes).toEqual([5, 5, 4]);

    expect(dealTeams(PEOPLE(14), plan, seeded(7))).toEqual([
      ["p9", "p6", "p2", "p14", "p5"],
      ["p7", "p10", "p3", "p13", "p1"],
      ["p11", "p8", "p12", "p4"],
    ]);
  });

  it("produces a different, equally predicted assignment from a different seed", () => {
    const plan = unwrap(planTeams(12, 6));
    expect(dealTeams(PEOPLE(12), plan, seeded(1))).toEqual([
      ["p10", "p4", "p2", "p8", "p9", "p11"],
      ["p12", "p1", "p7", "p6", "p5", "p3"],
    ]);
  });

  it("deals every player exactly once, over many seeds", () => {
    const plan = unwrap(planTeams(14, 6));
    for (let seed = 1; seed <= 200; seed += 1) {
      const dealt = dealTeams(PEOPLE(14), plan, seeded(seed));
      expect(dealt.flat().sort()).toEqual([...PEOPLE(14)].sort());
      expect(dealt.map((squad) => squad.length)).toEqual([5, 5, 4]);
    }
  });

  it("can put any player on any team — nobody is stuck on team one", () => {
    // The dealing counterpart of the reachability test above: a shuffle with
    // an unreachable tail would show up as a player who never leaves the first
    // slice.
    const plan = unwrap(planTeams(12, 6));
    const seatsFor = new Map<string, Set<number>>();
    for (let seed = 1; seed <= 300; seed += 1) {
      dealTeams(PEOPLE(12), plan, seeded(seed)).forEach((squad, team) => {
        for (const userId of squad) {
          const seats = seatsFor.get(userId) ?? new Set<number>();
          seats.add(team);
          seatsFor.set(userId, seats);
        }
      });
    }
    for (const userId of PEOPLE(12)) {
      expect([...(seatsFor.get(userId) ?? [])].sort()).toEqual([0, 1]);
    }
  });

  it("refuses a plan made for a different number of people", () => {
    // Otherwise the mismatch is a silently short roster rather than an error.
    const plan = unwrap(planTeams(12, 6));
    expect(() => dealTeams(PEOPLE(11), plan, seeded(1))).toThrow(/12 players and 11/);
  });
});

/* ------------------------------------------------------------------ */
/* Randomness is injected, not called                                 */
/* ------------------------------------------------------------------ */

describe("where the randomness comes from", () => {
  const real = Math.random;

  afterEach(() => {
    Math.random = real;
  });

  it("works with Math.random taken away entirely", () => {
    /*
     * Proved rather than asserted. A grep for `Math.random` in the module
     * would pass the day somebody reached for it through an alias, and a
     * comment saying "injected" is not evidence. Taking the global away and
     * running the real work is.
     */
    Math.random = () => {
      throw new Error("Math.random was called");
    };

    const plan = unwrap(planTeams(12, 6));
    expect(dealTeams(PEOPLE(12), plan, seeded(1))).toEqual([
      ["p10", "p4", "p2", "p8", "p9", "p11"],
      ["p12", "p1", "p7", "p6", "p5", "p3"],
    ]);
    expect(shuffled(PEOPLE(6), seeded(2))).toHaveLength(6);
  });
});
