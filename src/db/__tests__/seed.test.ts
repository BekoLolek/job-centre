import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTING_KEYS, games, heroes, profileFields, settings, users } from "@/db";
import { RIVALS_RANK_LADDER, parseAdminDiscordIds, seed } from "@/db/seed";
import { drawableByRole } from "@/lib/heroes";
import { type TestDatabase, freshDatabase, makeUser } from "./helpers";

let ctx: TestDatabase;

// A fresh database per test: idempotency is only meaningful from a known start.
beforeEach(async () => {
  ctx = await freshDatabase();
});

afterEach(async () => {
  await ctx.close();
});

/** Counts of everything the seed writes. */
async function census() {
  return {
    games: (await ctx.db.select().from(games)).length,
    fields: (await ctx.db.select().from(profileFields)).length,
    heroes: (await ctx.db.select().from(heroes)).length,
    settings: (await ctx.db.select().from(settings)).length,
  };
}

describe("parseAdminDiscordIds", () => {
  it("splits, trims and drops the empties", () => {
    expect(parseAdminDiscordIds(" 111, 222 ,,333 ")).toEqual(["111", "222", "333"]);
  });

  it("is empty for an unset or blank value", () => {
    expect(parseAdminDiscordIds(undefined)).toEqual([]);
    expect(parseAdminDiscordIds("")).toEqual([]);
    expect(parseAdminDiscordIds(" , , ")).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(parseAdminDiscordIds("111,111,222")).toEqual(["111", "222"]);
  });
});

describe("seed", () => {
  it("creates the rivals game with its full ranked ladder", async () => {
    await seed(ctx.db, {});
    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    expect(rivals.name).toBe("Marvel Rivals");
    expect(rivals.rankLadder).toEqual([...RIVALS_RANK_LADDER]);
    expect(rivals.rankLadder[0]).toBe("Bronze III");
    expect(rivals.rankLadder.at(-1)).toBe("One Above All");
    expect(rivals.isActive).toBe(true);
  });

  it("creates jackbox with no ladder at all", async () => {
    await seed(ctx.db, {});
    const [jackbox] = await ctx.db.select().from(games).where(eq(games.key, "jackbox"));
    expect(jackbox.rankLadder).toEqual([]);
    expect(jackbox.isActive).toBe(true);
  });

  it("makes the rivals fields click-first, with text only for the in-game name", async () => {
    await seed(ctx.db, {});
    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    const fields = await ctx.db
      .select()
      .from(profileFields)
      .where(eq(profileFields.gameId, rivals.id));

    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.ign.type).toBe("text");
    expect(byKey.rank.type).toBe("rank");
    expect(byKey.roles.type).toBe("multiselect");
    expect(byKey.roles.options.map((o) => o.label)).toEqual([
      "Vanguard",
      "Duelist",
      "Strategist",
    ]);
    // Only one free-text escape hatch on the whole game.
    expect(fields.filter((f) => f.type === "text")).toHaveLength(1);
  });

  it("hangs a global field off no game at all", async () => {
    await seed(ctx.db, {});
    const globals = await ctx.db
      .select()
      .from(profileFields)
      .where(isNull(profileFields.gameId));
    expect(globals.map((f) => f.key)).toEqual(["voice"]);
    expect(globals[0].type).toBe("bool");
  });

  it("turns the guild gate on and records the guild from the environment", async () => {
    await seed(ctx.db, { DISCORD_GUILD_ID: "987654321098765432" });
    const rows = await ctx.db.select().from(settings);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey[SETTING_KEYS.guildGateEnabled]).toBe(true);
    expect(byKey[SETTING_KEYS.guildId]).toBe("987654321098765432");
  });

  it("changes nothing on a second run", async () => {
    const first = await seed(ctx.db, { DISCORD_GUILD_ID: "111" });
    const afterFirst = await census();
    expect(first.gamesInserted).toBe(2);
    expect(first.fieldsInserted).toBe(5);
    expect(first.heroesInserted).toBe(54);
    expect(first.settingsInserted).toBe(2);

    const second = await seed(ctx.db, { DISCORD_GUILD_ID: "111" });
    expect(second).toMatchObject({
      gamesInserted: 0,
      fieldsInserted: 0,
      heroesInserted: 0,
      settingsInserted: 0,
    });
    expect(await census()).toEqual(afterFirst);
  });

  it("survives a third run too", async () => {
    await seed(ctx.db, {});
    await seed(ctx.db, {});
    const afterTwo = await census();
    await seed(ctx.db, {});
    expect(await census()).toEqual(afterTwo);
  });

  it("leaves an admin-edited row alone", async () => {
    await seed(ctx.db, { DISCORD_GUILD_ID: "111" });
    await ctx.db
      .update(settings)
      .set({ value: "222" })
      .where(eq(settings.key, SETTING_KEYS.guildId));
    await ctx.db.update(games).set({ name: "Rivals" }).where(eq(games.key, "rivals"));

    await seed(ctx.db, { DISCORD_GUILD_ID: "111" });

    const [guild] = await ctx.db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTING_KEYS.guildId));
    expect(guild.value).toBe("222");
    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    expect(rivals.name).toBe("Rivals");
  });

  it("plants the 54 heroes on rivals, giving 15 / 28 / 13 drawable", async () => {
    const summary = await seed(ctx.db, {});
    expect(summary.heroesInserted).toBe(54);

    const [rivals] = await ctx.db.select().from(games).where(eq(games.key, "rivals"));
    const rows = await ctx.db.select().from(heroes);
    expect(rows).toHaveLength(54);
    expect(rows.every((row) => row.gameId === rivals.id)).toBe(true);
    expect(rows.every((row) => row.retiredAt === null)).toBe(true);

    const pools = drawableByRole(rows);
    expect({
      Vanguard: pools.Vanguard.length,
      Duelist: pools.Duelist.length,
      Strategist: pools.Strategist.length,
    }).toEqual({ Vanguard: 15, Duelist: 28, Strategist: 13 });
  });

  /**
   * The criterion that would otherwise pass vacuously.
   *
   * "Seed twice and still find 54 rows" is also true of a seed that wrote
   * nothing at all on the first run, and of one that overwrote everything on the
   * second with the same values. So the row is **edited in between**, to
   * something the roster does not say, and the assertion is that the edit is
   * still there: an admin who corrects a role after a rework must not have the
   * next redeploy undo it (the rule in `seed.ts`'s own module comment).
   */
  it("leaves an admin-edited hero exactly as the admin left it", async () => {
    const first = await seed(ctx.db, {});
    expect(first.heroesInserted).toBe(54);

    const retiredAt = new Date("2026-10-23T12:00:00Z");
    await ctx.db
      .update(heroes)
      .set({ roles: ["Duelist"] })
      .where(eq(heroes.name, "Deadpool"));
    await ctx.db.update(heroes).set({ retiredAt }).where(eq(heroes.name, "The Hood"));

    const second = await seed(ctx.db, {});
    expect(second.heroesInserted).toBe(0);

    const [deadpool] = await ctx.db.select().from(heroes).where(eq(heroes.name, "Deadpool"));
    expect(deadpool.roles).toEqual(["Duelist"]);
    const [hood] = await ctx.db.select().from(heroes).where(eq(heroes.name, "The Hood"));
    expect(hood.retiredAt).toEqual(retiredAt);

    // And no second Deadpool beside the edited one.
    expect(await ctx.db.select().from(heroes)).toHaveLength(54);
  });

  /**
   * The one thing a re-seed does change, asserted rather than left to the
   * comment in `insertHero` that claims it.
   *
   * A hero is matched by (game, name), so a hero an admin has **renamed** no
   * longer matches and the original name is planted again beside it. That is a
   * visible duplicate an admin can retire, where overwriting would lose the
   * correction outright — and no deploy triggers it, because `npm run build`
   * runs `db:migrate` and not the seed.
   */
  it("plants the original name again beside a hero that was renamed", async () => {
    await seed(ctx.db, {});
    await ctx.db
      .update(heroes)
      .set({ name: "Gorr the God Butcher" })
      .where(eq(heroes.name, "Gorr"));

    const second = await seed(ctx.db, {});

    expect(second.heroesInserted).toBe(1);
    expect(await ctx.db.select().from(heroes)).toHaveLength(55);
    const names = (await ctx.db.select({ name: heroes.name }).from(heroes)).map(
      (row) => row.name
    );
    expect(names.filter((name) => name.startsWith("Gorr")).sort()).toEqual([
      "Gorr",
      "Gorr the God Butcher",
    ]);
  });

  it("marks allowlisted members admin when they already exist", async () => {
    await makeUser(ctx.db, { discordId: "111" });
    await makeUser(ctx.db, { discordId: "999" });

    const summary = await seed(ctx.db, { ADMIN_DISCORD_IDS: "111,222" });

    expect(summary.adminsPromoted).toBe(1);
    expect(summary.adminsPending).toEqual(["222"]);

    const [promoted] = await ctx.db.select().from(users).where(eq(users.discordId, "111"));
    expect(promoted.isAdmin).toBe(true);
    const [untouched] = await ctx.db.select().from(users).where(eq(users.discordId, "999"));
    expect(untouched.isAdmin).toBe(false);
  });

  it("does not invent rows for allowlisted ids that have never signed in", async () => {
    const summary = await seed(ctx.db, { ADMIN_DISCORD_IDS: "111,222" });
    expect(summary.adminsPromoted).toBe(0);
    expect(summary.adminsPending).toEqual(["111", "222"]);
    expect(await ctx.db.select().from(users)).toEqual([]);
  });

  it("promotes on a later run, once the member has signed in", async () => {
    await seed(ctx.db, { ADMIN_DISCORD_IDS: "111" });
    await makeUser(ctx.db, { discordId: "111" });
    const second = await seed(ctx.db, { ADMIN_DISCORD_IDS: "111" });
    expect(second.adminsPromoted).toBe(1);
    expect(second.adminsPending).toEqual([]);
  });

  it("does nothing about admins when the allowlist is unset", async () => {
    await makeUser(ctx.db, { discordId: "111" });
    const summary = await seed(ctx.db, {});
    expect(summary.adminsPromoted).toBe(0);
    expect(summary.adminsPending).toEqual([]);
    const [user] = await ctx.db.select().from(users).where(eq(users.discordId, "111"));
    expect(user.isAdmin).toBe(false);
  });
});
