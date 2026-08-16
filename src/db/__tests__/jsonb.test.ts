import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { games, profileFields, profileValues, settings } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "./helpers";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

/** A multiselect "preferred roles" field on a game of its own. */
async function makeRolesField(): Promise<string> {
  counter += 1;
  const [game] = await ctx.db
    .insert(games)
    .values({
      key: `rivals-${counter}`,
      name: "Marvel Rivals",
      rankLadder: ["Bronze III", "Bronze II"],
    })
    .returning({ id: games.id });
  const [field] = await ctx.db
    .insert(profileFields)
    .values({
      gameId: game.id,
      key: "roles",
      label: "Preferred roles",
      type: "multiselect",
      options: [
        { value: "vanguard", label: "Vanguard" },
        { value: "duelist", label: "Duelist" },
        { value: "strategist", label: "Strategist" },
      ],
    })
    .returning({ id: profileFields.id });
  return field.id;
}

describe("jsonb round trips", () => {
  it("returns a multiselect value as a real array, in order", async () => {
    const fieldId = await makeRolesField();
    const userId = await makeUser(ctx.db);
    const picked = ["strategist", "vanguard"];

    await ctx.db.insert(profileValues).values({ userId, fieldId, value: picked });

    const [row] = await ctx.db
      .select()
      .from(profileValues)
      .where(eq(profileValues.userId, userId));

    expect(Array.isArray(row.value)).toBe(true);
    expect(row.value).toEqual(["strategist", "vanguard"]);
    // Not a JSON string that merely looks right.
    expect(typeof row.value).not.toBe("string");
  });

  it("stores it as jsonb Postgres can query into", async () => {
    const fieldId = await makeRolesField();
    const userId = await makeUser(ctx.db);
    await ctx.db
      .insert(profileValues)
      .values({ userId, fieldId, value: ["duelist", "strategist"] });

    // The containment operator only works if the column really is jsonb and
    // really holds an array — a stringified array would match nothing.
    const matches = await ctx.db
      .select({ id: profileValues.id })
      .from(profileValues)
      .where(
        sql`${profileValues.userId} = ${userId} and ${profileValues.value} @> '"duelist"'::jsonb`
      );
    expect(matches).toHaveLength(1);

    const misses = await ctx.db
      .select({ id: profileValues.id })
      .from(profileValues)
      .where(
        sql`${profileValues.userId} = ${userId} and ${profileValues.value} @> '"vanguard"'::jsonb`
      );
    expect(misses).toHaveLength(0);
  });

  it("survives an update from one selection to another", async () => {
    const fieldId = await makeRolesField();
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: ["vanguard"] });
    await ctx.db
      .update(profileValues)
      .set({ value: ["duelist", "strategist"], updatedAt: new Date() })
      .where(eq(profileValues.userId, userId));

    const [row] = await ctx.db
      .select()
      .from(profileValues)
      .where(eq(profileValues.userId, userId));
    expect(row.value).toEqual(["duelist", "strategist"]);
  });

  it("keeps an empty multiselect distinct from no answer at all", async () => {
    const fieldId = await makeRolesField();
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: [] });

    const [row] = await ctx.db
      .select()
      .from(profileValues)
      .where(eq(profileValues.userId, userId));
    expect(row.value).toEqual([]);
    expect(row.value).not.toBeNull();
  });

  it("round-trips the other field types through the same column", async () => {
    const userId = await makeUser(ctx.db);
    const specs = [
      { key: "ign", type: "text" as const, value: "Nova" },
      { key: "rank", type: "rank" as const, value: "Celestial II" },
      { key: "voice", type: "bool" as const, value: true },
      { key: "hours", type: "number" as const, value: 12.5 },
    ];

    for (const spec of specs) {
      const [field] = await ctx.db
        .insert(profileFields)
        .values({ gameId: null, key: spec.key, label: spec.key, type: spec.type })
        .returning({ id: profileFields.id });
      await ctx.db
        .insert(profileValues)
        .values({ userId, fieldId: field.id, value: spec.value });
      const [row] = await ctx.db
        .select()
        .from(profileValues)
        .where(eq(profileValues.fieldId, field.id));
      expect(row.value).toEqual(spec.value);
    }
  });

  it("preserves a game's rank ladder order exactly", async () => {
    const ladder = ["Bronze III", "Bronze II", "Bronze I", "Eternity", "One Above All"];
    await ctx.db
      .insert(games)
      .values({ key: "ladder-probe", name: "Ladder probe", rankLadder: ladder });

    const [row] = await ctx.db
      .select()
      .from(games)
      .where(eq(games.key, "ladder-probe"));
    expect(row.rankLadder).toEqual(ladder);
    expect(row.rankLadder[0]).toBe("Bronze III");
    expect(row.rankLadder.at(-1)).toBe("One Above All");
  });

  it("defaults an unranked game to an empty ladder rather than null", async () => {
    await ctx.db.insert(games).values({ key: "jackbox", name: "Jackbox" });
    const [row] = await ctx.db.select().from(games).where(eq(games.key, "jackbox"));
    expect(row.rankLadder).toEqual([]);
  });

  it("does not double-parse a scalar that looks like JSON", async () => {
    // Regression guard. drizzle's stock jsonb() JSON.parses anything the driver
    // returns as a string, but PGlite and Neon have already parsed it — so a
    // Discord snowflake stored as a JSON string came back as a float and lost
    // its last two digits. The custom `json` column in schema.ts fixes it.
    const snowflake = "123456789012345678";
    await ctx.db.insert(settings).values([
      { key: "scalar.snowflake", value: snowflake },
      { key: "scalar.numeric-string", value: "0042" },
      { key: "scalar.boolean-string", value: "true" },
      { key: "scalar.json-looking-string", value: '["not","an","array"]' },
    ]);

    const rows = await ctx.db.select().from(settings);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    expect(byKey["scalar.snowflake"]).toBe(snowflake);
    expect(typeof byKey["scalar.snowflake"]).toBe("string");
    expect(byKey["scalar.numeric-string"]).toBe("0042");
    expect(byKey["scalar.boolean-string"]).toBe("true");
    expect(byKey["scalar.json-looking-string"]).toBe('["not","an","array"]');
  });

  it("stores settings values with their JSON type intact", async () => {
    await ctx.db.insert(settings).values([
      { key: "auth.guild_gate_enabled", value: true },
      { key: "auth.guild_id", value: "123456789012345678" },
    ]);
    const rows = await ctx.db.select().from(settings);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey["auth.guild_gate_enabled"]).toBe(true);
    expect(byKey["auth.guild_id"]).toBe("123456789012345678");
  });
});
