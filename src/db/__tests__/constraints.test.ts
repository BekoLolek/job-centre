import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, games, profileFields, profileValues, sessions, settings, users } from "@/db";
import { type TestDatabase, expectRejection, freshDatabase, makeUser } from "./helpers";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

/** A game plus one field on it, with unique keys per call. */
async function makeGameWithField(suffix: string) {
  const [game] = await ctx.db
    .insert(games)
    .values({ key: `game-${suffix}`, name: `Game ${suffix}` })
    .returning({ id: games.id });
  const [field] = await ctx.db
    .insert(profileFields)
    .values({ gameId: game.id, key: "rank", label: "Rank", type: "rank" })
    .returning({ id: profileFields.id });
  return { gameId: game.id, fieldId: field.id };
}

describe("unique constraints", () => {
  it("stops two games sharing a key", async () => {
    await ctx.db.insert(games).values({ key: "rivals", name: "Marvel Rivals" });
    await expectRejection(
      () => ctx.db.insert(games).values({ key: "rivals", name: "A different game" }),
      /games_key_unique/
    );
  });

  it("stops two profile fields sharing a key within one game", async () => {
    const { gameId } = await makeGameWithField("dup-field");
    await expectRejection(
      () =>
        ctx.db
          .insert(profileFields)
          .values({ gameId, key: "rank", label: "Rank again", type: "select" }),
      /profile_fields_game_key_uniq/
    );
  });

  it("lets two different games each have a 'rank' field", async () => {
    await makeGameWithField("alpha");
    await expect(makeGameWithField("bravo")).resolves.toBeTruthy();
  });

  it("stops two global fields sharing a key even though game_id is null", async () => {
    // Plain UNIQUE would let this through, because NULL != NULL in Postgres.
    // The constraint is declared NULLS NOT DISTINCT precisely to catch it.
    await ctx.db
      .insert(profileFields)
      .values({ gameId: null, key: "voice", label: "Voice chat", type: "bool" });
    await expectRejection(
      () =>
        ctx.db
          .insert(profileFields)
          .values({ gameId: null, key: "voice", label: "Voice chat again", type: "bool" }),
      /profile_fields_game_key_uniq/
    );
  });

  it("still lets a global field and a game field share a key", async () => {
    const [game] = await ctx.db
      .insert(games)
      .values({ key: "game-scope-split", name: "Scope split" })
      .returning({ id: games.id });
    await ctx.db
      .insert(profileFields)
      .values({ gameId: null, key: "handle", label: "Handle", type: "text" });
    await expect(
      ctx.db
        .insert(profileFields)
        .values({ gameId: game.id, key: "handle", label: "Handle", type: "text" })
    ).resolves.toBeTruthy();
  });

  it("stops one user holding two values for the same field", async () => {
    const { fieldId } = await makeGameWithField("dup-value");
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: "Gold I" });
    await expectRejection(
      () => ctx.db.insert(profileValues).values({ userId, fieldId, value: "Diamond III" }),
      /profile_values_user_field_uniq/
    );
  });

  it("lets two users answer the same field", async () => {
    const { fieldId } = await makeGameWithField("shared-field");
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId: a, fieldId, value: "Gold I" });
    await expect(
      ctx.db.insert(profileValues).values({ userId: b, fieldId, value: "Gold I" })
    ).resolves.toBeTruthy();
  });

  it("lets one user answer two different fields", async () => {
    const first = await makeGameWithField("multi-field-a");
    const second = await makeGameWithField("multi-field-b");
    const userId = await makeUser(ctx.db);
    await ctx.db
      .insert(profileValues)
      .values({ userId, fieldId: first.fieldId, value: "Gold I" });
    await expect(
      ctx.db.insert(profileValues).values({ userId, fieldId: second.fieldId, value: "Gold I" })
    ).resolves.toBeTruthy();
  });

  it("stops two users claiming the same discord id", async () => {
    await makeUser(ctx.db, { discordId: "1234567890" });
    await expectRejection(
      () => makeUser(ctx.db, { discordId: "1234567890" }),
      /users_discord_id_unique/
    );
  });

  it("keeps settings to one row per key", async () => {
    await ctx.db.insert(settings).values({ key: "auth.guild_id", value: "111" });
    await expectRejection(
      () => ctx.db.insert(settings).values({ key: "auth.guild_id", value: "222" }),
      /settings_pkey/
    );
  });

  it("keeps one account row per provider account", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    const row = { type: "oauth" as const, provider: "discord", providerAccountId: "acct-1" };
    await ctx.db.insert(accounts).values({ ...row, userId: a });
    await expectRejection(
      () => ctx.db.insert(accounts).values({ ...row, userId: b }),
      /accounts_provider_provider_account_id_pk/
    );
  });

  it("refuses a profile value pointing at a field that does not exist", async () => {
    const userId = await makeUser(ctx.db);
    await expectRejection(
      () =>
        ctx.db.insert(profileValues).values({
          userId,
          fieldId: "00000000-0000-0000-0000-000000000000",
          value: "orphan",
        }),
      /foreign key|violates/i
    );
  });
});

describe("cascade deletes", () => {
  it("takes a user's profile values with them", async () => {
    const { fieldId } = await makeGameWithField("cascade-user");
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: "Platinum II" });

    await ctx.db.delete(users).where(eq(users.id, userId));

    const left = await ctx.db
      .select()
      .from(profileValues)
      .where(eq(profileValues.userId, userId));
    expect(left).toEqual([]);
    // The field itself is untouched — it belongs to the game, not the member.
    const field = await ctx.db
      .select()
      .from(profileFields)
      .where(eq(profileFields.id, fieldId));
    expect(field).toHaveLength(1);
  });

  it("takes a user's sessions and accounts with them", async () => {
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(sessions).values({
      sessionToken: `token-${userId}`,
      userId,
      expires: new Date("2030-01-01T00:00:00Z"),
    });
    await ctx.db.insert(accounts).values({
      userId,
      type: "oauth",
      provider: "discord",
      providerAccountId: `acct-${userId}`,
    });

    await ctx.db.delete(users).where(eq(users.id, userId));

    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual(
      []
    );
    expect(await ctx.db.select().from(accounts).where(eq(accounts.userId, userId))).toEqual(
      []
    );
  });

  it("takes a game's fields — and their values — with it", async () => {
    const { gameId, fieldId } = await makeGameWithField("cascade-game");
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: "Eternity" });

    await ctx.db.delete(games).where(eq(games.id, gameId));

    expect(
      await ctx.db.select().from(profileFields).where(eq(profileFields.gameId, gameId))
    ).toEqual([]);
    // Two hops: game -> field -> value, both cascading.
    expect(
      await ctx.db.select().from(profileValues).where(eq(profileValues.fieldId, fieldId))
    ).toEqual([]);
    // The member survives; only their answer to a deleted question is gone.
    expect(await ctx.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("does not delete users when a game goes", async () => {
    const { gameId, fieldId } = await makeGameWithField("cascade-isolation");
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values({ userId, fieldId, value: "Silver I" });

    await ctx.db.delete(games).where(eq(games.id, gameId));

    const rows = await ctx.db
      .select()
      .from(profileValues)
      .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, fieldId)));
    expect(rows).toEqual([]);
    expect(await ctx.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("leaves other members' answers alone when one member is deleted", async () => {
    const { fieldId } = await makeGameWithField("cascade-neighbour");
    const doomed = await makeUser(ctx.db);
    const survivor = await makeUser(ctx.db);
    await ctx.db.insert(profileValues).values([
      { userId: doomed, fieldId, value: "Gold I" },
      { userId: survivor, fieldId, value: "Gold II" },
    ]);

    await ctx.db.delete(users).where(eq(users.id, doomed));

    const left = await ctx.db
      .select()
      .from(profileValues)
      .where(eq(profileValues.fieldId, fieldId));
    expect(left).toHaveLength(1);
    expect(left[0].userId).toBe(survivor);
  });
});
