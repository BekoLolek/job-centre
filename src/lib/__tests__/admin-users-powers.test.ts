import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, userPermissions, users } from "@/db";
import {
  type TestDatabase,
  committingAfter,
  freshDatabase,
  makeUser,
} from "@/db/__tests__/helpers";
import { allowAdmin } from "@/lib/admin-allowlist";
import {
  grantAdmin,
  loadAdminUsers,
  saveMemberPowers,
} from "@/lib/admin-users";
import { clearPowers, grantPower, powersOf } from "@/lib/permissions";

/**
 * The rules of the granting screen (Task 131, R-262, R-264 / UC-55), against a
 * real Postgres: who has a list to edit, what may be on it, and what the
 * members list reads back.
 */

let handle: TestDatabase;
let db: Database;
let actor: string;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.delete(users);
  actor = await makeUser(db, { displayName: "The admin saving" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, actor));
});

const stored = async (userId: string) => new Set(await powersOf(userId, db));

const allRows = () => db.select().from(userPermissions);

describe("saveMemberPowers", () => {
  it("stores the list and hands back the member with what changed", async () => {
    const member = await makeUser(db, { displayName: "Ada" });
    await grantPower({ userId: member, power: "polls.manage", grantedByUserId: actor }, db);

    const result = await saveMemberPowers(member, ["audit.read"], actor, db);

    expect(result).toMatchObject({
      ok: true,
      data: { user: { id: member }, added: ["audit.read"], removed: ["polls.manage"] },
    });
    expect(await stored(member)).toEqual(new Set(["audit.read"]));
  });

  it("records the admin who saved as the one who granted", async () => {
    const member = await makeUser(db, { displayName: "Ada" });

    await saveMemberPowers(member, ["audit.read"], actor, db);

    const [row] = await allRows();
    expect(row).toMatchObject({ userId: member, power: "audit.read", grantedByUserId: actor });
  });

  it("refuses a member who holds the admin flag, says why, and stores nothing", async () => {
    const admin = await makeUser(db, { displayName: "Grace" });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));

    const result = await saveMemberPowers(admin, ["audit.read"], actor, db);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Grace is an admin/) });
    expect(await allRows()).toEqual([]);
  });

  it("refuses a member who no longer exists", async () => {
    const result = await saveMemberPowers(
      "00000000-0000-0000-0000-000000000000",
      ["audit.read"],
      actor,
      db
    );

    expect(result).toEqual({ ok: false, error: "That member no longer exists." });
  });

  it("refuses a name that is not a power as a message rather than a crash, and stores nothing", async () => {
    const member = await makeUser(db);

    const result = await saveMemberPowers(member, ["audit.read", "admin"], actor, db);

    expect(result).toEqual({ ok: false, error: expect.stringContaining('"admin" is not a power') });
    expect(await allRows()).toEqual([]);
  });

  it("refuses something that is not a list of names", async () => {
    const member = await makeUser(db);

    const result = await saveMemberPowers(member, "audit.read" as unknown as string[], actor, db);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/list of powers/) });
    expect(await allRows()).toEqual([]);
  });
});

describe("loadAdminUsers", () => {
  it("reads each member's own powers, and nobody else's", async () => {
    const holder = await makeUser(db, { displayName: "Holder" });
    const other = await makeUser(db, { displayName: "Other" });
    await grantPower({ userId: holder, power: "polls.manage", grantedByUserId: actor }, db);
    await grantPower({ userId: holder, power: "audit.read", grantedByUserId: actor }, db);

    const view = await loadAdminUsers({ adminIdsEnv: "" }, db);

    const powersOfRow = (id: string) => new Set(view.users.find((row) => row.id === id)?.powers);
    expect(powersOfRow(holder)).toEqual(new Set(["polls.manage", "audit.read"]));
    expect(powersOfRow(other)).toEqual(new Set());
  });

  it("does not show a stored row that is not in the vocabulary", async () => {
    const member = await makeUser(db, { displayName: "Holder" });
    await db.insert(userPermissions).values({ userId: member, power: "permissions.grant" });
    await db.insert(userPermissions).values({ userId: member, power: "audit.read" });

    const view = await loadAdminUsers({ adminIdsEnv: "" }, db);

    expect(view.users.find((row) => row.id === member)?.powers).toEqual(["audit.read"]);
  });
});

/* ------------------------------------------------------------------ */
/* Task 151, R-264, R-266 — the flag replaces the list                */
/* ------------------------------------------------------------------ */

/**
 * A list stored before a promotion used to stay in the table, read by nothing
 * while the flag was on and by `powersOf` again the moment it came off. The
 * resolution is that the flag *replaces* the list: promoting deletes it, so
 * there is nothing left to wake.
 *
 * `rowsOf` reads the table itself rather than `powersOf`, wherever the claim
 * is "no row" - `powersOf` hides a row outside the vocabulary, and `holderFor`
 * hides every row of an admin, which is how this went unseen.
 */
const rowsOf = async (userId: string) =>
  (
    await db
      .select({ power: userPermissions.power })
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId))
  ).map((row) => row.power);

/** A member holding these, each granted by the admin in `actor`. */
async function memberHolding(powers: string[], over: { discordId?: string } = {}) {
  const member = await makeUser(db, { displayName: "Ada", ...over });
  for (const power of powers) {
    await grantPower({ userId: member, power, grantedByUserId: actor }, db);
  }
  return member;
}

const setFlag = (userId: string, isAdmin: boolean) =>
  db.update(users).set({ isAdmin }).where(eq(users.id, userId));

describe("clearPowers", () => {
  it("removes every power this member holds and says which, in the vocabulary's order", async () => {
    // Granted in the opposite order to the vocabulary, so the order of the
    // answer is the vocabulary's and not the order the rows were written.
    const member = await memberHolding(["audit.read", "polls.manage"]);

    const cleared = await clearPowers(member, db);

    expect(cleared).toEqual(["polls.manage", "audit.read"]);
    expect(await rowsOf(member)).toEqual([]);
  });

  it("leaves somebody else's list where it is", async () => {
    const member = await memberHolding(["polls.manage"]);
    const other = await memberHolding(["audit.read"]);

    await clearPowers(member, db);

    expect(await rowsOf(other)).toEqual(["audit.read"]);
  });

  it("leaves a row outside the vocabulary alone and does not report it", async () => {
    // As `setPowers` does: no screen ever showed it, so a line in the log
    // about removing it would be about nothing anybody saw.
    const member = await memberHolding(["audit.read"]);
    await db.insert(userPermissions).values({ userId: member, power: "permissions.grant" });

    const cleared = await clearPowers(member, db);

    expect(cleared).toEqual(["audit.read"]);
    expect(await rowsOf(member)).toEqual(["permissions.grant"]);
  });
});

describe("grantAdmin and the member's list", () => {
  it("deletes the list the flag replaces, and reports what it deleted", async () => {
    const member = await memberHolding(["polls.manage", "audit.read"]);

    const result = await grantAdmin(member, db);

    expect(result).toMatchObject({
      ok: true,
      data: { user: { id: member, isAdmin: true }, clearedPowers: ["polls.manage", "audit.read"] },
    });
    expect(await rowsOf(member)).toEqual([]);
  });

  it("reports nothing cleared for a member who held nothing", async () => {
    const member = await memberHolding([]);

    const result = await grantAdmin(member, db);

    expect(result).toMatchObject({ ok: true, data: { clearedPowers: [] } });
  });

  it("deletes a list that was saved after the click and before the write", async () => {
    // Another admin's save commits in the gap. Deciding what to delete from a
    // read made before the transaction would leave this row behind.
    const member = await memberHolding([]);

    const result = await grantAdmin(
      member,
      committingAfter(db, () => saveMemberPowers(member, ["audit.read"], actor, db))
    );

    expect(result).toMatchObject({ ok: true, data: { clearedPowers: ["audit.read"] } });
    expect(await rowsOf(member)).toEqual([]);
  });

  it("deletes rows left on somebody who already holds the flag", async () => {
    // A sign-in can set the flag with no admin clicking anything, and it does
    // not go through here. Granting again is one way those rows are removed.
    const member = await memberHolding(["polls.manage"]);
    await setFlag(member, true);

    const result = await grantAdmin(member, db);

    expect(result).toMatchObject({ ok: true, data: { clearedPowers: ["polls.manage"] } });
    expect(await rowsOf(member)).toEqual([]);
  });
});

describe("saveMemberPowers and the flag", () => {
  it("refuses a list for a member who was made an admin after the click, and stores nothing", async () => {
    // The promotion commits between this save reading the member and writing
    // their list. A row written here would be exactly the dormant row.
    const member = await memberHolding([]);

    const result = await saveMemberPowers(
      member,
      ["audit.read"],
      actor,
      committingAfter(db, () => grantAdmin(member, db))
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Ada is an admin/) });
    expect(await rowsOf(member)).toEqual([]);
  });

  it("lets an admin's stored rows be cleared with the empty list, and reports them", async () => {
    // The one list an admin can be given is none: it is how rows that arrived
    // without a promotion on this screen are removed by somebody's decision.
    const admin = await memberHolding(["polls.manage"]);
    await setFlag(admin, true);

    const result = await saveMemberPowers(admin, [], actor, db);

    expect(result).toMatchObject({ ok: true, data: { added: [], removed: ["polls.manage"] } });
    expect(await rowsOf(admin)).toEqual([]);
  });
});

/**
 * A handle that refuses every write made outside a transaction.
 *
 * What "in the same transaction as the flag" means, asked directly: the flag
 * and the list are both written through the `tx`, so a write on the handle
 * itself is one that could commit on its own.
 */
function writingOnlyInATransaction(real: Database): Database {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "insert" || property === "update" || property === "delete") {
        return () => {
          throw new Error(`${property} outside the transaction`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("allowAdmin and the member's list", () => {
  const DISCORD_ID = "222222222222222222";

  it("deletes the list of the account it promotes, and says whose it was and what went", async () => {
    const member = await memberHolding(["polls.manage", "audit.read"], { discordId: DISCORD_ID });

    const result = await allowAdmin(DISCORD_ID, { addedByUserId: actor }, db);

    expect(result).toMatchObject({
      ok: true,
      data: {
        account: { id: member, displayName: "Ada" },
        clearedPowers: ["polls.manage", "audit.read"],
      },
    });
    expect(await rowsOf(member)).toEqual([]);
  });

  it("sets the flag and deletes the list in the one transaction", async () => {
    // Cleared in a second transaction, the member is for a moment an admin
    // with a live list, and a demotion landing there wakes it.
    const member = await memberHolding(["polls.manage"], { discordId: DISCORD_ID });

    const result = await allowAdmin(DISCORD_ID, {}, writingOnlyInATransaction(db));

    expect(result).toMatchObject({ ok: true, data: { clearedPowers: ["polls.manage"] } });
    expect(await rowsOf(member)).toEqual([]);
  });

  it("leaves everybody's list alone for an id that has no account yet", async () => {
    const member = await memberHolding(["polls.manage"]);

    const result = await allowAdmin(DISCORD_ID, {}, db);

    expect(result).toMatchObject({ ok: true, data: { account: null, clearedPowers: [] } });
    expect(await rowsOf(member)).toEqual(["polls.manage"]);
  });
});

describe("loadAdminUsers and an admin", () => {
  it("reads the rows stored for an admin, so the screen can say they are there", async () => {
    const admin = await memberHolding(["polls.manage"]);
    await setFlag(admin, true);

    const view = await loadAdminUsers({ adminIdsEnv: "" }, db);

    expect(view.users.find((row) => row.id === admin)?.powers).toEqual(["polls.manage"]);
  });
});
