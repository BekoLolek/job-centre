import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HeroRole, games, heroes } from "@/db";
import { type TestDatabase, expectRejection, freshDatabase } from "./helpers";

/**
 * What Postgres itself guarantees about a hero (R-214 / UC-40 3a, 3b, 3c).
 *
 * Two of these are load-bearing rather than tidy, and both are about the draw
 * rather than about neatness:
 *
 *  - **A hero holds at least one role.** UC-40 3b: a hero in no role can never
 *    be dealt, which is the list lying rather than a hero being unavailable. The
 *    screen will say so in words; this is what makes it true of a row written by
 *    anything at all.
 *  - **A role is one of three named values.** The draw counts the pool per role
 *    (UC-39 2a refuses a role holding fewer than three), so `'strategist'`
 *    stored as text would be counted as a Strategist by nothing — the pool would
 *    be one short and no error would ever be raised.
 *
 * Every case here inserts through raw SQL where the point is a value TypeScript
 * would not let a caller write: a NULL array element, a role that is not a role.
 * A guard only the type system holds is not a guard on the database.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

async function makeGame(): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(games)
    .values({ key: `hero-game-${counter}`, name: `Hero game ${counter}` })
    .returning({ id: games.id });
  return row.id;
}

/**
 * Insert with roles exactly as written, past TypeScript.
 *
 * **No cast on the literal**, deliberately, and it is the difference between
 * this file testing the column and only appearing to. Written
 * `'{Healer}'`, the rejection comes from the *cast* and arrives
 * whatever the column is — a mutation that retyped `roles` as `text[]` passed
 * every assertion here with the casts in place. Unadorned, the literal is
 * coerced to the column's own type, so the refusal is the column's.
 */
function insertRaw(gameId: string, name: string, rolesLiteral: string): Promise<unknown> {
  return ctx.client.query(
    `insert into heroes (game_id, name, roles) values ($1, $2, ${rolesLiteral})`,
    [gameId, name]
  );
}

describe("a hero's roles", () => {
  it("may be one, two or all three — Deadpool is the case this exists for", async () => {
    const gameId = await makeGame();
    await ctx.db.insert(heroes).values([
      { gameId, name: "Hulk", roles: ["Vanguard"] },
      { gameId, name: "Storm", roles: ["Duelist"] },
      { gameId, name: "Deadpool", roles: ["Vanguard", "Duelist", "Strategist"] },
    ]);

    const rows = await ctx.db
      .select({ name: heroes.name, roles: heroes.roles })
      .from(heroes)
      .where(eq(heroes.gameId, gameId));

    expect(Object.fromEntries(rows.map((row) => [row.name, row.roles]))).toEqual({
      Hulk: ["Vanguard"],
      Storm: ["Duelist"],
      Deadpool: ["Vanguard", "Duelist", "Strategist"],
    });
  });

  it("keeps the order they were written in, so a hand reads Vanguard first", async () => {
    const gameId = await makeGame();
    await ctx.db
      .insert(heroes)
      .values({ gameId, name: "Deadpool", roles: ["Vanguard", "Duelist", "Strategist"] });

    const [row] = await ctx.db
      .select({ roles: heroes.roles })
      .from(heroes)
      .where(eq(heroes.gameId, gameId));
    expect(row.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("cannot be empty — UC-40 3b, in the database and not only in the screen", async () => {
    const gameId = await makeGame();
    await expectRejection(
      () => insertRaw(gameId, "Roleless", `'{}'`),
      /heroes_roles_distinct_nonempty/
    );
    expect(await ctx.db.select().from(heroes).where(eq(heroes.gameId, gameId))).toEqual([]);
  });

  it("cannot be NULL at all", async () => {
    const gameId = await makeGame();
    await expectRejection(
      () => insertRaw(gameId, "Nullish", `null`),
      /null value in column "roles"|not-null/
    );
  });

  it("cannot hold a NULL element dressed up as a role", async () => {
    const gameId = await makeGame();
    // One element, so every cardinality branch of the check is satisfied; what
    // refuses it is the `array_position(..., null) is null` half, because
    // `null <> null` is NULL and a CHECK counts NULL as satisfied.
    await expectRejection(
      () => insertRaw(gameId, "Ghost", `'{NULL}'`),
      /heroes_roles_distinct_nonempty/
    );
    await expectRejection(
      () => insertRaw(gameId, "Half ghost", `'{Duelist,NULL}'`),
      /heroes_roles_distinct_nonempty/
    );
    expect(await ctx.db.select().from(heroes).where(eq(heroes.gameId, gameId))).toEqual([]);
  });

  it("cannot hold the same role twice", async () => {
    const gameId = await makeGame();
    await expectRejection(
      () => insertRaw(gameId, "Twice", `'{Duelist,Duelist}'`),
      /heroes_roles_distinct_nonempty/
    );
    await expectRejection(
      () => insertRaw(gameId, "Thrice", `'{Vanguard,Duelist,Vanguard}'`),
      /heroes_roles_distinct_nonempty/
    );
    expect(await ctx.db.select().from(heroes).where(eq(heroes.gameId, gameId))).toEqual([]);
  });

  it("cannot hold more than the three roles there are", async () => {
    const gameId = await makeGame();
    await expectRejection(
      () =>
        insertRaw(gameId, "Four", `'{Vanguard,Duelist,Strategist,Duelist}'`),
      /heroes_roles_distinct_nonempty/
    );
  });

  it("cannot be free text — a role is one of three named values", async () => {
    const gameId = await makeGame();
    await expectRejection(
      () => insertRaw(gameId, "Healer", `'{Healer}'`),
      /invalid input value for enum hero_role: "Healer"/
    );
    // Case matters too: this is the typo that would otherwise leave the
    // Strategist pool one hero short with nothing to show for it.
    await expectRejection(
      () => insertRaw(gameId, "Lowercase", `'{strategist}'`),
      /invalid input value for enum hero_role: "strategist"/
    );
    expect(await ctx.db.select().from(heroes).where(eq(heroes.gameId, gameId))).toEqual([]);
  });
});

describe("a hero's name", () => {
  it("is taken once per game (UC-40 3a)", async () => {
    const gameId = await makeGame();
    await ctx.db.insert(heroes).values({ gameId, name: "Venom", roles: ["Vanguard"] });

    await expectRejection(
      () =>
        ctx.db.insert(heroes).values({ gameId, name: "Venom", roles: ["Duelist"] }),
      /heroes_game_name_uniq/
    );

    const rows = await ctx.db
      .select({ roles: heroes.roles })
      .from(heroes)
      .where(eq(heroes.gameId, gameId));
    // The refusal left the original alone rather than half-applying it.
    expect(rows).toEqual([{ roles: ["Vanguard"] }]);
  });

  it("is free again on a different game — two games may both have a Venom", async () => {
    const first = await makeGame();
    const second = await makeGame();
    await ctx.db.insert(heroes).values({ gameId: first, name: "Venom", roles: ["Vanguard"] });
    await ctx.db.insert(heroes).values({ gameId: second, name: "Venom", roles: ["Duelist"] });

    const names = await ctx.db.select({ gameId: heroes.gameId }).from(heroes);
    expect(names.filter((row) => row.gameId === first)).toHaveLength(1);
    expect(names.filter((row) => row.gameId === second)).toHaveLength(1);
  });
});

describe("a hero row", () => {
  it("starts drawable — `retired_at` is null until an admin retires it", async () => {
    const gameId = await makeGame();
    const [row] = await ctx.db
      .insert(heroes)
      .values({ gameId, name: "Jeff The Land Shark", roles: ["Strategist"] })
      .returning({ retiredAt: heroes.retiredAt, createdAt: heroes.createdAt });
    expect(row.retiredAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("goes when its game goes", async () => {
    const gameId = await makeGame();
    await ctx.db.insert(heroes).values({ gameId, name: "Loki", roles: ["Strategist"] });

    await ctx.db.delete(games).where(eq(games.id, gameId));

    expect(await ctx.db.select().from(heroes).where(eq(heroes.gameId, gameId))).toEqual([]);
  });

  it("cannot belong to no game", async () => {
    await expectRejection(
      () =>
        ctx.client.query(
          `insert into heroes (game_id, name, roles) values (null, 'Orphan', '{Duelist}')`
        ),
      /null value in column "game_id"|not-null/
    );
    await expectRejection(
      () =>
        ctx.client.query(
          `insert into heroes (game_id, name, roles)
           values ('00000000-0000-0000-0000-000000000000', 'Orphan', '{Duelist}')`
        ),
      /heroes_game_id_games_id_fk/
    );
  });
});

/**
 * The type is an enum with exactly three values, read back from Postgres rather
 * than from `schema.ts`.
 *
 * Asserted as the whole list, in order, rather than with three `toContain`s: a
 * fourth value added by a later migration is a change to the shape of the draw
 * — nine cards, three per role — and it should fail here rather than quietly
 * widen what a hero may be.
 */
describe("hero_role", () => {
  it("is what the roles column is actually made of", async () => {
    // The enum existing is not the same claim as the column using it, and the
    // difference is not academic: with the column retyped as `text[]` every
    // rejection test above went on passing until their casts were removed.
    // `_hero_role` is how Postgres spells "array of hero_role".
    const column = await ctx.client.query<{ data_type: string; udt_name: string }>(
      `select data_type, udt_name from information_schema.columns
        where table_name = 'heroes' and column_name = 'roles'`
    );
    expect(column.rows).toEqual([{ data_type: "ARRAY", udt_name: "_hero_role" }]);
  });

  it("is Vanguard, Duelist, Strategist and nothing else", async () => {
    const result = await ctx.client.query<{ label: string; sort: number }>(
      `select enumlabel as label, enumsortorder as sort
         from pg_enum
         join pg_type on pg_type.oid = pg_enum.enumtypid
        where pg_type.typname = 'hero_role'
        order by enumsortorder`
    );
    const expected: HeroRole[] = ["Vanguard", "Duelist", "Strategist"];
    expect(result.rows.map((row) => row.label)).toEqual(expected);
  });
});
