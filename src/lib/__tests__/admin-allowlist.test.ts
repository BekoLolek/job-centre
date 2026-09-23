import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, adminAllowlist, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  allowAdmin,
  barAdmin,
  barAdminUser,
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
    // An empty table is a successful read of a table nobody has written to:
    // no opinion, so the configuration names the first admin (R-141 / UC-29).
    expect(resolveAdminFlag(ID, [], `${ID},${OTHER}`)).toBe(true);
    expect(resolveAdminFlag(ID, [], OTHER)).toBeUndefined();
  });

  it("grants nothing at all when the allowlist could not be read", () => {
    /*
     * `null` is "we do not know", and the environment must not answer on its
     * behalf. One transient failure on that select would otherwise re-grant
     * the flag to everybody still named in ADMIN_DISCORD_IDS — with their bar
     * rows sitting in the table that could not be read, and nothing said about
     * it anywhere. That is the resurrection R-05 / UC-29 2a exists to stop.
     */
    expect(resolveAdminFlag(ID, null, ID)).toBeUndefined();
    expect(resolveAdminFlag(ID, null, `${ID},${OTHER}`)).toBeUndefined();
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

/* ------------------------------------------------------------------ */
/* The bar obeys the rules a demotion obeys — UC-02 5a                */
/* ------------------------------------------------------------------ */

/**
 * Barring is a demotion with a longer memory, so it must not be able to do
 * anything a demotion could not: take your own flag, or the last one.
 *
 * These start from an empty table because the *number of admins* is the thing
 * under test, and a count that depends on what an earlier test left behind is
 * not a count anybody can reason about.
 */
describe("barring, under the rules a demotion obeys", () => {
  beforeEach(async () => {
    await db.delete(adminAllowlist);
    await db.delete(users);
  });

  /** An admin, with a Discord id of their own. */
  async function admin(discordId: string, displayName: string): Promise<string> {
    const id = await makeUser(db, { discordId, displayName });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
    return id;
  }

  async function isAdmin(userId: string): Promise<boolean> {
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
    return row.isAdmin;
  }

  it("refuses an admin barring their own id", async () => {
    const self = await admin(ID, "Self");
    await admin(OTHER, "Somebody else");

    const result = await barAdmin(ID, { actorId: self }, db);

    expect(result.ok === false && result.error).toMatch(/your own admin flag/i);
    expect(await isAdmin(self)).toBe(true);
    // A refusal is not a partial success: no row, so no bar on the next sign-in.
    expect(await getAllowlistEntries(db)).toEqual([]);
  });

  it("refuses the last admin", async () => {
    const only = await admin(ID, "The only one");
    const plain = await makeUser(db, { discordId: OTHER });

    const result = await barAdmin(ID, { actorId: plain }, db);

    expect(result.ok === false && result.error).toMatch(/last admin/i);
    expect(await isAdmin(only)).toBe(true);
    expect(await getAllowlistEntries(db)).toEqual([]);
  });

  it("bars somebody who is not an admin, even when the site has exactly one", async () => {
    /*
     * The count bug. `revokeRefusal` is stated in terms of "how many admins
     * there are right now, *the target included*" — hand it the site's raw
     * count while barring a member who holds no flag and it refuses barring a
     * nobody as "this is the last admin" on every site with one admin, which
     * is most of them. Barring a non-admin takes nothing away from anybody.
     */
    const actor = await admin(ID, "The only admin");
    const member = await makeUser(db, { discordId: OTHER, displayName: "Ordinary" });

    const result = await barAdmin(OTHER, { actorId: actor }, db);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.demotedNow).toBe(false);
    expect(await isAdmin(member)).toBe(false);
    expect(resolveAdminFlag(OTHER, await getAllowlistEntries(db), OTHER)).toBe(false);
  });

  it("bars an id nobody has an account for, whatever the admin count", async () => {
    const actor = await admin(ID, "The only admin");

    const result = await barAdmin("777777777777777777", { actorId: actor }, db);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.userId).toBeNull();
    expect(resolveAdminFlag("777777777777777777", await getAllowlistEntries(db), undefined)).toBe(
      false
    );
  });

  it("bars by account as well as by id, and keys the row on their Discord id", async () => {
    const actor = await admin(ID, "Actor");
    const target = await admin(OTHER, "Target");

    const result = await barAdminUser(target, { actorId: actor }, db);

    expect(result.ok && result.data).toMatchObject({ discordId: OTHER, demotedNow: true });
    expect(await isAdmin(target)).toBe(false);
    expect(resolveAdminFlag(OTHER, await getAllowlistEntries(db), OTHER)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The locks, which no behaviour here can see — UC-02 5a             */
/* ------------------------------------------------------------------ */

/**
 * Why these assert SQL rather than an outcome.
 *
 * The lock in `barWithin` is the mechanism of the concurrency fix, and under
 * this harness **no test can observe it**. PGlite is a single connection, and
 * drizzle's `transaction()` holds that connection for the whole callback, so
 * two transactions run one after the other whether or not a row is locked. The
 * `Promise.all` test in `admin-users.test.ts` therefore proves the
 * transaction, not the lock, and delete `.for("update")` from the production
 * code and every behavioural test in both files still passes.
 *
 * So the statement itself is what is pinned. The queries below are the ones
 * `barWithin` builds — captured on their way to the database rather than
 * rewritten here, which would assert only that this file can type
 * `.for("update")` — and the assertion is that every read of `users` inside
 * the transaction carries the lock: the admin set, whose count both refusals
 * are decided on, and the target's own row, which is compared against that set.
 */

/** The SQL of every statement a transaction runs, in order. */
function recordingDatabase(sink: string[]): Database {
  /*
   * drizzle's builders are thenable: `await` reaches for `then`, which is the
   * last moment the query is still a query and not a result. Everything else
   * is passed through untouched, so the transaction behaves exactly as it does
   * in production — this watches, it does not stand in.
   */
  const watch = <T extends object>(value: T): T => {
    // Results, not queries: `tx.select({…})` is a builder with no SQL in it
    // yet, so the wrapper has to follow the chain through `.from()`, `.where()`
    // and `.for()` and read the statement at the end of it.
    if (Array.isArray(value) || value instanceof Promise) return value;
    return new Proxy(value, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        if (property === "then") {
          const toSQL = (target as { toSQL?: () => { sql: string } }).toSQL;
          if (typeof toSQL === "function") sink.push(toSQL.call(target).sql);
          return inner.bind(target);
        }
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? watch(next as object) : next;
        };
      },
    });
  };

  const watchAll = (tx: Database): Database =>
    new Proxy(tx, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? watch(next as object) : next;
        };
      },
    }) as Database;

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (run: (tx: Database) => Promise<unknown>) =>
        target.transaction((tx) => run(watchAll(tx as unknown as Database)));
    },
  }) as Database;
}

describe("the bar's locked reads", () => {
  beforeEach(async () => {
    await db.delete(adminAllowlist);
    await db.delete(users);
  });

  async function statementsOfABar(): Promise<string[]> {
    const actor = await makeUser(db, { discordId: ID, displayName: "Actor" });
    const target = await makeUser(db, { discordId: OTHER, displayName: "Target" });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, actor));
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, target));

    const sink: string[] = [];
    const result = await barAdminUser(target, { actorId: actor }, recordingDatabase(sink));
    expect(result.ok).toBe(true);
    return sink;
  }

  it("locks the admin set it counts", async () => {
    const reads = (await statementsOfABar()).filter((sql) => /^\s*select/i.test(sql));
    const adminSet = reads.filter((sql) => /"is_admin"\s*=/i.test(sql));

    expect(adminSet).toHaveLength(1);
    expect(adminSet[0]).toMatch(/for update/i);
  });

  it("locks the target's row too, not only the set it is compared against", async () => {
    // Unlocked, this read sees a `grantAdmin` that committed between the two
    // statements while the locked set does not: `holdsFlag` comes out false,
    // the row is barred and the flag is left on.
    const reads = (await statementsOfABar()).filter((sql) => /^\s*select/i.test(sql));

    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) expect(read).toMatch(/for update/i);
  });
});
