import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { games, heroes } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { RIVALS_HEROES, seed } from "@/db/seed";
import {
  HERO_GONE,
  HERO_NAME_REQUIRED,
  HERO_ROLE_REQUIRED,
  createHero,
  drawableByRole,
  heroNameTakenRefusal,
  listHeroes,
  listHeroesByGame,
  renameHero,
  restoreHero,
  retireHero,
  setHeroRoles,
} from "@/lib/heroes";

/**
 * The five writes behind the hero screen (R-214 / UC-40).
 *
 * Against a real Postgres, seeded, because **the 54 heroes are already live in
 * production** — the screen is editing real rows from its first load, not an
 * empty table — and because the two things under all of this are a unique
 * constraint and a check constraint, which only a real database has.
 *
 * ## What this file proves and what it cannot
 *
 * These are the library functions. A test here says nothing at all about
 * whether the screen calls them — that is the `roles={roles}` failure in
 * miniature, and it is the exact escape recorded against Task 78 — so the
 * screen's half is `src/components/admin/__tests__/hero-editor.test.ts`, which
 * renders the real component and reads the real page off disk.
 *
 * Every refusal is asserted with `toBe` on the whole sentence, never
 * `toContain` on a fragment. Task 78's 3b refusal went green for the wrong
 * reason because `toContain("Void those lots")` was also satisfied by a
 * *different* refusal that happened to contain the phrase. The three sentences
 * here deliberately share no phrase, and the `not.toBe` lines below are what
 * keeps that true.
 */

let ctx: TestDatabase;
let rivalsId: string;
let jackboxId: string;

beforeEach(async () => {
  ctx = await freshDatabase();
  await seed(ctx.db, {});
  const rows = await ctx.db.select().from(games);
  rivalsId = rows.find((game) => game.key === "rivals")!.id;
  jackboxId = rows.find((game) => game.key === "jackbox")!.id;
});

afterEach(async () => {
  await ctx.close();
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function refusal(result: { ok: true } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("Expected a refusal, got a success.");
  return result.error;
}

async function nameOf(heroId: string): Promise<string | undefined> {
  const [row] = await ctx.db.select().from(heroes).where(eq(heroes.id, heroId));
  return row?.name;
}

/* ------------------------------------------------------------------ */
/* The refusals are three different sentences                         */
/* ------------------------------------------------------------------ */

describe("the refusals", () => {
  it("share no sentence, so no assertion on one can be satisfied by another", () => {
    const all = [HERO_NAME_REQUIRED, HERO_ROLE_REQUIRED, HERO_GONE, heroNameTakenRefusal("Hulk")];
    expect(new Set(all).size).toBe(all.length);
    // And none is a substring of another, which is what a `toContain` would hit.
    for (const one of all) {
      for (const other of all) {
        if (one !== other) expect(other.includes(one)).toBe(false);
      }
    }
  });

  it("names the hero the new name clashes with", () => {
    expect(heroNameTakenRefusal("Venom")).toBe("Venom is already on this game's hero list.");
  });
});

/* ------------------------------------------------------------------ */
/* Add (UC-40 3, 3a, 3b, 3c)                                          */
/* ------------------------------------------------------------------ */

describe("createHero", () => {
  it("adds a hero the next draw can deal (UC-40 3, 5)", async () => {
    const before = drawableByRole(await listHeroes(rivalsId, ctx.db)).Duelist.length;

    const created = unwrap(await createHero(rivalsId, "Nightcrawler", ["Duelist"], ctx.db));
    expect(created.name).toBe("Nightcrawler");
    expect(created.roles).toEqual(["Duelist"]);
    expect(created.retiredAt).toBeNull();

    const pools = drawableByRole(await listHeroes(rivalsId, ctx.db));
    expect(pools.Duelist.length).toBe(before + 1);
    expect(pools.Duelist.map((hero) => hero.name)).toContain("Nightcrawler");
  });

  it("takes all three roles at once (UC-40 3c — Deadpool is the case)", async () => {
    const created = unwrap(
      await createHero(rivalsId, "Silver Surfer", ["Strategist", "Vanguard"], ctx.db)
    );
    // Canonical order, not the order they were ticked in: `parseHeroRoles` owns
    // that and nothing here re-sorts.
    expect(created.roles).toEqual(["Vanguard", "Strategist"]);

    const all = unwrap(await createHero(rivalsId, "Sentry", ["Duelist", "Vanguard", "Strategist"], ctx.db));
    expect(all.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("refuses a name already on the list, naming it (UC-40 3a)", async () => {
    const result = await createHero(rivalsId, "Hulk", ["Vanguard"], ctx.db);
    expect(refusal(result)).toBe(heroNameTakenRefusal("Hulk"));
    expect(refusal(result)).not.toBe(HERO_ROLE_REQUIRED);
    // Nothing written: still 54 rows, and still one Hulk.
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("refuses a name that differs only in case or spacing, naming the stored one", async () => {
    // Postgres would store "hulk" beside "Hulk" quite happily —
    // `heroes_game_name_uniq` is on the exact bytes. This refusal is what stops
    // the admin creating a pair only a reader can tell apart, and it prints the
    // spelling that is actually there rather than the one they typed.
    expect(refusal(await createHero(rivalsId, "hulk", ["Vanguard"], ctx.db))).toBe(
      heroNameTakenRefusal("Hulk")
    );
    expect(refusal(await createHero(rivalsId, "  Hulk  ", ["Vanguard"], ctx.db))).toBe(
      heroNameTakenRefusal("Hulk")
    );
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("lets two games each have a hero of the same name", async () => {
    // The unique constraint is per *game*, and so is this check.
    const created = unwrap(await createHero(jackboxId, "Hulk", ["Vanguard"], ctx.db));
    expect(created.gameId).toBe(jackboxId);
    expect(await listHeroes(jackboxId, ctx.db)).toHaveLength(1);
  });

  it("refuses no role ticked, and says why a hero in no role is the list lying (UC-40 3b)", async () => {
    for (const nothing of [[], ["Healer"], ["strategist"], undefined, null]) {
      const result = await createHero(rivalsId, "Nobody", nothing, ctx.db);
      expect(refusal(result), JSON.stringify(nothing)).toBe(HERO_ROLE_REQUIRED);
    }
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("drops an unknown role and keeps the real ones rather than refusing the lot", async () => {
    // `parseHeroRoles` is the only validator and this is its documented
    // behaviour; a second one here would be a second answer to one question.
    const created = unwrap(await createHero(rivalsId, "Nightcrawler", ["Healer", "Duelist"], ctx.db));
    expect(created.roles).toEqual(["Duelist"]);
  });

  it("refuses a blank or whitespace name", async () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(refusal(await createHero(rivalsId, blank, ["Duelist"], ctx.db))).toBe(
        HERO_NAME_REQUIRED
      );
    }
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("stores a trimmed, space-collapsed name, so no padded row is planted", async () => {
    const created = unwrap(await createHero(rivalsId, "  Silver   Surfer ", ["Strategist"], ctx.db));
    expect(created.name).toBe("Silver Surfer");
  });
});

/* ------------------------------------------------------------------ */
/* Rename, and the (game, name) trap                                  */
/* ------------------------------------------------------------------ */

describe("renameHero", () => {
  async function hulk(): Promise<string> {
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.name, "Hulk"));
    return row.id;
  }

  it("keeps the hero's id, so every hand that holds it still does", async () => {
    const id = await hulk();
    const { hero, previousName } = unwrap(await renameHero(id, "The Hulk", ctx.db));
    expect(hero.id).toBe(id);
    expect(hero.name).toBe("The Hulk");
    expect(previousName).toBe("Hulk");
    // Still 54 rows — a rename is an update, not an insert.
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("returns the old name, which is the only place it survives the write", async () => {
    // There is no `key` column — Task 73 declined one and Task 77 may not add
    // a migration — so after this update the row has no memory of what the
    // hero used to be called. `hero.renamed`'s audit line is built from this
    // return value, and it is the only record of the rename there is.
    const id = await hulk();
    unwrap(await renameHero(id, "The Hulk", ctx.db));
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.id, id));
    expect(Object.values(row)).not.toContain("Hulk");
  });

  it("frees the old name, so the next seed plants it again as a second hero", async () => {
    /*
     * The trap itself, asserted rather than claimed. `plantHeroes` skips a
     * (game, name) pair that is **present** and cannot know one used to be, so
     * re-seeding after a rename leaves the roster's name occupied by a new row
     * beside the renamed one. `HeroEditor` warns about this before the write
     * and the audit line records both names, because nothing else can.
     */
    const id = await hulk();
    expect(RIVALS_HEROES.map((hero) => hero.name)).toContain("Hulk");

    unwrap(await renameHero(id, "The Hulk", ctx.db));
    await seed(ctx.db, {});

    const after = await listHeroes(rivalsId, ctx.db);
    expect(after).toHaveLength(55);
    const hulks = after.filter((hero) => hero.name === "Hulk" || hero.name === "The Hulk");
    expect(hulks.map((hero) => hero.name).sort()).toEqual(["Hulk", "The Hulk"]);
    // And the renamed one is still the original row, so a hand holding it is fine.
    expect(hulks.find((hero) => hero.name === "The Hulk")!.id).toBe(id);
  });

  it("refuses a rename onto another hero's name, naming it, and writes nothing", async () => {
    const id = await hulk();
    expect(refusal(await renameHero(id, "Venom", ctx.db))).toBe(heroNameTakenRefusal("Venom"));
    expect(await nameOf(id)).toBe("Hulk");
  });

  it("accepts a rename to the name it already has, which is not a clash with itself", async () => {
    const id = await hulk();
    const { previousName } = unwrap(await renameHero(id, "Hulk", ctx.db));
    expect(previousName).toBe("Hulk");
    expect(await nameOf(id)).toBe("Hulk");
  });

  it("refuses a blank name and writes nothing", async () => {
    const id = await hulk();
    expect(refusal(await renameHero(id, "  ", ctx.db))).toBe(HERO_NAME_REQUIRED);
    expect(await nameOf(id)).toBe("Hulk");
  });

  it("says so when the row has gone since the render", async () => {
    const id = await hulk();
    await ctx.db.delete(heroes).where(eq(heroes.id, id));
    expect(refusal(await renameHero(id, "The Hulk", ctx.db))).toBe(HERO_GONE);
  });
});

/* ------------------------------------------------------------------ */
/* Roles (UC-40 3b, 3c)                                               */
/* ------------------------------------------------------------------ */

describe("setHeroRoles", () => {
  async function deadpool(): Promise<string> {
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.name, "Deadpool"));
    return row.id;
  }

  it("changes the set a hero may be dealt in", async () => {
    const id = await deadpool();
    const updated = unwrap(await setHeroRoles(id, ["Duelist"], ctx.db));
    expect(updated.roles).toEqual(["Duelist"]);

    const pools = drawableByRole(await listHeroes(rivalsId, ctx.db));
    // 15 / 28 / 13 becomes 14 / 28 / 12: Deadpool leaves two pools and stays in one.
    expect({
      Vanguard: pools.Vanguard.length,
      Duelist: pools.Duelist.length,
      Strategist: pools.Strategist.length,
    }).toEqual({ Vanguard: 14, Duelist: 28, Strategist: 12 });
  });

  it("puts the roles in draw order whatever order the boxes were ticked in", async () => {
    const id = await deadpool();
    expect(unwrap(await setHeroRoles(id, ["Strategist", "Vanguard"], ctx.db)).roles).toEqual([
      "Vanguard",
      "Strategist",
    ]);
  });

  it("keeps all three (UC-40 3c)", async () => {
    const id = await deadpool();
    unwrap(await setHeroRoles(id, ["Duelist"], ctx.db));
    const back = unwrap(await setHeroRoles(id, ["Strategist", "Duelist", "Vanguard"], ctx.db));
    expect(back.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("refuses an empty set before the database has to (UC-40 3b)", async () => {
    const id = await deadpool();
    expect(refusal(await setHeroRoles(id, [], ctx.db))).toBe(HERO_ROLE_REQUIRED);
    // Unchanged — the refusal happened before the update, so there is no
    // half-written row and no Postgres error to show anybody.
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.id, id));
    expect(row.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("de-duplicates rather than letting the check constraint refuse it", async () => {
    const id = await deadpool();
    expect(unwrap(await setHeroRoles(id, ["Duelist", "Duelist"], ctx.db)).roles).toEqual([
      "Duelist",
    ]);
  });

  it("says so when the row has gone since the render", async () => {
    const id = await deadpool();
    await ctx.db.delete(heroes).where(eq(heroes.id, id));
    expect(refusal(await setHeroRoles(id, ["Duelist"], ctx.db))).toBe(HERO_GONE);
  });
});

/* ------------------------------------------------------------------ */
/* Retire and restore (UC-40 4a)                                      */
/* ------------------------------------------------------------------ */

describe("retireHero", () => {
  async function venom(): Promise<string> {
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.name, "Venom"));
    return row.id;
  }

  it("takes the hero out of future draws and leaves the row where it is", async () => {
    const id = await venom();
    const retired = unwrap(await retireHero(id, ctx.db, new Date("2026-10-23T12:00:00Z")));
    expect(retired.retiredAt).toEqual(new Date("2026-10-23T12:00:00Z"));

    const catalogue = await listHeroes(rivalsId, ctx.db);
    // The row is still there — a hand already dealt Venom still names it.
    expect(catalogue).toHaveLength(54);
    expect(catalogue.map((hero) => hero.name)).toContain("Venom");
    // And the pool it was in is one shorter.
    expect(drawableByRole(catalogue).Vanguard.map((hero) => hero.name)).not.toContain("Venom");
  });

  it("never deletes, whatever is asked of it", async () => {
    const id = await venom();
    unwrap(await retireHero(id, ctx.db));
    unwrap(await retireHero(id, ctx.db));
    expect(await listHeroes(rivalsId, ctx.db)).toHaveLength(54);
  });

  it("does not move the date when it is retired twice", async () => {
    const id = await venom();
    const first = new Date("2026-10-23T12:00:00Z");
    unwrap(await retireHero(id, ctx.db, first));
    const again = unwrap(await retireHero(id, ctx.db, new Date("2026-11-01T09:00:00Z")));
    expect(again.retiredAt).toEqual(first);
  });

  it("brings one back with restoreHero, and the row never left", async () => {
    const id = await venom();
    unwrap(await retireHero(id, ctx.db));
    const back = unwrap(await restoreHero(id, ctx.db));
    expect(back.retiredAt).toBeNull();
    expect(back.id).toBe(id);
    expect(drawableByRole(await listHeroes(rivalsId, ctx.db)).Vanguard.map((h) => h.name)).toContain(
      "Venom"
    );
  });

  it("says so when the row has gone since the render", async () => {
    const id = await venom();
    await ctx.db.delete(heroes).where(eq(heroes.id, id));
    expect(refusal(await retireHero(id, ctx.db))).toBe(HERO_GONE);
    expect(refusal(await restoreHero(id, ctx.db))).toBe(HERO_GONE);
  });

  it("can be added back by name once retired, because the name is still taken", async () => {
    // Worth pinning: retiring does **not** free the name, so "add it again"
    // is refused and pointed at the retired list rather than planting a second
    // row the admin then has two of.
    const id = await venom();
    unwrap(await retireHero(id, ctx.db));
    expect(refusal(await createHero(rivalsId, "Venom", ["Vanguard"], ctx.db))).toBe(
      heroNameTakenRefusal("Venom")
    );
  });
});

/* ------------------------------------------------------------------ */
/* The screen's loader                                                */
/* ------------------------------------------------------------------ */

describe("listHeroesByGame", () => {
  it("keys every game that has heroes, by name within each", async () => {
    const byGame = await listHeroesByGame(ctx.db);
    expect(Object.keys(byGame)).toEqual([rivalsId]);
    expect(byGame[rivalsId]).toHaveLength(54);
    expect(byGame[rivalsId][0].name).toBe("Adam Warlock");
    expect(byGame[rivalsId].at(-1)!.name).toBe("Wolverine");
  });

  it("leaves a game with no heroes out rather than keying it empty", async () => {
    // The screen's `?? []` is what turns that into "no heroes" — a key holding
    // an empty array and a missing key have to mean the same thing there.
    expect(await listHeroesByGame(ctx.db)).not.toHaveProperty(jackboxId);
  });

  it("includes retired heroes, because the screen lists them to bring back", async () => {
    const [row] = await ctx.db.select().from(heroes).where(eq(heroes.name, "Venom"));
    unwrap(await retireHero(row.id, ctx.db));
    const byGame = await listHeroesByGame(ctx.db);
    expect(byGame[rivalsId]).toHaveLength(54);
    expect(byGame[rivalsId].filter((hero) => hero.retiredAt !== null).map((h) => h.name)).toEqual([
      "Venom",
    ]);
  });
});
