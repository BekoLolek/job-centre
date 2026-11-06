import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Hero, HeroRole } from "@/db";
import type { StoredHand } from "@/lib/hero-hands";
import { type TalliedHand, type TalliedHero, heroNights } from "@/lib/hand-history";

/*
 * Task 102 — how many nights a hero has come up for one player (R-245 / UC-48
 * 5, 4c, 5a).
 *
 * `heroNights` is a decision over plain data for the reason `handSheet` is:
 * these lines decide what an admin believes about a run of repeats, and the
 * one rule that could silently answer a different question — a hero in two
 * slots of one hand is *one* night, not two cards — cannot be proved inside a
 * panel with nothing to click. So each mutation the task names has a test
 * built to die to it: count cards instead of nights, drop the sort, break the
 * tie order, list a never-dealt hero at zero.
 */

/* --- Fixtures ----------------------------------------------------- */

const ROLES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

/** The two fields the tally reads. The id defaults to the name, lower-cased. */
function hero(name: string, id = `hero-${name.toLowerCase().replace(/\s+/g, "-")}`): TalliedHero {
  return { id, name };
}

/**
 * One night: three lists, three to a role, named after the night so a reader
 * can tell which hand a hero came from. Any role may be overridden to put a
 * particular hero in a particular slot.
 */
function night(
  label: string,
  slots: Partial<Record<HeroRole, readonly TalliedHero[]>> = {}
): TalliedHand {
  const heroes = Object.fromEntries(
    ROLES.map((role) => [
      role,
      slots[role] ?? [1, 2, 3].map((n) => hero(`${label} ${role} ${n}`)),
    ])
  ) as Record<HeroRole, readonly TalliedHero[]>;
  return { heroes };
}

/** A full hero row, for the one test that hands in a `StoredHand` as hero-hands.ts builds it. */
function row(name: string, role: HeroRole): Hero {
  return {
    id: `hero-${name.toLowerCase().replace(/\s+/g, "-")}`,
    gameId: "game-1",
    name,
    roles: [role],
    retiredAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** The tally as `[name, nights]` pairs, which is what every ordering assertion reads. */
function asPairs(hands: readonly TalliedHand[]): [string, number][] {
  return heroNights(hands).map((entry) => [entry.hero.name, entry.nights]);
}

/* --- UC-48 5: every hero that has come up, and on how many nights --- */

describe("heroNights counts the nights each hero has come up", () => {
  it("gives every hero in a single hand one night", () => {
    const tally = heroNights([night("Mon")]);

    expect(tally).toHaveLength(9);
    expect(tally.map((entry) => entry.nights)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(tally.map((entry) => entry.hero.name).sort()).toEqual(
      ROLES.flatMap((role) => [1, 2, 3].map((n) => `Mon ${role} ${n}`)).sort()
    );
  });

  it("counts a hero once per hand it appears in, across hands", () => {
    const hulk = hero("Hulk");
    const hands = [
      night("Mon", { Vanguard: [hulk, hero("Mon V 2"), hero("Mon V 3")] }),
      night("Tue"),
      night("Wed", { Vanguard: [hero("Wed V 1"), hulk, hero("Wed V 3")] }),
    ];

    const tally = heroNights(hands);

    expect(tally.find((entry) => entry.hero.id === hulk.id)?.nights).toBe(2);
  });

  it("carries the hero's id and name so the screen can name the row", () => {
    const tally = heroNights([
      night("Mon", { Duelist: [hero("Hulk"), hero("Mon D 2"), hero("Mon D 3")] }),
    ]);

    expect(tally.find((entry) => entry.hero.name === "Hulk")?.hero).toMatchObject({
      id: "hero-hulk",
      name: "Hulk",
    });
  });

  it("accepts a StoredHand exactly as hero-hands.ts builds one", () => {
    // The sibling read returns `{ heroes: Record<HeroRole, Hero[]>; dealtAt }`.
    // This is a typecheck as much as a test: if `TalliedHand` ever drifted
    // from the stored shape, `tsc` would refuse this line.
    const stored: StoredHand = {
      heroes: Object.fromEntries(
        ROLES.map((role) => [role, [1, 2, 3].map((n) => row(`${role} ${n}`, role))])
      ) as Record<HeroRole, Hero[]>,
      dealtAt: new Date("2026-11-01T19:00:00Z"),
    };

    const tally = heroNights([stored]);

    expect(tally).toHaveLength(9);
    expect(tally.every((entry) => entry.nights === 1)).toBe(true);
  });
});

/* --- UC-48 4c: two slots in one hand is one night --------------------- */

describe("heroNights counts nights, not cards (R-245 / UC-48 4c)", () => {
  it("counts a hero dealt in two slots of one hand as one night", () => {
    // Deadpool is playable in all three roles, so one hand can name him twice.
    // The mutation this exists to kill: tallying every slot — which would say
    // "2 nights" for a hero that came up once.
    const deadpool = hero("Deadpool");
    const hands = [
      night("Mon", {
        Vanguard: [deadpool, hero("Mon V 2"), hero("Mon V 3")],
        Strategist: [hero("Mon S 1"), hero("Mon S 2"), deadpool],
      }),
    ];

    const tally = heroNights(hands);

    expect(tally.find((entry) => entry.hero.id === deadpool.id)?.nights).toBe(1);
    // And he is one row, not two.
    expect(tally.filter((entry) => entry.hero.id === deadpool.id)).toHaveLength(1);
    expect(tally).toHaveLength(8);
  });

  it("still counts each further night a double-slot hero comes up", () => {
    const deadpool = hero("Deadpool");
    const hands = [
      night("Mon", {
        Vanguard: [deadpool, hero("Mon V 2"), hero("Mon V 3")],
        Duelist: [deadpool, hero("Mon D 2"), hero("Mon D 3")],
      }),
      night("Tue", { Strategist: [hero("Tue S 1"), hero("Tue S 2"), deadpool] }),
    ];

    expect(asPairs(hands)[0]).toEqual(["Deadpool", 2]);
  });
});

/* --- R-245: most nights first, ties in a stated order ----------------- */

describe("heroNights orders the tally", () => {
  it("puts the hero with the most nights first, whatever order the hands name them in", () => {
    // Three nights for Hulk, two for Thor, one for everybody else — with Hulk
    // appearing *last* in every hand, so a tally that kept first-seen order
    // would list him last. The mutation this exists to kill: dropping the sort.
    const hulk = hero("Hulk");
    const thor = hero("Thor");
    const hands = [
      night("Mon", { Strategist: [hero("Mon S 1"), thor, hulk] }),
      night("Tue", { Strategist: [hero("Tue S 1"), thor, hulk] }),
      night("Wed", { Strategist: [hero("Wed S 1"), hero("Wed S 2"), hulk] }),
    ];

    const pairs = asPairs(hands);

    expect(pairs[0]).toEqual(["Hulk", 3]);
    expect(pairs[1]).toEqual(["Thor", 2]);
    expect(pairs.slice(2).every(([, nights]) => nights === 1)).toBe(true);
  });

  it("orders heroes on equal nights by name, so the screen reads the same way twice", () => {
    // Every hero here has one night, and they arrive in an order that is not
    // alphabetical. The mutation this exists to kill: any tie order other than
    // the stated one — reversing it, leaving the grouping's order, or falling
    // through to the id key. The ids are given explicitly, in the *reverse* of
    // the names' order: `hero()`'s default id is the name lower-cased, whose
    // code-point order mirrors the name's, and a fixture like that cannot tell
    // "sorted by name" from "sorted by id". With these ids, dropping the name
    // key lists Wolverine first.
    const hands = [
      night("Mon", {
        Vanguard: [hero("Venom", "id-2"), hero("Hulk", "id-7"), hero("Thor", "id-3")],
        Duelist: [hero("Wolverine", "id-1"), hero("Hawkeye", "id-8"), hero("Iron Man", "id-6")],
        Strategist: [hero("Loki", "id-5"), hero("Mantis", "id-4"), hero("Adam Warlock", "id-9")],
      }),
    ];

    expect(asPairs(hands).map(([name]) => name)).toEqual([
      "Adam Warlock",
      "Hawkeye",
      "Hulk",
      "Iron Man",
      "Loki",
      "Mantis",
      "Thor",
      "Venom",
      "Wolverine",
    ]);
  });

  it("orders two heroes of one name on equal nights by id, so two games' lists never reshuffle", () => {
    // A player's hands span events, and two games may each carry a "Hulk".
    // Name alone cannot separate them; the id can, and does so the same way
    // every read.
    const hands = [
      night("Mon", {
        Vanguard: [hero("Hulk", "zz-hulk"), hero("Hulk", "aa-hulk"), hero("Mon V 3")],
      }),
    ];

    const ids = heroNights(hands).map((entry) => entry.hero.id);

    expect(ids.slice(0, 2)).toEqual(["aa-hulk", "zz-hulk"]);
  });

  it("puts nights before name: a later-named hero with more nights comes first", () => {
    // "Zzz" has two nights and "Aaa" one. A sort that compared name first,
    // or compared nights ascending, would put Aaa first.
    const zzz = hero("Zzz");
    const hands = [
      night("Mon", { Vanguard: [hero("Aaa"), zzz, hero("Mon V 3")] }),
      night("Tue", { Vanguard: [hero("Tue V 1"), hero("Tue V 2"), zzz] }),
    ];

    expect(asPairs(hands)[0]).toEqual(["Zzz", 2]);
  });
});

/* --- UC-48 5a: a hero never dealt is absent, not zero ----------------- */

describe("heroNights lists what the player has had, not the catalogue (UC-48 5a)", () => {
  it("lists exactly the heroes dealt, every one on at least one night", () => {
    // The mutation this exists to kill: an entry at zero for a hero that never
    // came up. Nothing with zero nights may be in the tally, and nothing may be
    // in it that no hand named.
    const hands = [night("Mon"), night("Tue")];
    const dealt = new Set(
      hands.flatMap((hand) => Object.values(hand.heroes).flatMap((slot) => slot.map((h) => h.id)))
    );

    const tally = heroNights(hands);

    expect(tally.every((entry) => entry.nights >= 1)).toBe(true);
    expect(new Set(tally.map((entry) => entry.hero.id))).toEqual(dealt);
  });

  it("gives nothing for a player with no hands, rather than throwing", () => {
    expect(heroNights([])).toEqual([]);
  });
});

/* --- The boundary: no value import --------------------------------- */

describe("hand-history.ts is safe on both sides of the client boundary", () => {
  /*
   * A `"use client"` panel may hold this module, and the server page that
   * feeds it may too. `client-boundary.test.ts` sweeps for a named value
   * import *from* a client module; the matching hazard in this direction is
   * this module pulling a value from `@/db` or `@/lib/hero-hands` into the
   * browser bundle. Asserted the way that sweep (and `hands-sheet.test.ts`)
   * asserts: on the file's text, with the same `import … from` shape.
   */
  it("imports nothing but types", () => {
    const source = readFileSync(path.resolve(__dirname, "../hand-history.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)];

    expect(imports.length, "the sweep must see the module's imports").toBeGreaterThan(0);
    const values = imports.filter(([, clause]) => !/^type\b/.test(clause));
    expect(
      values.map(([line]) => line.trim()),
      "a value import here would ship Postgres to the browser"
    ).toEqual([]);
  });
});
