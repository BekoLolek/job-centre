import { afterEach, describe, expect, it } from "vitest";
import type { Hero, HeroRole } from "@/db";
import { HERO_ROLES } from "@/lib/heroes";
import { HEROES_PER_ROLE, drawHand } from "@/lib/heroes-policy";

/**
 * The draw, as arithmetic (R-209, R-210 / UC-39 4, 4a, 2a).
 *
 * Three things are hard about this file and nothing else is. **Is the hand
 * predictable from a known sequence** — asserted twice, once from numbers a
 * reader can redo on paper and once from a seeded generator, so a change to
 * either the shuffle or the order the roles consume it is caught. **Can every
 * hero in a pool actually be dealt** — asserted by enumerating the whole output
 * space of a four-hero pool and by aiming a draw at each of the 15 / 28 / 13
 * heroes in turn, because a shuffle that can never deal its last element still
 * looks random and a single run passes either way. And **is a thin role refused
 * before anything is dealt**, which is asserted by handing the draw a generator
 * that throws: a refusal that has already rolled is a refusal that nearly dealt.
 *
 * Nothing here calls `Math.random`, and the last block proves that rather than
 * asserting it.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A hero row without a database — the same shape `heroes.test.ts` uses. */
function hero(name: string, roles: HeroRole[]): Hero {
  return {
    id: `id-${name}`,
    gameId: "game",
    name,
    roles,
    retiredAt: null,
    createdAt: new Date("2026-10-23T00:00:00Z"),
  };
}

/** `{ Vanguard: 15, ... }` into pools of distinctly named single-role heroes. */
function poolsOf(sizes: Record<HeroRole, number>): Record<HeroRole, Hero[]> {
  return {
    Vanguard: Array.from({ length: sizes.Vanguard }, (_, i) =>
      hero(`V${i + 1}`, ["Vanguard"])
    ),
    Duelist: Array.from({ length: sizes.Duelist }, (_, i) => hero(`D${i + 1}`, ["Duelist"])),
    Strategist: Array.from({ length: sizes.Strategist }, (_, i) =>
      hero(`S${i + 1}`, ["Strategist"])
    ),
  };
}

/** The real shape: 15 / 28 / 13, asserted against the roster in `heroes.test.ts`. */
const RIVALS_SHAPE: Record<HeroRole, number> = { Vanguard: 15, Duelist: 28, Strategist: 13 };

/**
 * A seeded generator — the "known sequence" the plan asks the test to hand in.
 *
 * A plain linear congruential generator, written out here rather than imported,
 * for the reason `random-teams.test.ts` gives: the *test* owns the numbers, so a
 * predicted hand is predicted from arithmetic anybody can redo and changes only
 * if the draw changes.
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
    if (index >= draws.length) {
      throw new Error("the draw asked for more numbers than the test gave it");
    }
    return draws[index++];
  };
}

/** A generator that must never be reached. */
function thrower(): () => number {
  return () => {
    throw new Error("the draw rolled when it should have refused");
  };
}

function unwrap(result: ReturnType<typeof drawHand>) {
  if (!result.ok) throw new Error(result.error);
  return result.hand;
}

function refusal(result: ReturnType<typeof drawHand>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

const names = (hand: Record<HeroRole, Hero[]>) => ({
  Vanguard: hand.Vanguard.map((row) => row.name),
  Duelist: hand.Duelist.map((row) => row.name),
  Strategist: hand.Strategist.map((row) => row.name),
});

/* ------------------------------------------------------------------ */
/* Aiming the shuffle                                                 */
/* ------------------------------------------------------------------ */

/*
 * `shuffled` walks a pool of `n` from the back, drawing a partner for each
 * position `n-1 .. 1` from `0 .. index` inclusive — so it asks for exactly
 * `n - 1` numbers and the multiplier for the draw at `index` is `index + 1`.
 * The two helpers below are written against that and nothing else, which is why
 * they live here rather than in the module: they are the test's knowledge of the
 * shuffle, and if the shuffle changes they are supposed to break.
 */

/** Nudged off the boundary so `floor(random * n)` lands on the intended index. */
const AIM = 1e-6;

/** Draws that leave a pool of `n` exactly as it came in — every swap a no-op. */
function noOps(n: number): number[] {
  const draws: number[] = [];
  for (let index = n - 1; index > 0; index -= 1) draws.push(index / (index + 1) + AIM);
  return draws;
}

/**
 * Draws that put hero `target` of a pool of `n` at position 0, so it is the
 * first hero dealt in that role.
 *
 * Picking partner 0 at the top position moves that element to the front; doing
 * it again at the next position down moves *that* element to the front, and so
 * on. So `n - target` draws of zero walk hero `target` to the front, and the
 * remaining positions are held still. Hero 0 needs no walking at all — it is
 * already there — and asking for `n` zeros would overshoot it.
 */
function drawsBringingToFront(n: number, target: number): number[] {
  if (target === 0) return noOps(n);
  return [...Array.from({ length: n - target }, () => 0), ...noOps(target)];
}

/* ------------------------------------------------------------------ */
/* Nine heroes, three per role, distinct within a role (R-210)        */
/* ------------------------------------------------------------------ */

describe("the hand", () => {
  it("is nine heroes — three in each role", () => {
    const hand = unwrap(drawHand(poolsOf(RIVALS_SHAPE), seeded(11)));

    expect({
      Vanguard: hand.Vanguard.length,
      Duelist: hand.Duelist.length,
      Strategist: hand.Strategist.length,
    }).toEqual({ Vanguard: 3, Duelist: 3, Strategist: 3 });
    expect(HERO_ROLES.flatMap((role) => hand[role])).toHaveLength(9);
    expect(HEROES_PER_ROLE).toBe(3);
  });

  it("keys every role, in draw order", () => {
    const hand = unwrap(drawHand(poolsOf(RIVALS_SHAPE), seeded(12)));
    expect(Object.keys(hand)).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("deals three distinct heroes in each role, over 300 seeds (UC-39 4a)", () => {
    /*
     * The within-a-role promise (UC-39 4a) against the real pool sizes. What
     * this buys, stated rather than assumed: it is the test that fails if the
     * three are ever picked *independently* — three draws with replacement from
     * 13 Strategists collide about one hand in five, which is noticed on the
     * night and never in a single run. It is not the proof that a pool holding
     * the same hero twice is handled; that one is enumerated further down,
     * because a sweep of this generator turned out to pass with the handling
     * removed.
     */
    const pools = poolsOf(RIVALS_SHAPE);
    for (let seed = 1; seed <= 300; seed += 1) {
      const hand = unwrap(drawHand(pools, seeded(seed)));
      for (const role of HERO_ROLES) {
        expect(new Set(hand[role].map((row) => row.id)).size).toBe(HEROES_PER_ROLE);
      }
    }
  });

  it("deals only heroes that were in that role's pool", () => {
    const pools = poolsOf(RIVALS_SHAPE);
    for (let seed = 1; seed <= 300; seed += 1) {
      const hand = unwrap(drawHand(pools, seeded(seed)));
      for (const role of HERO_ROLES) {
        const allowed = new Set(pools[role].map((row) => row.id));
        for (const row of hand[role]) expect(allowed.has(row.id)).toBe(true);
      }
    }
  });

  it("leaves the pools it was handed alone", () => {
    const pools = poolsOf({ Vanguard: 4, Duelist: 4, Strategist: 4 });
    const before = names(pools);
    drawHand(pools, seeded(5));
    expect(names(pools)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* An exactly predicted hand (the plan's second criterion)            */
/* ------------------------------------------------------------------ */

describe("predicting the hand", () => {
  it("deals the exact nine a hand-worked sequence asks for", () => {
    /*
     * Seven numbers for pools of 4, 3 and 3 — `n - 1` each — consumed in
     * HERO_ROLES order. Worked through by hand so this expectation is derived
     * rather than recorded:
     *
     *   Vanguard [V1 V2 V3 V4]
     *     index 3, 0.5 * 4 -> 2: swap 3,2 -> V1 V2 V4 V3
     *     index 2, 0.0 * 3 -> 0: swap 2,0 -> V4 V2 V1 V3
     *     index 1, 0.9 * 2 -> 1: no-op   -> V4 V2 V1 V3   take V4 V2 V1
     *   Duelist [D1 D2 D3]
     *     index 2, 0.7 * 3 -> 2: no-op   -> D1 D2 D3
     *     index 1, 0.0 * 2 -> 0: swap 1,0 -> D2 D1 D3      take D2 D1 D3
     *   Strategist [S1 S2 S3]
     *     index 2, 0.0 * 3 -> 0: swap 2,0 -> S3 S2 S1
     *     index 1, 0.4 * 2 -> 0: swap 1,0 -> S2 S3 S1      take S2 S3 S1
     *
     * An eighth number would mean the draw ran a loop once too often, and
     * `fromList` throws rather than quietly handing back `undefined`.
     */
    const pools = poolsOf({ Vanguard: 4, Duelist: 3, Strategist: 3 });
    const hand = unwrap(drawHand(pools, fromList([0.5, 0, 0.9, 0.7, 0, 0, 0.4])));

    expect(names(hand)).toEqual({
      Vanguard: ["V4", "V2", "V1"],
      Duelist: ["D2", "D1", "D3"],
      Strategist: ["S2", "S3", "S1"],
    });
  });

  it("asks for exactly one number per pool position above the first", () => {
    // 14 + 27 + 12 = 53 numbers for the real pools. The count is part of the
    // prediction above: a role that burned a number it did not need would shift
    // every later role's hand.
    let asked = 0;
    drawHand(poolsOf(RIVALS_SHAPE), () => {
      asked += 1;
      return 0;
    });
    expect(asked).toBe(14 + 27 + 12);
  });

  it("consumes the generator Vanguard, then Duelist, then Strategist", () => {
    /*
     * The order is observable, not a comment: give all three roles pools of
     * three and aim the first pair of draws so that only the *first* role is
     * disturbed. If the roles were walked in any other order, a different role
     * would come out reordered.
     */
    const pools = poolsOf({ Vanguard: 3, Duelist: 3, Strategist: 3 });
    const hand = unwrap(drawHand(pools, fromList([0, 0, ...noOps(3), ...noOps(3)])));

    expect(names(hand)).toEqual({
      Vanguard: ["V2", "V3", "V1"],
      Duelist: ["D1", "D2", "D3"],
      Strategist: ["S1", "S2", "S3"],
    });
  });

  it("deals an exactly predicted hand from a seeded generator", () => {
    // The 15 / 28 / 13 pools and a known seed. Unlike the hand-worked case
    // above this expectation was computed once and pinned — it is the
    // change-detector, and the one above is the derivation.
    const hand = unwrap(drawHand(poolsOf(RIVALS_SHAPE), seeded(7)));
    expect(names(hand)).toEqual({
      Vanguard: ["V7", "V10", "V2"],
      Duelist: ["D18", "D22", "D9"],
      Strategist: ["S10", "S6", "S1"],
    });
  });

  it("deals a different, equally predicted hand from a different seed", () => {
    const hand = unwrap(drawHand(poolsOf(RIVALS_SHAPE), seeded(1)));
    expect(names(hand)).toEqual({
      Vanguard: ["V12", "V3", "V14"],
      Duelist: ["D1", "D11", "D15"],
      Strategist: ["S3", "S6", "S1"],
    });
  });
});

/* ------------------------------------------------------------------ */
/* Every hero is reachable (the plan's third criterion)               */
/* ------------------------------------------------------------------ */

describe("reachability", () => {
  it("can deal all 24 ordered threes of a four-hero pool — nobody is stranded", () => {
    /*
     * The off-by-one this block exists for: a partner drawn from
     * `0 .. index - 1` instead of `0 .. index` still shuffles and still looks
     * random, but collapses the four-hero pool's 24 reachable orders to 6, so
     * most of the threes below can never be dealt at all. Enumerating the whole
     * output space is the only assertion that sees it — any single run passes
     * either way, which is why `random-teams.ts` spells the multiplier out and
     * why mutating it to `index` is one of this task's mutations.
     *
     * Four heroes means three draws, of 4, 3 and 2 possible partners: 24
     * sequences, which must land on all 24 ordered threes. The other two roles
     * are held still so the only thing varying is the Vanguard draw.
     */
    const pools = poolsOf({ Vanguard: 4, Duelist: 3, Strategist: 3 });
    const held = [...noOps(3), ...noOps(3)];

    const seen = new Set<string>();
    for (let first = 0; first < 4; first += 1) {
      for (let second = 0; second < 3; second += 1) {
        for (let third = 0; third < 2; third += 1) {
          const draws = [first / 4 + AIM, second / 3 + AIM, third / 2 + AIM, ...held];
          seen.add(unwrap(drawHand(pools, fromList(draws))).Vanguard.map((r) => r.name).join(" "));
        }
      }
    }

    // All 24 ordered threes, built by plain nested loops rather than by
    // anything that shares code with the shuffle.
    const everyOrderedThree: string[] = [];
    const all = ["V1", "V2", "V3", "V4"];
    for (const a of all) {
      for (const b of all) {
        for (const c of all) {
          if (a !== b && b !== c && a !== c) everyOrderedThree.push(`${a} ${b} ${c}`);
        }
      }
    }

    expect(everyOrderedThree).toHaveLength(24);
    expect([...seen].sort()).toEqual([...everyOrderedThree].sort());
  });

  it("can deal every one of the 15 / 28 / 13 heroes, including each pool's last", () => {
    /*
     * The same question at the real sizes, aimed rather than swept. A seed
     * sweep would be asserting that a weak test generator happens to emit a
     * small enough number early — a fact about the generator, not about the
     * draw — which is why Task 78 dropped its own sweep. These draws are
     * constructed, so the claim is exact: for each hero in each pool there is a
     * sequence that deals it first.
     */
    const pools = poolsOf(RIVALS_SHAPE);

    for (const role of HERO_ROLES) {
      const dealtFirst = new Set<string>();
      for (let target = 0; target < RIVALS_SHAPE[role]; target += 1) {
        const draws = HERO_ROLES.flatMap((each) =>
          each === role
            ? drawsBringingToFront(RIVALS_SHAPE[each], target)
            : noOps(RIVALS_SHAPE[each])
        );
        const hand = unwrap(drawHand(pools, fromList(draws)));
        dealtFirst.add(hand[role][0].name);
        // The roles that were held still come out in pool order, which is what
        // makes the aimed role's result attributable to the aiming.
        for (const other of HERO_ROLES) {
          if (other === role) continue;
          expect(hand[other].map((r) => r.name)).toEqual(
            pools[other].slice(0, HEROES_PER_ROLE).map((r) => r.name)
          );
        }
      }
      expect(dealtFirst.size).toBe(RIVALS_SHAPE[role]);
      expect(dealtFirst.has(pools[role][RIVALS_SHAPE[role] - 1].name)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Deadpool (the multi-role Constraint, docs/requirements.md)         */
/* ------------------------------------------------------------------ */

describe("a hero playable in several roles", () => {
  /*
   * The Constraint at `docs/requirements.md:387` — "a hero may belong to more
   * than one role", Deadpool as Vanguard, Duelist *and* Strategist — read from
   * the draw's side. UC-40 3c is the admin accepting such a hero onto the list,
   * which is Task 73's; what is asserted here is only that the draw deals him.
   */
  /** Deadpool, plus three single-role heroes per pool so he is never forced. */
  function poolsWithDeadpool(): Record<HeroRole, Hero[]> {
    const deadpool = hero("Deadpool", ["Vanguard", "Duelist", "Strategist"]);
    const base = poolsOf({ Vanguard: 3, Duelist: 3, Strategist: 3 });
    return {
      Vanguard: [...base.Vanguard, deadpool],
      Duelist: [...base.Duelist, deadpool],
      Strategist: [...base.Strategist, deadpool],
    };
  }

  it("can be dealt in any one role, from the back of that pool", () => {
    const pools = poolsWithDeadpool();
    for (const role of HERO_ROLES) {
      const draws = HERO_ROLES.flatMap((each) =>
        each === role ? drawsBringingToFront(4, 3) : noOps(4)
      );
      const hand = unwrap(drawHand(pools, fromList(draws)));
      expect(hand[role][0].name).toBe("Deadpool");
    }
  });

  it("may appear in more than one of a player's role-sets at once", () => {
    /*
     * Not a bug and the first thing anyone will report as one: the three draws
     * are three separate draws from three separate pools, so a hero holding
     * three roles can legitimately be held three times. Aimed in all three
     * roles at once so this does not depend on a lucky seed.
     */
    const pools = poolsWithDeadpool();
    const hand = unwrap(
      drawHand(pools, fromList(HERO_ROLES.flatMap(() => drawsBringingToFront(4, 3))))
    );

    expect(HERO_ROLES.filter((role) => hand[role].some((r) => r.name === "Deadpool"))).toEqual([
      "Vanguard",
      "Duelist",
      "Strategist",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* A role too thin to deal from (UC-39 2a)                            */
/* ------------------------------------------------------------------ */

describe("refusing a thin role", () => {
  it("refuses by name, and nothing is dealt", () => {
    const result = drawHand(poolsOf({ Vanguard: 15, Duelist: 28, Strategist: 2 }), thrower());

    expect(result.ok).toBe(false);
    // Exact, not a substring: a `toContain` on "needs 3 in each role" would
    // also pass for a refusal naming the wrong role, which is the whole content
    // of UC-39 2a. The other two roles are named nowhere in it.
    expect(refusal(result)).toBe(
      "Strategist has 2 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
    expect(refusal(result)).not.toContain("Vanguard");
    expect(refusal(result)).not.toContain("Duelist");
  });

  it("refuses before it rolls — the generator is never called", () => {
    /*
     * "Refused before any draw" is the use-case's wording and it is the half a
     * result-shape assertion cannot see: a draw that dealt nine and then threw
     * the hand away also returns `ok: false`. A generator that throws on its
     * first call is what tells the two apart.
     */
    expect(() =>
      drawHand(poolsOf({ Vanguard: 15, Duelist: 28, Strategist: 2 }), thrower())
    ).not.toThrow();
  });

  it("names a role holding nothing at all", () => {
    const result = drawHand(poolsOf({ Vanguard: 15, Duelist: 0, Strategist: 13 }), thrower());
    expect(refusal(result)).toBe(
      "Duelist has 0 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("reads a role holding one hero as singular", () => {
    const result = drawHand(poolsOf({ Vanguard: 1, Duelist: 28, Strategist: 13 }), thrower());
    expect(refusal(result)).toBe(
      "Vanguard has 1 hero. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("names every thin role rather than the first one it finds", () => {
    // An admin who fixes one role and is refused again learns the count one
    // deployment at a time.
    const result = drawHand(poolsOf({ Vanguard: 15, Duelist: 1, Strategist: 0 }), thrower());
    expect(refusal(result)).toBe(
      "Duelist has 1 hero and Strategist has 0 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("lists three thin roles with commas and a final and", () => {
    const result = drawHand(poolsOf({ Vanguard: 2, Duelist: 2, Strategist: 2 }), thrower());
    expect(refusal(result)).toBe(
      "Vanguard has 2 heroes, Duelist has 2 heroes and Strategist has 2 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("refuses an empty catalogue by naming all three roles", () => {
    const result = drawHand(poolsOf({ Vanguard: 0, Duelist: 0, Strategist: 0 }), thrower());
    expect(refusal(result)).toBe(
      "Vanguard has 0 heroes, Duelist has 0 heroes and Strategist has 0 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("deals from exactly three and refuses at exactly two — the boundary both ways", () => {
    // Three is enough: the hand is the pool, in whatever order.
    const three = unwrap(drawHand(poolsOf({ Vanguard: 3, Duelist: 3, Strategist: 3 }), seeded(4)));
    expect(three.Strategist.map((r) => r.name).sort()).toEqual(["S1", "S2", "S3"]);

    expect(drawHand(poolsOf({ Vanguard: 3, Duelist: 3, Strategist: 2 }), thrower()).ok).toBe(false);
  });

  it("counts a hero listed twice in one pool once, and refuses on the shortfall", () => {
    /*
     * `drawableByRole` cannot produce this today, because the database refuses a
     * `roles` array holding the same role twice. It is guarded anyway because
     * the distinctness promise is this module's: a pool of three rows holding
     * two heroes clears a naive length check and then deals one hero twice,
     * which is the wasted roll the whole criterion is about.
     */
    const twice = hero("V1", ["Vanguard"]);
    const result = drawHand(
      {
        Vanguard: [twice, twice, hero("V2", ["Vanguard"])],
        Duelist: poolsOf(RIVALS_SHAPE).Duelist,
        Strategist: poolsOf(RIVALS_SHAPE).Strategist,
      },
      thrower()
    );

    expect(refusal(result)).toBe(
      "Vanguard has 2 heroes. A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("deals three distinct heroes from a repeat-padded pool, in every possible order", () => {
    /*
     * Enumerated, not swept, and the reason is worth keeping because it cost a
     * pass of this very test.
     *
     * The honest-looking version of this ran 300 seeds of the LCG above and
     * passed **with the de-duplication removed**. Four rows holding three
     * heroes deal three distinct ones whenever a repeat lands in the position
     * that is not taken, which is half of all orders — so a sweep should have
     * caught it within a handful of seeds. It never did, because the
     * generator's *first* output lies in roughly 0.236 to 0.353 for every small
     * seed, `floor(x * 4)` is therefore always 0 or 1, and the first swap
     * always parked one of the two copies in the position that gets dropped.
     * The sweep was asserting a property of the test's LCG, which is the same
     * trap Task 78 dropped its own seed sweep over.
     *
     * Three draws of 4, 3 and 2 partners is 24 sequences and that is the whole
     * output space, so this needs no generator to be lucky.
     */
    const twice = hero("V1", ["Vanguard"]);
    const pools = {
      ...poolsOf({ Vanguard: 0, Duelist: 3, Strategist: 3 }),
      Vanguard: [twice, twice, hero("V2", ["Vanguard"]), hero("V3", ["Vanguard"])],
    };
    const held = [...noOps(3), ...noOps(3)];

    let orders = 0;
    for (let first = 0; first < 4; first += 1) {
      for (let second = 0; second < 3; second += 1) {
        for (let third = 0; third < 2; third += 1) {
          const draws = [first / 4 + AIM, second / 3 + AIM, third / 2 + AIM, ...held];
          const hand = unwrap(drawHand(pools, fromList(draws)));
          expect(hand.Vanguard.map((r) => r.name).sort()).toEqual(["V1", "V2", "V3"]);
          orders += 1;
        }
      }
    }
    expect(orders).toBe(24);
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

  it("deals a full hand with Math.random taken away entirely", () => {
    /*
     * Proved rather than asserted. A grep for `Math.random` in the module would
     * pass the day somebody reached for it through an alias or through a helper
     * two imports away, and a doc comment saying "injected" is not evidence.
     * Taking the global away and dealing a real hand is.
     */
    Math.random = () => {
      throw new Error("Math.random was called");
    };

    const hand = unwrap(drawHand(poolsOf(RIVALS_SHAPE), seeded(7)));
    expect(names(hand)).toEqual({
      Vanguard: ["V7", "V10", "V2"],
      Duelist: ["D18", "D22", "D9"],
      Strategist: ["S10", "S6", "S1"],
    });

    // And the refusal path, which does not roll at all.
    expect(drawHand(poolsOf({ Vanguard: 2, Duelist: 2, Strategist: 2 }), thrower()).ok).toBe(false);
  });
});
