import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, userPermissions } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { grantPower, powersOf, setPowers } from "@/lib/permissions";

/**
 * One save of a member's whole list (Task 131, R-262 / UC-55), against a real
 * Postgres.
 *
 * Every "what is stored" below is compared as a set of names. A save that adds
 * one power and removes another leaves the count where it was, so a count
 * would pass a save that did neither.
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

const rowsFor = (userId: string) =>
  db.select().from(userPermissions).where(eq(userPermissions.userId, userId));

const stored = async (userId: string) => new Set(await powersOf(userId, db));

/** A member holding these, each granted by `granter`. */
async function memberHolding(granter: string, powers: string[]): Promise<string> {
  const member = await makeUser(db);
  for (const power of powers) {
    await grantPower({ userId: member, power, grantedByUserId: granter }, db);
  }
  return member;
}

describe("setPowers", () => {
  it("stores exactly the list it is given: one added and one removed in the same save", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage", "audit.read"]);

    await setPowers(
      { userId: member, powers: ["audit.read", "games.manage"], grantedByUserId: granter },
      db
    );

    expect(await stored(member)).toEqual(new Set(["audit.read", "games.manage"]));
  });

  it("says what it added and what it removed", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage", "audit.read"]);

    const change = await setPowers(
      { userId: member, powers: ["audit.read", "games.manage"], grantedByUserId: granter },
      db
    );

    expect(change).toEqual({ added: ["games.manage"], removed: ["polls.manage"] });
  });

  it("reports nothing added and nothing removed when the list is what is already stored", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage", "audit.read"]);

    const change = await setPowers(
      { userId: member, powers: ["audit.read", "polls.manage"], grantedByUserId: granter },
      db
    );

    expect(change).toEqual({ added: [], removed: [] });
  });

  it("leaves a power that stays with the time and the granter it already had", async () => {
    const first = await makeUser(db);
    const second = await makeUser(db);
    const member = await memberHolding(first, ["audit.read"]);
    const [before] = await rowsFor(member);

    await setPowers(
      { userId: member, powers: ["audit.read", "games.manage"], grantedByUserId: second },
      db
    );

    const kept = (await rowsFor(member)).find((row) => row.power === "audit.read");
    expect(kept).toEqual(before);
  });

  it("records who granted a power it adds", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);

    await setPowers({ userId: member, powers: ["games.manage"], grantedByUserId: granter }, db);

    const [row] = await rowsFor(member);
    expect(row.grantedByUserId).toBe(granter);
  });

  it("takes everything away when the list is empty", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage", "audit.read"]);

    await setPowers({ userId: member, powers: [], grantedByUserId: granter }, db);

    expect(await stored(member)).toEqual(new Set());
  });

  it("changes nobody but the member it names", async () => {
    const granter = await makeUser(db);
    const bystander = await memberHolding(granter, ["polls.manage"]);
    const member = await memberHolding(granter, ["polls.manage"]);

    await setPowers({ userId: member, powers: ["audit.read"], grantedByUserId: granter }, db);

    expect(await stored(bystander)).toEqual(new Set(["polls.manage"]));
  });

  it("refuses a name that is not a power, names it, and neither adds nor removes anything", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage"]);

    await expect(
      setPowers(
        { userId: member, powers: ["audit.read", "permissions.grant"], grantedByUserId: granter },
        db
      )
    ).rejects.toThrow(/"permissions\.grant" is not a power/);

    expect(await stored(member)).toEqual(new Set(["polls.manage"]));
  });

  /*
   * A save is one decision, so it lands whole or not at all. The removal runs
   * first and the grant then fails on its foreign key - a granter who is not a
   * member - which is the half-applied list a pair of separate statements
   * would leave behind.
   */
  it("removes nothing when the grant in the same save fails", async () => {
    const granter = await makeUser(db);
    const member = await memberHolding(granter, ["polls.manage"]);

    await expect(
      setPowers(
        {
          userId: member,
          powers: ["audit.read"],
          grantedByUserId: "00000000-0000-0000-0000-000000000000",
        },
        db
      )
    ).rejects.toThrow();

    expect(await stored(member)).toEqual(new Set(["polls.manage"]));
  });

  /*
   * A row outside the vocabulary is invisible to `powersOf`, so it is invisible
   * here too: a save that could remove it would report removing something the
   * screen never showed.
   */
  it("leaves a stored row outside the vocabulary alone, and does not report it", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);
    await db.insert(userPermissions).values({ userId: member, power: "permissions.grant" });

    const change = await setPowers({ userId: member, powers: [], grantedByUserId: granter }, db);

    expect(change).toEqual({ added: [], removed: [] });
    expect((await rowsFor(member)).map((row) => row.power)).toEqual(["permissions.grant"]);
  });
});
