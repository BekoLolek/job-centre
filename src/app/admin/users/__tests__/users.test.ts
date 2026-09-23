import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, sessions, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * `/admin/users`, at the level the buttons actually call (Task 15, UC-01,
 * UC-02, UC-29).
 *
 * The library has its own file; this one is about the actions, because the
 * things worth proving here only exist once the whole path runs: that the
 * guard is on every one of them, that a refusal writes no audit line, and
 * above all that a revoke made on this screen survives a sign-in with the
 * id still sitting in `ADMIN_DISCORD_IDS` (UC-29 2a).
 *
 * The actions run for real against an in-memory Postgres. Only what cannot run
 * outside a Next request is replaced: the session cookie and the page cache.
 * `@/db`'s `db` is pointed at this file's database the same way
 * `host-scope.test.ts` does it — a proxy that binds to the live handle.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const {
  allowAdminAction,
  barAdminAction,
  endSessionsAction,
  grantAdminAction,
  revokeAdminAction,
} = await import("../actions");
const { getAllowlistEntries } = await import("@/lib/admin-allowlist");
const { resolveAdminFlag } = await import("@/lib/auth-policy");
const { adminCount } = await import("@/lib/admin-users");

let handle: TestDatabase;
let db: Database;

const TARGET_DISCORD_ID = "123456789012345678";

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  state.userId = null;
  await db.delete(auditLog);
  await db.delete(sessions);
  await db.delete(users);
  const { adminAllowlist } = await import("@/db");
  await db.delete(adminAllowlist);
});

/** A member holding the flag, and the actor for the next call. */
async function makeAdmin(displayName: string, discordId?: string): Promise<string> {
  const id = await makeUser(db, { displayName, discordId });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  return id;
}

function signedInAs(userId: string): void {
  state.userId = userId;
}

async function isAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
  return row.isAdmin;
}

async function auditActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog);
  return rows.map((row) => row.action);
}

/* ------------------------------------------------------------------ */
/* Every action is a public endpoint                                  */
/* ------------------------------------------------------------------ */

describe("the guard", () => {
  it("refuses a signed-in member who is not an admin", async () => {
    // UC-27 1a. A server action is reachable by anyone who can send the POST,
    // so the page having rendered the button proves nothing.
    const member = await makeUser(db, { displayName: "Ordinary" });
    signedInAs(member);

    await expect(grantAdminAction(member)).rejects.toThrow();
    await expect(revokeAdminAction(member)).rejects.toThrow();
    await expect(endSessionsAction(member)).rejects.toThrow();
    await expect(barAdminAction({ discordId: TARGET_DISCORD_ID })).rejects.toThrow();
    await expect(allowAdminAction({ discordId: TARGET_DISCORD_ID })).rejects.toThrow();
  });

  it("refuses somebody signed in as nobody", async () => {
    await expect(revokeAdminAction("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* UC-02 5 / UC-29 2a — the revoke that holds                         */
/* ------------------------------------------------------------------ */

describe("revoking on the members screen", () => {
  it("leaves a revoked admin non-admin with ADMIN_DISCORD_IDS still naming them", async () => {
    // The acceptance criterion of Task 15, at the level the button calls.
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", TARGET_DISCORD_ID);
    signedInAs(actor);

    const result = await revokeAdminAction(target);

    expect(result.ok).toBe(true);
    expect(await isAdmin(target)).toBe(false);
    // What the sign-in path will decide next time they turn up, with the id
    // still in the environment variable: no, and not "no opinion".
    expect(
      resolveAdminFlag(TARGET_DISCORD_ID, await getAllowlistEntries(), TARGET_DISCORD_ID)
    ).toBe(false);
  });

  it("records the revoke as the permanent thing it is", async () => {
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", TARGET_DISCORD_ID);
    signedInAs(actor);

    await revokeAdminAction(target);

    const [line] = await db.select().from(auditLog);
    expect(line.action).toBe("user.admin.revoked");
    expect(line.actorUserId).toBe(actor);
    expect(line.summary).toMatch(/cannot be made one again by signing in/i);
    expect(line.detail).toMatchObject({ barred: true });
  });

  it("refuses an admin revoking themselves, and logs nothing", async () => {
    // UC-02 5a. Nothing happened, so nothing is recorded as having happened.
    const actor = await makeAdmin("Actor");
    await makeAdmin("Somebody else");
    signedInAs(actor);

    const result = await revokeAdminAction(actor);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/your own admin flag/i);
    expect(await isAdmin(actor)).toBe(true);
    expect(await auditActions()).toEqual([]);
  });

  it("cannot be used to reach zero admins from either side", async () => {
    /*
     * UC-02 5a, as far as one caller can get at it. Sequentially the last-admin
     * refusal is unreachable through this action, and that is worth pinning
     * down rather than writing a test that pretends otherwise: the actor has to
     * be an admin to pass the guard, so a count of one means the actor *is* the
     * last admin, and the only target they could aim at is themselves — which
     * the self rule refuses first. The demoted admin cannot call the action at
     * all any more.
     *
     * Concurrently it is very much reachable, and that is where the rule earns
     * its keep. `admin-users.test.ts` runs the two revokes against each other.
     */
    const actor = await makeAdmin("Actor");
    const other = await makeAdmin("Other");
    signedInAs(actor);
    await revokeAdminAction(other);

    // The one admin left, aiming at the only target available to them.
    expect((await revokeAdminAction(actor)).ok).toBe(false);

    // And the one just demoted is no longer allowed to ask.
    signedInAs(other);
    await expect(revokeAdminAction(actor)).rejects.toThrow();

    expect(await adminCount()).toBe(1);
    expect(await auditActions()).toEqual(["user.admin.revoked"]);
  });

  it("puts the flag back when an admin is granted it again", async () => {
    // UC-02 1-3 read the other way: a bar is a decision, not a tombstone, and
    // the screen can undo it.
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", TARGET_DISCORD_ID);
    signedInAs(actor);
    await revokeAdminAction(target);

    const regranted = await allowAdminAction({ discordId: TARGET_DISCORD_ID });

    expect(regranted.ok).toBe(true);
    expect(await isAdmin(target)).toBe(true);
    expect(resolveAdminFlag(TARGET_DISCORD_ID, await getAllowlistEntries(), undefined)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* UC-02 5a — the bar counts admins correctly                         */
/* ------------------------------------------------------------------ */

describe("barring from the allowlist panel", () => {
  it("bars a member who is not an admin, on a site with exactly one admin", async () => {
    /*
     * The count this action used to get wrong. It read the whole site's admin
     * count and handed it to a rule stated in terms of "the target included",
     * so barring somebody who held no flag was refused as "this is the last
     * admin" — a refusal over an action that takes nothing away.
     */
    const actor = await makeAdmin("The only admin");
    const member = await makeUser(db, { displayName: "Ordinary", discordId: TARGET_DISCORD_ID });
    signedInAs(actor);

    const result = await barAdminAction({ discordId: TARGET_DISCORD_ID });

    expect(result.ok).toBe(true);
    expect(await isAdmin(member)).toBe(false);
    expect(await isAdmin(actor)).toBe(true);
  });

  it("refuses an admin barring their own id", async () => {
    const actor = await makeAdmin("Actor", TARGET_DISCORD_ID);
    await makeAdmin("Somebody else");
    signedInAs(actor);

    const result = await barAdminAction({ discordId: TARGET_DISCORD_ID });

    expect(result.ok === false && result.error).toMatch(/your own admin flag/i);
    expect(await isAdmin(actor)).toBe(true);
    expect(await getAllowlistEntries()).toEqual([]);
    expect(await auditActions()).toEqual([]);
  });

  it("bars another admin, demoting them in the same call", async () => {
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", TARGET_DISCORD_ID);
    signedInAs(actor);

    const result = await barAdminAction({ discordId: TARGET_DISCORD_ID, note: "Left" });

    expect(result.ok).toBe(true);
    expect(await isAdmin(target)).toBe(false);
    expect(
      resolveAdminFlag(TARGET_DISCORD_ID, await getAllowlistEntries(), TARGET_DISCORD_ID)
    ).toBe(false);
  });

  it("refuses an id that is not one", async () => {
    // UC-02 2a.
    const actor = await makeAdmin("Actor");
    signedInAs(actor);

    const result = await barAdminAction({ discordId: "someone" });

    expect(result.ok === false && result.error).toMatch(/not a Discord id/i);
  });
});

/* ------------------------------------------------------------------ */
/* UC-02 4a — ending a member's sessions                              */
/* ------------------------------------------------------------------ */

describe("ending sessions", () => {
  async function openSession(userId: string, token: string): Promise<void> {
    await db
      .insert(sessions)
      .values({ sessionToken: token, userId, expires: new Date("2099-01-01T00:00:00Z") });
  }

  it("deletes their sessions and records that it happened", async () => {
    const actor = await makeAdmin("Actor");
    const member = await makeUser(db, { displayName: "Removed" });
    await openSession(member, "phone");
    await openSession(member, "laptop");
    signedInAs(actor);

    const result = await endSessionsAction(member);

    expect(result).toEqual({ ok: true, data: { ended: 2 } });
    expect(await db.select().from(sessions)).toEqual([]);

    const [line] = await db.select().from(auditLog);
    expect(line.action).toBe("user.sessions.ended");
    expect(line.subject).toBe(member);
    // The log says it happened and to whom — never the token.
    expect(JSON.stringify(line)).not.toContain("phone");
  });

  it("does not take the admin flag with it", async () => {
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target");
    await openSession(target, "somewhere");
    signedInAs(actor);

    await endSessionsAction(target);

    expect(await isAdmin(target)).toBe(true);
  });

  it("refuses a member who no longer exists", async () => {
    const actor = await makeAdmin("Actor");
    signedInAs(actor);

    const result = await endSessionsAction("00000000-0000-0000-0000-000000000000");

    expect(result.ok === false && result.error).toMatch(/no longer exists/i);
    expect(await auditActions()).toEqual([]);
  });
});
