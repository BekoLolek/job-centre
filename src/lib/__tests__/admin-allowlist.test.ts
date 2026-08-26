import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  allowAdmin,
  barAdmin,
  forgetAdmin,
  getAllowlist,
  getAllowlistEntries,
} from "@/lib/admin-allowlist";
import { normaliseDiscordId, resolveAdminFlag } from "@/lib/auth-policy";

/**
 * The admin allowlist.
 *
 * The behaviour worth pinning down is the precedence, because getting it wrong
 * is not a visual bug — it either locks an admin out or lets a removed one back
 * in, and the second one is silent.
 */

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

const ID = "123456789012345678";
const OTHER = "987654321098765432";

/* ------------------------------------------------------------------ */
/* The decision                                                       */
/* ------------------------------------------------------------------ */

describe("resolveAdminFlag", () => {
  it("promotes an id the allowlist allows", () => {
    expect(resolveAdminFlag(ID, [{ discordId: ID, allowed: true }], undefined)).toBe(true);
  });

  it("refuses an id the allowlist bars, whatever the environment says", () => {
    // The whole point. An id left in ADMIN_DISCORD_IDS used to re-promote
    // itself on every sign-in, undoing a removal with nothing said.
    expect(resolveAdminFlag(ID, [{ discordId: ID, allowed: false }], ID)).toBe(false);
  });

  it("has no opinion about an id nobody has listed", () => {
    // Distinct from `false`: a promotion made on the members screen must
    // survive a sign-in, and only `undefined` leaves it alone.
    expect(resolveAdminFlag(ID, [{ discordId: OTHER, allowed: true }], undefined)).toBeUndefined();
  });

  it("falls back to the environment when the table has nothing to say", () => {
    expect(resolveAdminFlag(ID, [], `${ID},${OTHER}`)).toBe(true);
    expect(resolveAdminFlag(ID, null, ID)).toBe(true);
    expect(resolveAdminFlag(ID, null, OTHER)).toBeUndefined();
  });

  it("never promotes an account with no Discord id", () => {
    expect(resolveAdminFlag(null, [{ discordId: ID, allowed: true }], ID)).toBeUndefined();
    expect(resolveAdminFlag("", null, ID)).toBeUndefined();
  });
});

describe("normaliseDiscordId", () => {
  it("accepts a snowflake and strips the punctuation off a mention", () => {
    expect(normaliseDiscordId(ID)).toBe(ID);
    expect(normaliseDiscordId(`<@${ID}>`)).toBe(ID);
    expect(normaliseDiscordId(`  ${ID} `)).toBe(ID);
  });

  it("refuses anything that could never match anybody", () => {
    // A stored username makes a row that looks fine and matches nothing.
    expect(normaliseDiscordId("someone")).toBeNull();
    expect(normaliseDiscordId("12345")).toBeNull();
    expect(normaliseDiscordId("")).toBeNull();
    expect(normaliseDiscordId(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

describe("the allowlist", () => {
  it("pre-authorises somebody who has never signed in", async () => {
    const result = await allowAdmin(ID, {}, db);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.promotedNow).toBe(false);

    const entries = await getAllowlistEntries(db);
    expect(entries).toContainEqual({ discordId: ID, allowed: true });

    // And that is enough for the sign-in decision, with no account yet.
    expect(resolveAdminFlag(ID, entries, undefined)).toBe(true);
  });

  it("promotes an account that already exists, rather than waiting", async () => {
    const userId = await makeUser(db, { discordId: OTHER });
    const result = await allowAdmin(OTHER, {}, db);
    expect(result.ok && result.data.promotedNow).toBe(true);

    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
    expect(row.isAdmin).toBe(true);
  });

  it("bars an id and demotes the account in the same breath", async () => {
    const discordId = "111111111111111111";
    const userId = await makeUser(db, { discordId });
    await allowAdmin(discordId, {}, db);

    const result = await barAdmin(discordId, { note: "Left the server" }, db);
    expect(result.ok && result.data.demotedNow).toBe(true);

    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
    expect(row.isAdmin).toBe(false);
  });

  it("keeps a barred id barred against the environment", async () => {
    const discordId = "222222222222222222";
    await barAdmin(discordId, {}, db);
    const entries = await getAllowlistEntries(db);
    // Named in ADMIN_DISCORD_IDS and still refused.
    expect(resolveAdminFlag(discordId, entries, discordId)).toBe(false);
  });

  it("forgetting is not barring — it hands the decision back", async () => {
    const discordId = "333333333333333333";
    await barAdmin(discordId, {}, db);
    expect(resolveAdminFlag(discordId, await getAllowlistEntries(db), discordId)).toBe(false);

    await forgetAdmin(discordId, db);
    expect(resolveAdminFlag(discordId, await getAllowlistEntries(db), discordId)).toBe(true);
  });

  it("refuses an id that is not one, rather than storing a row that matches nobody", async () => {
    const result = await allowAdmin("not-an-id", {}, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/17 to 20 digits/);
  });

  it("shows who a row turned out to be, and who has not turned up yet", async () => {
    const known = "444444444444444444";
    await makeUser(db, { discordId: known, displayName: "Ada" });
    await allowAdmin(known, {}, db);
    await allowAdmin("555555555555555555", { note: "Joining next week" }, db);

    const rows = await getAllowlist(db);
    const withAccount = rows.find((row) => row.discordId === known);
    const without = rows.find((row) => row.discordId === "555555555555555555");

    expect(withAccount?.account?.name).toBe("Ada");
    expect(withAccount?.account?.isAdmin).toBe(true);
    expect(without?.account).toBeNull();
    expect(without?.note).toBe("Joining next week");
  });

  it("re-allowing somebody who was barred works, and clears the bar", async () => {
    const discordId = "666666666666666666";
    await barAdmin(discordId, {}, db);
    await allowAdmin(discordId, {}, db);
    expect(resolveAdminFlag(discordId, await getAllowlistEntries(db), undefined)).toBe(true);
  });
});
