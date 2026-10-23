import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Hero, type HeroRole, games, heroes } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { RIVALS_HERO_POOLS, RIVALS_HEROES, seed } from "@/db/seed";
import { HERO_ROLES, drawableByRole, listHeroes, parseHeroRoles } from "@/lib/heroes";

/**
 * The hero catalogue, and the arithmetic the whole draw rests on.
 *
 * **15 / 28 / 13**, from 14 + 27 + 12 + Deadpool. The numbers are asserted here
 * rather than left as a comment because they are the thing a future edit is most
 * likely to break silently: adding a hero to one pool and forgetting the count,
 * or "fixing" Deadpool into a single role, changes nothing that any other test
 * in this suite can see. A role that falls below three stops being drawable at
 * all (UC-39 2a), so a pool quietly one short is a draw that refuses on the
 * night.
 */

/* ------------------------------------------------------------------ */
/* The roster, as data                                                */
/* ------------------------------------------------------------------ */

describe("HERO_ROLES", () => {
  it("is the three roles, in draw order, and nothing else", () => {
    const expected: HeroRole[] = ["Vanguard", "Duelist", "Strategist"];
    expect([...HERO_ROLES]).toEqual(expected);
  });
});

describe("the Rivals roster", () => {
  it("deals from pools of exactly 15 / 28 / 13", () => {
    expect({
      Vanguard: RIVALS_HERO_POOLS.Vanguard.length,
      Duelist: RIVALS_HERO_POOLS.Duelist.length,
      Strategist: RIVALS_HERO_POOLS.Strategist.length,
    }).toEqual({ Vanguard: 15, Duelist: 28, Strategist: 13 });
  });

  it("is 54 heroes: 14 + 27 + 12, plus one playable as all three", () => {
    const byRoleCount = (count: number) =>
      RIVALS_HEROES.filter((hero) => hero.roles.length === count);

    const vanguardOnly = byRoleCount(1).filter((hero) => hero.roles[0] === "Vanguard");
    const duelistOnly = byRoleCount(1).filter((hero) => hero.roles[0] === "Duelist");
    const strategistOnly = byRoleCount(1).filter((hero) => hero.roles[0] === "Strategist");

    expect({
      vanguardOnly: vanguardOnly.length,
      duelistOnly: duelistOnly.length,
      strategistOnly: strategistOnly.length,
      twoRoles: byRoleCount(2).length,
      threeRoles: byRoleCount(3).length,
      rows: RIVALS_HEROES.length,
    }).toEqual({
      vanguardOnly: 14,
      duelistOnly: 27,
      strategistOnly: 12,
      twoRoles: 0,
      threeRoles: 1,
      rows: 54,
    });

    // The identity, spelled out: the rows are the heroes, and the pools are
    // bigger than the rows by exactly the roles Deadpool holds beyond his first.
    expect(14 + 27 + 12 + 1).toBe(RIVALS_HEROES.length);
    expect(15 + 28 + 13).toBe(RIVALS_HEROES.length + 2);
  });

  it("names Deadpool as the hero in all three roles", () => {
    const multiRole = RIVALS_HEROES.filter((hero) => hero.roles.length > 1);
    expect(multiRole.map((hero) => hero.name)).toEqual(["Deadpool"]);
    expect(multiRole[0].roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("gives every hero at least one role", () => {
    expect(RIVALS_HEROES.filter((hero) => hero.roles.length === 0)).toEqual([]);
  });

  it("holds no role twice on one hero", () => {
    const repeated = RIVALS_HEROES.filter(
      (hero) => new Set(hero.roles).size !== hero.roles.length
    );
    expect(repeated.map((hero) => hero.name)).toEqual([]);
  });

  it("names each hero once", () => {
    const seen = new Map<string, number>();
    for (const hero of RIVALS_HEROES) seen.set(hero.name, (seen.get(hero.name) ?? 0) + 1);
    expect([...seen].filter(([, times]) => times > 1).map(([name]) => name)).toEqual([]);
    expect(seen.size).toBe(54);
  });

  it("carries no name that is blank or padded with spaces", () => {
    // " Thor" and "Thor" are two heroes to Postgres and one to a reader, so a
    // stray space would plant a 55th row and leave a pool one short.
    const suspect = RIVALS_HEROES.filter((hero) => hero.name !== hero.name.trim() || !hero.name);
    expect(suspect.map((hero) => hero.name)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* parseHeroRoles — the code half of UC-40 3b                         */
/* ------------------------------------------------------------------ */

describe("parseHeroRoles", () => {
  it("puts the roles into draw order whatever order they arrive in", () => {
    expect(parseHeroRoles(["Strategist", "Vanguard"])).toEqual(["Vanguard", "Strategist"]);
    expect(parseHeroRoles(["Strategist", "Duelist", "Vanguard"])).toEqual([
      "Vanguard",
      "Duelist",
      "Strategist",
    ]);
  });

  it("keeps a role once however many times it was ticked", () => {
    expect(parseHeroRoles(["Duelist", "Duelist", "Duelist"])).toEqual(["Duelist"]);
  });

  it("drops anything that is not one of the three", () => {
    expect(parseHeroRoles(["Duelist", "Healer", "strategist", "", null, 7])).toEqual([
      "Duelist",
    ]);
  });

  it("takes a single value as well as a list", () => {
    expect(parseHeroRoles("Vanguard")).toEqual(["Vanguard"]);
  });

  it("refuses by coming back empty, which every caller has to look at", () => {
    expect(parseHeroRoles([])).toEqual([]);
    expect(parseHeroRoles(undefined)).toEqual([]);
    expect(parseHeroRoles(null)).toEqual([]);
    expect(parseHeroRoles(["Healer"])).toEqual([]);
    expect(parseHeroRoles("vanguard")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* drawableByRole — pure                                              */
/* ------------------------------------------------------------------ */

/** A hero row without a database, for the grouping tests. */
function hero(name: string, roles: HeroRole[], retiredAt: Date | null = null): Hero {
  return {
    id: `id-${name}`,
    gameId: "game",
    name,
    roles,
    retiredAt,
    createdAt: new Date("2026-10-23T00:00:00Z"),
  };
}

describe("drawableByRole", () => {
  it("keys every role even when nothing holds it", () => {
    expect(drawableByRole([])).toEqual({ Vanguard: [], Duelist: [], Strategist: [] });
  });

  it("puts a hero in every role it holds, not just its first", () => {
    const pools = drawableByRole([
      hero("Hulk", ["Vanguard"]),
      hero("Deadpool", ["Vanguard", "Duelist", "Strategist"]),
      hero("Loki", ["Strategist"]),
    ]);

    expect({
      Vanguard: pools.Vanguard.map((row) => row.name),
      Duelist: pools.Duelist.map((row) => row.name),
      Strategist: pools.Strategist.map((row) => row.name),
    }).toEqual({
      Vanguard: ["Hulk", "Deadpool"],
      Duelist: ["Deadpool"],
      Strategist: ["Deadpool", "Loki"],
    });
  });

  it("leaves a retired hero out of every pool (UC-40 4a)", () => {
    const pools = drawableByRole([
      hero("Hulk", ["Vanguard"]),
      hero("Deadpool", ["Vanguard", "Duelist", "Strategist"], new Date("2026-10-23T12:00:00Z")),
    ]);

    expect({
      Vanguard: pools.Vanguard.map((row) => row.name),
      Duelist: pools.Duelist.map((row) => row.name),
      Strategist: pools.Strategist.map((row) => row.name),
    }).toEqual({ Vanguard: ["Hulk"], Duelist: [], Strategist: [] });
  });
});

/* ------------------------------------------------------------------ */
/* Against the seeded database                                        */
/* ------------------------------------------------------------------ */

describe("the seeded catalogue", () => {
  let ctx: TestDatabase;
  let rivalsId: string;

  beforeAll(async () => {
    ctx = await freshDatabase();
    await seed(ctx.db, {});
    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    rivalsId = rivals.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("deals 15 / 28 / 13 from 54 rows on rivals", async () => {
    const catalogue = await listHeroes(rivalsId, ctx.db);
    expect(catalogue).toHaveLength(54);

    const pools = drawableByRole(catalogue);
    expect({
      Vanguard: pools.Vanguard.length,
      Duelist: pools.Duelist.length,
      Strategist: pools.Strategist.length,
    }).toEqual({ Vanguard: 15, Duelist: 28, Strategist: 13 });
  });

  it("stores Deadpool's three roles as three roles", async () => {
    const [deadpool] = await ctx.db
      .select({ roles: heroes.roles })
      .from(heroes)
      .where(eq(heroes.name, "Deadpool"));
    expect(deadpool.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("lists them by name", async () => {
    const catalogue = await listHeroes(rivalsId, ctx.db);
    expect(catalogue[0].name).toBe("Adam Warlock");
    expect(catalogue.at(-1)?.name).toBe("Wolverine");
    expect(catalogue.map((row) => row.name)).toEqual(
      [...catalogue.map((row) => row.name)].sort()
    );
  });

  it("gives jackbox no heroes at all, rather than an empty list of its own", async () => {
    const [jackbox] = await ctx.db.select().from(games).where(eq(games.key, "jackbox"));
    expect(await listHeroes(jackbox.id, ctx.db)).toEqual([]);
  });
});

describe("retiring a seeded hero", () => {
  let ctx: TestDatabase;

  beforeEach(async () => {
    ctx = await freshDatabase();
    await seed(ctx.db, {});
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("takes it out of its pool and leaves the row where it is", async () => {
    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    await ctx.db
      .update(heroes)
      .set({ retiredAt: new Date("2026-10-23T12:00:00Z") })
      .where(eq(heroes.name, "Deadpool"));

    const catalogue = await listHeroes(rivals.id, ctx.db);
    // Still 54 rows: a hand that was dealt Deadpool still names him (UC-40 4a).
    expect(catalogue).toHaveLength(54);
    expect(catalogue.map((row) => row.name)).toContain("Deadpool");

    const pools = drawableByRole(catalogue);
    expect({
      Vanguard: pools.Vanguard.length,
      Duelist: pools.Duelist.length,
      Strategist: pools.Strategist.length,
    }).toEqual({ Vanguard: 14, Duelist: 27, Strategist: 12 });
  });
});
