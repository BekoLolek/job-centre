import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, sessions, users } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import {
  DEV_LOGIN_DISCORD_ID,
  DEV_LOGIN_PATH,
  DevLoginDisabledError,
  devLoginConfig,
  devLoginEnabled,
  devSessionCookieName,
  endDevSession,
  establishDevSession,
  safeRedirectPath,
} from "@/lib/dev-login";

/**
 * The escape hatch's safety argument is "NODE_ENV=development **and**
 * DEV_LOGIN=1, never either", so most of this file is that claim, poked from
 * every side. The rest checks that what it mints is a real Auth.js database
 * session rather than something that only looks like one — if it were not, the
 * pages built on top of it would have been verified against a fiction.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The one combination that switches it on. */
function enable(over: Record<string, string> = {}) {
  return { NODE_ENV: "development", DEV_LOGIN: "1", ...over };
}

describe("devLoginEnabled", () => {
  it("is on only with both the development environment and the switch", () => {
    expect(devLoginEnabled(enable())).toBe(true);
  });

  it("REFUSES when NODE_ENV is not development, whatever DEV_LOGIN says", () => {
    // The load-bearing test: this is why a deployment cannot reach the route.
    // `next build` and `next start` — and therefore Vercel — always set
    // production, so no value of DEV_LOGIN can open the hatch there.
    for (const environment of ["production", "test", "staging", "", undefined]) {
      expect(devLoginEnabled({ NODE_ENV: environment, DEV_LOGIN: "1" })).toBe(false);
      expect(devLoginEnabled({ NODE_ENV: environment, DEV_LOGIN: "true" })).toBe(false);
      expect(devLoginEnabled({ NODE_ENV: environment, DEV_LOGIN: "yes" })).toBe(false);
    }
  });

  it("refuses in development when the switch is off or absent", () => {
    expect(devLoginEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devLoginEnabled({ NODE_ENV: "development", DEV_LOGIN: "0" })).toBe(false);
    expect(devLoginEnabled({ NODE_ENV: "development", DEV_LOGIN: "" })).toBe(false);
    expect(devLoginEnabled({ NODE_ENV: "development", DEV_LOGIN: "no" })).toBe(false);
  });

  it("is not fooled by a NODE_ENV that merely starts with development", () => {
    expect(devLoginEnabled({ NODE_ENV: "development-ish", DEV_LOGIN: "1" })).toBe(false);
    expect(devLoginEnabled({ NODE_ENV: "Development", DEV_LOGIN: "1" })).toBe(false);
  });

  it("reads the live environment when it is not handed one", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_LOGIN", "1");
    expect(devLoginEnabled()).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(devLoginEnabled()).toBe(false);
  });
});

describe("devLoginConfig", () => {
  it("defaults to an id that obviously is not a Discord snowflake", () => {
    const config = devLoginConfig(enable());
    expect(config.discordId).toBe(DEV_LOGIN_DISCORD_ID);
    expect(/^\d+$/.test(config.discordId)).toBe(false);
    expect(config.displayName).toMatch(/not a real member/i);
    expect(config.isAdmin).toBe(false);
  });

  it("takes the id and the admin flag from the environment", () => {
    const config = devLoginConfig(
      enable({ DEV_LOGIN_DISCORD_ID: "dev-alice", DEV_LOGIN_ADMIN: "1" })
    );
    expect(config.discordId).toBe("dev-alice");
    expect(config.isAdmin).toBe(true);
  });
});

describe("establishDevSession", () => {
  it("REFUSES to touch the database when NODE_ENV is not development", async () => {
    const before = await db.select().from(sessions);

    await expect(
      establishDevSession(db, { NODE_ENV: "production", DEV_LOGIN: "1" })
    ).rejects.toBeInstanceOf(DevLoginDisabledError);

    // Not merely "returned nothing" — nothing was written either.
    expect(await db.select().from(sessions)).toHaveLength(before.length);
  });

  it("refuses when the switch is off", async () => {
    await expect(
      establishDevSession(db, { NODE_ENV: "development", DEV_LOGIN: "0" })
    ).rejects.toBeInstanceOf(DevLoginDisabledError);
  });

  it("creates a user and a real session row", async () => {
    const env = enable({ DEV_LOGIN_DISCORD_ID: "dev-basic" });
    const { sessionToken, expires, user } = await establishDevSession(db, env);

    expect(user.discordId).toBe("dev-basic");
    expect(user.isAdmin).toBe(false);
    expect(user.lastSeenAt).toBeInstanceOf(Date);
    expect(expires.getTime()).toBeGreaterThan(Date.now());

    // The session is exactly what the Auth.js adapter looks up: a row keyed by
    // the token that is in the cookie, pointing at the user.
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionToken, sessionToken));
    expect(row.userId).toBe(user.id);
    expect(row.expires.getTime()).toBe(expires.getTime());
    expect(sessionToken.length).toBeGreaterThanOrEqual(32);
  });

  it("reuses the same user, so yesterday's profile is still there", async () => {
    const env = enable({ DEV_LOGIN_DISCORD_ID: "dev-returning" });
    const first = await establishDevSession(db, env);
    const second = await establishDevSession(db, env);

    expect(second.user.id).toBe(first.user.id);
    expect(second.sessionToken).not.toBe(first.sessionToken);

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.discordId, "dev-returning"));
    expect(rows).toHaveLength(1);
  });

  it("syncs the admin flag both ways, so the toggle is testable", async () => {
    const asAdmin = enable({ DEV_LOGIN_DISCORD_ID: "dev-flag", DEV_LOGIN_ADMIN: "1" });
    const asMember = enable({ DEV_LOGIN_DISCORD_ID: "dev-flag", DEV_LOGIN_ADMIN: "0" });

    expect((await establishDevSession(db, asAdmin)).user.isAdmin).toBe(true);
    // Unlike the production allowlist, which only ever grants, this has to be
    // able to take the flag away — otherwise requireAdmin() cannot be tested.
    expect((await establishDevSession(db, asMember)).user.isAdmin).toBe(false);
  });

  it("issues a different token every time", async () => {
    const env = enable({ DEV_LOGIN_DISCORD_ID: "dev-tokens" });
    const tokens = new Set<string>();
    for (let n = 0; n < 5; n += 1) {
      tokens.add((await establishDevSession(db, env)).sessionToken);
    }
    expect(tokens.size).toBe(5);
  });
});

describe("endDevSession", () => {
  it("deletes the row, so the cookie is dead even if it is kept", async () => {
    const env = enable({ DEV_LOGIN_DISCORD_ID: "dev-signout" });
    const { sessionToken } = await establishDevSession(db, env);

    await endDevSession(sessionToken, db, env);

    expect(
      await db.select().from(sessions).where(eq(sessions.sessionToken, sessionToken))
    ).toHaveLength(0);
  });

  it("shrugs at an unknown or missing token", async () => {
    const env = enable();
    await expect(endDevSession("not-a-token", db, env)).resolves.toBeUndefined();
    await expect(endDevSession(undefined, db, env)).resolves.toBeUndefined();
  });

  it("refuses when the hatch is off", async () => {
    await expect(
      endDevSession("whatever", db, { NODE_ENV: "production", DEV_LOGIN: "1" })
    ).rejects.toBeInstanceOf(DevLoginDisabledError);
  });
});

describe("the cookie", () => {
  it("is the name @auth/core reads the session token out of", () => {
    expect(devSessionCookieName(false)).toBe("authjs.session-token");
    expect(devSessionCookieName(true)).toBe("__Secure-authjs.session-token");
  });
});

describe("where it lives", () => {
  it("is a page, not an API route", () => {
    // Not cosmetic: `next dev` renders pages in a different process from route
    // handlers, and PGlite lives inside whichever process opened it — so a
    // session written by a route handler is invisible to the pages it exists to
    // unlock. Server actions run in the render process, which is why the
    // escape hatch is a page with a form.
    expect(DEV_LOGIN_PATH).toBe("/dev-login");
    expect(DEV_LOGIN_PATH.startsWith("/api/")).toBe(false);
  });
});

describe("safeRedirectPath", () => {
  it("keeps a same-origin path", () => {
    expect(safeRedirectPath("/admin/games")).toBe("/admin/games");
  });

  it("refuses anything that could leave the site", () => {
    expect(safeRedirectPath("https://elsewhere.test")).toBe("/me/profile");
    expect(safeRedirectPath("//elsewhere.test")).toBe("/me/profile");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/me/profile");
    expect(safeRedirectPath(null)).toBe("/me/profile");
    expect(safeRedirectPath("")).toBe("/me/profile");
  });
});
