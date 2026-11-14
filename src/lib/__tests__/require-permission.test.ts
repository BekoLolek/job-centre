import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, sessions, userPermissions, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { POWERS, type Power } from "@/lib/permissions-policy";

/*
 * `requirePermission`, the sixth guard (R-261, R-264 / UC-56).
 *
 * The guard runs for real against an in-memory Postgres: the member, their
 * grants and **their session** are rows. `auth()` is replaced only as far as it
 * must be - there is no cookie jar outside a Next request - and what replaces
 * it does what the Auth.js adapter does: it looks the cookie's token up in
 * `sessions` and answers with the user id on that row, and nothing else. So a
 * session here is something a test opens once and then holds, and "revoked
 * mid-session" is a revoke made while that row is still there.
 *
 * That is what the database-backed `auth` buys over the constant
 * `session-guards.test.ts` gets away with: a test can count the session's rows
 * after a refusal, which is what fails if the guard ever answers a missing
 * power by ending the session instead of leaving it alone.
 *
 * `redirect` is replaced rather than caught, as in `session-guards.test.ts`.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  /** The session token the browser is carrying, if it carries one. */
  cookie: null as string | null,
  headers: {} as Record<string, string>,
}));

const redirect = vi.hoisted(() =>
  vi.fn((path: string): never => {
    throw new Error(`REDIRECT ${path}`);
  })
);

vi.mock("next/navigation", () => ({ redirect }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.headers),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => {
    if (!state.cookie) return null;
    const [row] = await state.db
      .select({ userId: sessions.userId, expires: sessions.expires })
      .from(sessions)
      .where(eq(sessions.sessionToken, state.cookie));
    return row && row.expires > new Date() ? { user: { id: row.userId } } : null;
  },
}));

const { requireAdmin, requireAnyPermission, requirePermission } = await import(
  "@/lib/session-guards"
);
const { grantPower } = await import("@/lib/permissions");

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.cookie = null;
  state.headers = {};
  redirect.mockClear();
});

/** Open a session for this member and put its token in the browser. */
async function signIn(userId: string): Promise<string> {
  const sessionToken = `token-${Math.random().toString(36).slice(2)}`;
  await db
    .insert(sessions)
    .values({ sessionToken, userId, expires: new Date("2100-01-01T00:00:00Z") });
  state.cookie = sessionToken;
  return sessionToken;
}

async function makeAdmin(): Promise<string> {
  const id = await makeUser(db);
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  return id;
}

async function give(userId: string, ...powers: Power[]): Promise<void> {
  const granter = await makeUser(db);
  await Promise.all(
    powers.map((power) => grantPower({ userId, power, grantedByUserId: granter }, db))
  );
}

async function revoke(userId: string): Promise<void> {
  await db.delete(userPermissions).where(eq(userPermissions.userId, userId));
}

/** Where the guard sent them. Fails if it let them through. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  redirect.mockClear();
  await expect(run()).rejects.toThrow(/^REDIRECT /);
  expect(redirect).toHaveBeenCalledOnce();
  return redirect.mock.calls[0][0];
}

const sessionRows = (sessionToken: string) =>
  db.select().from(sessions).where(eq(sessions.sessionToken, sessionToken));

/* ------------------------------------------------------------------ */
/* Who gets through                                                   */
/* ------------------------------------------------------------------ */

describe("requirePermission", () => {
  it("lets a member through who holds the power", async () => {
    const member = await makeUser(db);
    await give(member, "games.manage");
    await signIn(member);

    await expect(requirePermission("games.manage")).resolves.toMatchObject({ id: member });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("turns away a member who holds a different power", async () => {
    const member = await makeUser(db);
    await give(member, "polls.manage", "audit.read");
    await signIn(member);

    expect(await refusalOf(() => requirePermission("games.manage"))).toBe(
      "/signin?error=admin-only"
    );
  });

  it("turns away a member when the power is somebody else's", async () => {
    const holder = await makeUser(db);
    const member = await makeUser(db);
    await give(holder, "games.manage");
    await signIn(member);

    expect(await refusalOf(() => requirePermission("games.manage"))).toBe(
      "/signin?error=admin-only"
    );
  });

  /*
   * The short-circuit is `canManageEvent`'s: the flag answers before the grant
   * is looked for. So an admin does not depend on `user_permissions` being
   * readable - which is the state of a deployment whose migration has not run.
   * The `finally` is not catching anything: it puts the table back for the
   * tests after this one, whether the guard answered or threw.
   *
   * Two things it leans on: if the rename back itself throws, that error masks
   * the real one and every later test here dies on "relation does not exist";
   * and nothing in this file may ever be `it.concurrent`, or another test
   * would run while the table is away.
   */
  it("lets an admin through without reading the grants", async () => {
    const admin = await makeAdmin();
    await signIn(admin);
    await db.execute(sql`alter table user_permissions rename to user_permissions_away`);

    let passed: { id: string } | undefined;
    try {
      passed = await requirePermission("games.manage");
    } finally {
      await db.execute(sql`alter table user_permissions_away rename to user_permissions`);
    }

    expect(passed?.id).toBe(admin);
  });

  it("refuses a question about a power that does not exist, for an admin as well", async () => {
    const admin = await makeAdmin();
    await signIn(admin);

    await expect(requirePermission("permissions.grant" as Power)).rejects.toThrow(
      /"permissions\.grant" is not a power/
    );
  });

  /*
   * The audit line names a person. So what comes back is the caller's own
   * `users` row - the one `requireAdmin` hands an action - and not the power
   * that was asked about, or a yes.
   */
  it("returns the actor's own row", async () => {
    const member = await makeUser(db, { displayName: "Named Member" });
    await give(member, "audit.read");
    await signIn(member);
    const [row] = await db.select().from(users).where(eq(users.id, member));

    expect(await requirePermission("audit.read")).toEqual(row);
  });
});

/* ------------------------------------------------------------------ */
/* Authority is read on every request (UC-56 3b)                      */
/* ------------------------------------------------------------------ */

describe("authority is re-read on every request", () => {
  it("refuses a power revoked mid-session, on the very next request of the same session", async () => {
    const member = await makeUser(db);
    await give(member, "games.manage");
    const sessionToken = await signIn(member);
    const before = await requirePermission("games.manage");

    await revoke(member);
    const to = await refusalOf(() => requirePermission("games.manage"));

    expect(before.id).toBe(member);
    expect(to).toBe("/signin?error=admin-only");
    // They were not signed out: the session that passed is still there after the refusal.
    expect(await sessionRows(sessionToken)).toHaveLength(1);
  });

  it("admits a power granted mid-session, on the very next request of the same session", async () => {
    const member = await makeUser(db);
    await signIn(member);
    const to = await refusalOf(() => requirePermission("games.manage"));

    await give(member, "games.manage");
    const after = await requirePermission("games.manage");

    expect(to).toBe("/signin?error=admin-only");
    expect(after.id).toBe(member);
  });

  it("refuses an admin who lost the flag mid-session and holds nothing", async () => {
    const admin = await makeAdmin();
    const sessionToken = await signIn(admin);
    const before = await requirePermission("games.manage");

    await db.update(users).set({ isAdmin: false }).where(eq(users.id, admin));
    const to = await refusalOf(() => requirePermission("games.manage"));

    expect(before.id).toBe(admin);
    expect(to).toBe("/signin?error=admin-only");
    expect(await sessionRows(sessionToken)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The refusal is requireAdmin's                                      */
/* ------------------------------------------------------------------ */

describe("the refusal is the one a non-admin already gets", () => {
  it("sends a signed-out visitor where requireAdmin sends them: to sign in, remembering the page", async () => {
    state.headers = { "next-url": "/admin/games" };

    const asAdminOnly = await refusalOf(requireAdmin);
    const asPermission = await refusalOf(() => requirePermission("games.manage"));

    expect(asPermission).toBe(asAdminOnly);
    expect(asPermission).toBe("/signin?from=%2Fadmin%2Fgames");
  });

  it("sends a signed-in member without the power where requireAdmin sends a non-admin, with no way back", async () => {
    const member = await makeUser(db);
    await signIn(member);
    state.headers = { "next-url": "/admin/games" };

    const asAdminOnly = await refusalOf(requireAdmin);
    const asPermission = await refusalOf(() => requirePermission("games.manage"));

    expect(asPermission).toBe(asAdminOnly);
    expect(asPermission).toBe("/signin?error=admin-only");
  });
});

/* ------------------------------------------------------------------ */
/* Any one of several (Task 130)                                      */
/* ------------------------------------------------------------------ */

/*
 * `requireAnyPermission`, for a page that is more than one power's: the
 * events list, the settings screen, the admin area's front door. The same
 * guard asked about a set - so everything above is asked of it again, on the
 * same database-backed session.
 */
describe("requireAnyPermission", () => {
  const EITHER = ["events.create", "events.manage"] as const;

  it.each(EITHER)("lets a member through who holds %s, one of the powers named", async (power) => {
    const member = await makeUser(db);
    await give(member, power);
    await signIn(member);

    const user = await requireAnyPermission(EITHER);

    expect(user.id).toBe(member);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("turns away a member who holds every power but the ones named", async () => {
    const member = await makeUser(db);
    await give(member, ...POWERS.filter((power) => !(EITHER as readonly Power[]).includes(power)));
    await signIn(member);

    const to = await refusalOf(() => requireAnyPermission(EITHER));

    expect(to).toBe("/signin?error=admin-only");
  });

  it("turns away a member who holds nothing", async () => {
    await signIn(await makeUser(db));

    expect(await refusalOf(() => requireAnyPermission(EITHER))).toBe("/signin?error=admin-only");
  });

  it("lets an admin holding nothing through", async () => {
    const admin = await makeAdmin();
    await signIn(admin);

    expect((await requireAnyPermission(EITHER)).id).toBe(admin);
  });

  it("asked about no power at all, lets an admin through and nobody else", async () => {
    // An empty list is not "anybody": there is nothing on it to hold.
    const member = await makeUser(db);
    await give(member, ...POWERS);
    await signIn(member);
    const to = await refusalOf(() => requireAnyPermission([]));
    await signIn(await makeAdmin());

    await expect(requireAnyPermission([])).resolves.toBeDefined();
    expect(to).toBe("/signin?error=admin-only");
  });

  it("refuses a question that names a power that does not exist, for an admin as well", async () => {
    await signIn(await makeAdmin());

    await expect(
      requireAnyPermission(["events.create", "permissions.grant" as Power])
    ).rejects.toThrow(/"permissions.grant" is not a power/);
  });

  it("refuses a power revoked mid-session on the next request, and leaves the session alone", async () => {
    const member = await makeUser(db);
    await give(member, "events.manage");
    const sessionToken = await signIn(member);
    const before = await requireAnyPermission(EITHER);

    await revoke(member);
    const to = await refusalOf(() => requireAnyPermission(EITHER));

    expect(before.id).toBe(member);
    expect(to).toBe("/signin?error=admin-only");
    expect(await sessionRows(sessionToken)).toHaveLength(1);
  });

  it("sends a signed-out visitor to sign in, remembering the page, as requirePermission does", async () => {
    state.headers = { "next-url": "/admin/events" };

    const one = await refusalOf(() => requirePermission("events.create"));
    const any = await refusalOf(() => requireAnyPermission(EITHER));

    expect(any).toBe(one);
    expect(any).toBe("/signin?from=%2Fadmin%2Fevents");
  });
});

/* ------------------------------------------------------------------ */
/* Granting is not a power (R-264)                                    */
/* ------------------------------------------------------------------ */

describe("there is no power that grants permissions", () => {
  /*
   * The vocabulary's names are pinned one by one in
   * `permissions-policy.test.ts`. This is what the vocabulary buys: the
   * granting screen keeps `requireAdmin`, so the claim is that no combination
   * of powers gets through it - asserted with all of them at once.
   */
  it("a member holding every power there is still does not pass requireAdmin", async () => {
    const member = await makeUser(db);
    await give(member, ...POWERS);
    await signIn(member);

    const passed = await Promise.all(POWERS.map((power) => requirePermission(power)));
    const to = await refusalOf(requireAdmin);

    expect(passed.map((user) => user.id)).toEqual(POWERS.map(() => member));
    expect(to).toBe("/signin?error=admin-only");
  });
});
