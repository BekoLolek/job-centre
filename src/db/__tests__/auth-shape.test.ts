import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, sessions, users, verificationTokens } from "@/db";
import { type TestDatabase, freshDatabase } from "./helpers";

/**
 * Phase 1 stops short of wiring Auth.js up — that is the next agent's job. What
 * this file does is prove the four tables are the shape the adapter expects, so
 * that work starts from a known-good schema rather than discovering a column
 * mismatch at the first sign-in.
 *
 * Constructing the adapter is a compile-time check as much as a runtime one:
 * `DrizzleAdapter`'s schema parameter is typed against the exact column types
 * it needs, so `npx tsc --noEmit` fails here if a column drifts.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

function adapterFor(db: TestDatabase["db"]) {
  return DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });
}

describe("Auth.js adapter compatibility", () => {
  it("accepts our tables and exposes the database-session methods", () => {
    const adapter = adapterFor(ctx.db);
    for (const method of [
      "createUser",
      "getUser",
      "getUserByEmail",
      "getUserByAccount",
      "updateUser",
      "linkAccount",
      "createSession",
      "getSessionAndUser",
      "updateSession",
      "deleteSession",
      "createVerificationToken",
      "useVerificationToken",
    ] as const) {
      expect(typeof adapter[method]).toBe("function");
    }
  });

  it("creates a user, links a Discord account and resolves a session", async () => {
    const adapter = adapterFor(ctx.db);

    const user = await adapter.createUser!({
      id: "ignored-we-default-the-uuid",
      email: "member@example.test",
      emailVerified: null,
      name: "Member",
    });
    // The id came from the database default, not the one Auth.js suggested.
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    await adapter.linkAccount!({
      userId: user.id,
      type: "oauth",
      provider: "discord",
      providerAccountId: "9876543210",
      access_token: "token",
      scope: "identify guilds",
    });

    const byAccount = await adapter.getUserByAccount!({
      provider: "discord",
      providerAccountId: "9876543210",
    });
    expect(byAccount?.id).toBe(user.id);

    const expires = new Date("2030-01-01T00:00:00.000Z");
    await adapter.createSession!({ sessionToken: "sess-1", userId: user.id, expires });

    const resolved = await adapter.getSessionAndUser!("sess-1");
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.session.expires.toISOString()).toBe(expires.toISOString());

    await adapter.deleteSession!("sess-1");
    expect(await adapter.getSessionAndUser!("sess-1")).toBeNull();
  });

  it("leaves the Job Centre columns at their defaults for an adapter-made user", async () => {
    const adapter = adapterFor(ctx.db);
    const user = await adapter.createUser!({
      id: "ignored",
      email: "defaults@example.test",
      emailVerified: null,
    });

    const [row] = await ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(row.isAdmin).toBe(false);
    expect(row.createdAt).toBeInstanceOf(Date);
    // Discord identity is filled in by the sign-in callback, not the adapter.
    expect(row.discordId).toBeNull();
    expect(row.lastSeenAt).toBeNull();
  });
});
