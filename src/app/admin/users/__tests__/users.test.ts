import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Database,
  adminAllowlist,
  auditLog,
  sessions,
  userNotes,
  userPermissions,
  users,
} from "@/db";
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

const actions = await import("../actions");
const {
  allowAdminAction,
  barAdminAction,
  endSessionsAction,
  grantAdminAction,
  revokeAdminAction,
  saveMemberPowersAction,
} = actions;
const { grantPower, powersOf } = await import("@/lib/permissions");
const { POWERS } = await import("@/lib/permissions-policy");
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
/* R-264 — no power reaches this file                                 */
/* ------------------------------------------------------------------ */

/**
 * Granting is never a power, so the member asking here holds **every** power
 * there is and is still turned away from every export of the module. One call
 * per export, each one something that would be written if the guard let them
 * through: a real member to promote, a second admin to demote, a real id to
 * allow and to bar.
 *
 * Every power rather than a likely one, because the claim is about the whole
 * vocabulary: an action moved onto any `requirePermission` at all admits this
 * member, whichever power it names.
 */
describe("a member holding every power there is", () => {
  let target: string;
  let otherAdmin: string;

  const CALLS: Record<string, () => Promise<unknown>> = {
    grantAdminAction: () => actions.grantAdminAction(target),
    revokeAdminAction: () => actions.revokeAdminAction(otherAdmin),
    endSessionsAction: () => actions.endSessionsAction(target),
    listUserNotesAction: () => actions.listUserNotesAction(target),
    addUserNoteAction: () => actions.addUserNoteAction(target, "A note they may not write."),
    allowAdminAction: () => actions.allowAdminAction({ discordId: TARGET_DISCORD_ID }),
    barAdminAction: () => actions.barAdminAction({ discordId: TARGET_DISCORD_ID }),
    // The one that hands powers out: to the target, and - the escalation the
    // requirement is about - a holder saving a list for somebody else.
    saveMemberPowersAction: () => actions.saveMemberPowersAction(target, ["audit.read"]),
  };

  beforeEach(async () => {
    const granter = await makeAdmin("The admin who granted");
    otherAdmin = await makeAdmin("A second admin");
    target = await makeUser(db, { displayName: "Target", discordId: TARGET_DISCORD_ID });
    await db.insert(sessions).values({
      sessionToken: "an-open-session",
      userId: target,
      expires: new Date("2100-01-01T00:00:00Z"),
    });
    const holder = await makeUser(db, { displayName: "Holder of everything" });
    for (const power of POWERS) {
      await grantPower({ userId: holder, power, grantedByUserId: granter }, db);
    }
    signedInAs(holder);
  });

  /** What the eight actions between them can move. */
  async function written() {
    const [lines, flags, allowed, notes, open, powers] = await Promise.all([
      db.select({ id: auditLog.id }).from(auditLog),
      db.select({ id: users.id, isAdmin: users.isAdmin }).from(users).orderBy(users.id),
      db.select().from(adminAllowlist),
      db.select({ id: userNotes.id }).from(userNotes),
      db.select({ token: sessions.sessionToken }).from(sessions),
      db
        .select({ userId: userPermissions.userId, power: userPermissions.power })
        .from(userPermissions)
        .orderBy(userPermissions.userId, userPermissions.power),
    ]);
    return { audit: lines.length, flags, allowed, notes, open, powers };
  }

  it("has a call here for every action the members file exports", () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(actions).sort());
  });

  it.each(Object.keys(CALLS))("is turned away from %s, and nothing is written", async (action) => {
    const before = await written();

    await expect(CALLS[action]()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await written()).toEqual(before);
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

/* ------------------------------------------------------------------ */
/* Task 131, R-262, R-266 / UC-55 — saving a member's powers          */
/* ------------------------------------------------------------------ */

describe("saving a member's powers", () => {
  let actor: string;
  let member: string;

  /** Signed in as an admin, with a member who holds two powers already. */
  beforeEach(async () => {
    actor = await makeAdmin("Actor");
    member = await makeUser(db, { displayName: "Ada" });
    await grantPower({ userId: member, power: "polls.manage", grantedByUserId: actor }, db);
    await grantPower({ userId: member, power: "audit.read", grantedByUserId: actor }, db);
    signedInAs(actor);
  });

  const stored = async (userId: string) => new Set(await powersOf(userId, db));

  it("stores exactly what was marked: one added and one removed in the same save", async () => {
    // Two before, two after. The set is compared, because the count cannot
    // tell this save from one that did nothing.
    await saveMemberPowersAction(member, ["audit.read", "games.manage"]);

    expect(await stored(member)).toEqual(new Set(["audit.read", "games.manage"]));
  });

  it("records the admin who saved as the one who granted the power it added", async () => {
    // The row and the audit line are two records of one event, and the row is
    // the one `powersOf` reads. The member is a valid granter as far as the
    // foreign key goes, so only this says it was not them.
    await saveMemberPowersAction(member, ["polls.manage", "audit.read", "games.manage"]);

    const [added] = await db
      .select({ grantedByUserId: userPermissions.grantedByUserId })
      .from(userPermissions)
      .where(eq(userPermissions.power, "games.manage"));
    expect(added.grantedByUserId).toBe(actor);
  });

  it("writes one line, naming who saved, whose list it was and what changed", async () => {
    await saveMemberPowersAction(member, ["audit.read", "games.manage"]);

    const lines = await db.select().from(auditLog);
    expect(lines).toEqual([
      expect.objectContaining({
        action: "user.powers.changed",
        actorUserId: actor,
        actorName: "Actor",
        subject: member,
        summary: "Changed Ada's powers: added games.manage; removed polls.manage.",
        detail: { added: ["games.manage"], removed: ["polls.manage"] },
      }),
    ]);
  });

  it("writes no line for a save that changes nothing", async () => {
    const result = await saveMemberPowersAction(member, ["polls.manage", "audit.read"]);

    expect(result).toEqual({ ok: true, data: { added: [], removed: [] } });
    expect(await auditActions()).toEqual([]);
  });

  it("says only what was added when nothing was removed", async () => {
    await saveMemberPowersAction(member, ["polls.manage", "audit.read", "games.manage"]);

    const [line] = await db.select().from(auditLog);
    expect(line.summary).toBe("Changed Ada's powers: added games.manage.");
  });

  it("refuses a list for a member who is an admin, and writes nothing", async () => {
    const admin = await makeAdmin("Grace");

    const result = await saveMemberPowersAction(admin, ["audit.read"]);

    expect(result.ok === false && result.error).toMatch(/Grace is an admin/);
    expect(await stored(admin)).toEqual(new Set());
    expect(await auditActions()).toEqual([]);
  });

  // The admin flag is not a power, under any of the names somebody might try.
  it.each(["admin", "isAdmin", "is_admin", "user.admin.granted", "permissions.grant"])(
    "cannot be made to grant the admin flag by naming it %s",
    async (name) => {
      const result = await saveMemberPowersAction(member, ["audit.read", name]);

      expect(result.ok).toBe(false);
      expect(await isAdmin(member)).toBe(false);
      expect(await stored(member)).toEqual(new Set(["polls.manage", "audit.read"]));
      expect(await auditActions()).toEqual([]);
    }
  );

  it("leaves the admin flag off after a save that works", async () => {
    await saveMemberPowersAction(member, [...POWERS]);

    expect(await isAdmin(member)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Task 151, R-264, R-266 — a demoted admin holds what somebody chose  */
/* ------------------------------------------------------------------ */

/**
 * The flag replaces the list. A list stored before a promotion used to stay in
 * the table and come back into force on demotion, with no line in the log for
 * its return; promoting now deletes it and says so.
 *
 * Through the real actions throughout, and the table is read as well as
 * `powersOf` - `powersOf` is what the guard asks, the table is where a row
 * that would wake later is hiding.
 */
describe("promoting a member who holds powers", () => {
  let granter: string;
  let promoter: string;
  let member: string;

  const rowsOf = async (userId: string) =>
    (
      await db
        .select({ power: userPermissions.power })
        .from(userPermissions)
        .where(eq(userPermissions.userId, userId))
    ).map((row) => row.power);

  /** The log, in the order `recordAudit` wrote it. */
  const lines = async () =>
    (await db.select().from(auditLog)).sort(
      (a, b) => a.at.getTime() - b.at.getTime() || a.action.localeCompare(b.action)
    );

  /** Ada holds two powers, saved by one admin; a second admin is about to act. */
  beforeEach(async () => {
    granter = await makeAdmin("Granter");
    promoter = await makeAdmin("Promoter");
    member = await makeUser(db, { displayName: "Ada", discordId: TARGET_DISCORD_ID });
    signedInAs(granter);
    await saveMemberPowersAction(member, ["polls.manage", "audit.read"]);
    await db.delete(auditLog);
    signedInAs(promoter);
  });

  it("leaves them holding nothing once promoted and then demoted", async () => {
    // Criterion 1, end to end: grant, promote, demote, then ask what the
    // guard would be told.
    await grantAdminAction(member);
    signedInAs(granter);
    const demoted = await revokeAdminAction(member);

    expect(demoted.ok).toBe(true);
    expect(await isAdmin(member)).toBe(false);
    expect(await powersOf(member, db)).toEqual(new Set());
    expect(await rowsOf(member)).toEqual([]);
  });

  it("has no stored row for them while they are an admin", async () => {
    await grantAdminAction(member);

    expect(await rowsOf(member)).toEqual([]);
  });

  it("writes a line for the list it removed, naming the admin who promoted", async () => {
    await grantAdminAction(member);

    expect(await lines()).toEqual([
      expect.objectContaining({ action: "user.admin.granted", actorUserId: promoter }),
      expect.objectContaining({
        action: "user.powers.changed",
        actorUserId: promoter,
        actorName: "Promoter",
        subject: member,
        summary:
          "Removed Ada's powers on making them an admin: polls.manage, audit.read. The flag replaces the list.",
        detail: { added: [], removed: ["polls.manage", "audit.read"], replacedByAdminFlag: true },
      }),
    ]);
  });

  it("writes no powers line when the member promoted held nothing", async () => {
    const plain = await makeUser(db, { displayName: "Plain" });

    await grantAdminAction(plain);

    expect(await auditActions()).toEqual(["user.admin.granted"]);
  });

  it("removes the list when the promotion is made from the allowlist panel", async () => {
    // The other button that sets the flag on an account that already exists.
    const allowed = await allowAdminAction({ discordId: TARGET_DISCORD_ID });

    expect(allowed.ok).toBe(true);
    expect(await isAdmin(member)).toBe(true);
    expect(await rowsOf(member)).toEqual([]);
    expect(await lines()).toEqual([
      expect.objectContaining({ action: "user.admin.granted", actorUserId: promoter }),
      expect.objectContaining({
        action: "user.powers.changed",
        actorUserId: promoter,
        subject: member,
        detail: { added: [], removed: ["polls.manage", "audit.read"], replacedByAdminFlag: true },
      }),
    ]);
  });

  it("leaves them holding nothing once allowed from the panel and then barred", async () => {
    await allowAdminAction({ discordId: TARGET_DISCORD_ID });
    await barAdminAction({ discordId: TARGET_DISCORD_ID });

    expect(await isAdmin(member)).toBe(false);
    expect(await powersOf(member, db)).toEqual(new Set());
  });

  it("clears rows an admin still has when the empty list is saved for them, with a line", async () => {
    // Rows on an admin that no promotion on this screen made: a sign-in sets
    // the flag without anybody clicking. The screen offers this save.
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, member));

    const result = await saveMemberPowersAction(member, []);

    expect(result).toEqual({
      ok: true,
      data: { added: [], removed: ["polls.manage", "audit.read"] },
    });
    expect(await rowsOf(member)).toEqual([]);
    expect(await lines()).toEqual([
      expect.objectContaining({
        action: "user.powers.changed",
        actorUserId: promoter,
        subject: member,
        summary: "Changed Ada's powers: removed polls.manage, audit.read.",
      }),
    ]);
  });
});
