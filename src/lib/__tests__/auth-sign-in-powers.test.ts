import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, adminAllowlist, auditLog, userPermissions, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * A sign-in that makes somebody an admin (Task 151, R-266).
 *
 * `syncUserFromDiscord` sets the flag for an id the allowlist or
 * `ADMIN_DISCORD_IDS` names, with no admin clicking anything. It is the one
 * promotion with no actor, and it used to leave the member's list of powers in
 * the table: read by nothing while the flag was on, and by `powersOf` again
 * the day it was revoked.
 *
 * The real function against a real Postgres. `@/db`'s `db` is pointed at this
 * file's database as `users.test.ts` does it, and `next-auth` is replaced only
 * so the module loads, as in `auth-config.test.ts`.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));

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

vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

const { syncUserFromDiscord } = await import("../auth");
const { powersOf } = await import("../permissions");
const { revokeAdmin } = await import("../admin-users");

let handle: TestDatabase;
let db: Database;

const DISCORD_ID = "123456789012345678";
const PROFILE = { id: DISCORD_ID, global_name: "Ada" };

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(users);
  await db.delete(adminAllowlist);
});

/** A member with this Discord id who holds two powers and no flag. */
async function holder(): Promise<string> {
  const id = await makeUser(db, { displayName: "Ada", discordId: DISCORD_ID });
  await db.insert(userPermissions).values([
    { userId: id, power: "polls.manage" },
    { userId: id, power: "audit.read" },
  ]);
  return id;
}

const rowsOf = async (userId: string) =>
  (
    await db
      .select({ power: userPermissions.power })
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId))
  ).map((row) => row.power);

async function isAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
  return row.isAdmin;
}

describe("a sign-in that makes a member an admin", () => {
  it("deletes the list of powers the flag replaces", async () => {
    const member = await holder();

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: DISCORD_ID });

    expect(await isAdmin(member)).toBe(true);
    expect(await rowsOf(member)).toEqual([]);
  });

  it("leaves them holding nothing when the flag is revoked afterwards", async () => {
    // Criterion 1 on the path with no button: promoted by signing in, demoted
    // by an admin, and then what the guard would be told.
    const member = await holder();
    const admin = await makeUser(db, { displayName: "Admin" });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: DISCORD_ID });
    const revoked = await revokeAdmin(member, admin, db);

    expect(revoked.ok).toBe(true);
    expect(await powersOf(member, db)).toEqual(new Set());
  });

  it("writes a line with no actor that says a sign-in did it and what went", async () => {
    // Nobody clicked. The line is the site's own, as `announcement.failed`
    // is: no actor, which the log shows as "The system".
    const member = await holder();

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: DISCORD_ID });

    expect(await db.select().from(auditLog)).toEqual([
      expect.objectContaining({
        action: "user.powers.changed",
        actorUserId: null,
        actorName: null,
        subject: member,
        summary:
          "Removed Ada's powers: polls.manage, audit.read. Signing in made them an admin from the allowlist, and the flag replaces the list.",
        detail: {
          added: [],
          removed: ["polls.manage", "audit.read"],
          replacedByAdminFlag: true,
          by: "sign-in",
        },
      }),
    ]);
  });

  it("writes no line when the admin signing in has no list", async () => {
    const member = await makeUser(db, { displayName: "Ada", discordId: DISCORD_ID });

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: DISCORD_ID });

    expect(await isAdmin(member)).toBe(true);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});

describe("a sign-in that does not make them an admin", () => {
  it("leaves the list of a member nothing names", async () => {
    // No opinion from the allowlist or the variable: the flag is left as it
    // is, and their list is live.
    const member = await holder();

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: "" });

    expect(await isAdmin(member)).toBe(false);
    expect(new Set(await rowsOf(member))).toEqual(new Set(["polls.manage", "audit.read"]));
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("leaves the list of a member the allowlist bars", async () => {
    // Barred from the flag, not from their powers.
    const member = await holder();
    await db.insert(adminAllowlist).values({ discordId: DISCORD_ID, allowed: false });

    await syncUserFromDiscord(member, PROFILE, { ADMIN_DISCORD_IDS: DISCORD_ID });

    expect(await isAdmin(member)).toBe(false);
    expect(new Set(await rowsOf(member))).toEqual(new Set(["polls.manage", "audit.read"]));
  });
});
