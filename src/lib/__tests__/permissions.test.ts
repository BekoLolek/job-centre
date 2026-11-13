import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, userPermissions, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { grantPower, powersOf } from "@/lib/permissions";
import { POWERS, holds } from "@/lib/permissions-policy";

/**
 * One row per grant (R-261 / UC-55), against a real Postgres.
 *
 * The admin flag is never a row here. Each "may they" below is asked through
 * `holds`, with the flag beside whatever `powersOf` read — the same function
 * for a member and an admin, which is the first acceptance criterion.
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

describe("powersOf", () => {
  it("is empty for a member nobody has given anything", async () => {
    const member = await makeUser(db);

    expect([...(await powersOf(member, db))]).toEqual([]);
  });

  it.each([...POWERS])("a member with no rows does not hold %s", async (power) => {
    const member = await makeUser(db);

    expect(holds({ isAdmin: false, powers: await powersOf(member, db) }, power)).toBe(false);
  });

  it.each([...POWERS])("an admin with no rows holds %s", async (power) => {
    const adminId = await makeUser(db);

    expect(holds({ isAdmin: true, powers: await powersOf(adminId, db) }, power)).toBe(true);
  });

  it("reads back what was granted, and only to the member it was granted to", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);
    const bystander = await makeUser(db);

    await grantPower({ userId: member, power: "polls.manage", grantedByUserId: granter }, db);
    await grantPower({ userId: member, power: "audit.read", grantedByUserId: granter }, db);

    expect([...(await powersOf(member, db))].sort()).toEqual(["audit.read", "polls.manage"]);
    expect([...(await powersOf(bystander, db))]).toEqual([]);
  });

  /*
   * A row can name something the vocabulary does not hold: a power retired in
   * a later release, or a row written by hand. It is dropped at the read, so
   * nothing downstream — a count, a loop over the set — ever sees it.
   */
  it("drops a stored row whose power is not in the vocabulary", async () => {
    const member = await makeUser(db);
    await db.insert(userPermissions).values({ userId: member, power: "permissions.grant" });
    await db.insert(userPermissions).values({ userId: member, power: "audit.read" });

    expect([...(await powersOf(member, db))]).toEqual(["audit.read"]);
  });

  it("is empty for a member whose only row is outside the vocabulary", async () => {
    const member = await makeUser(db);
    await db.insert(userPermissions).values({ userId: member, power: "permissions.grant" });

    expect((await powersOf(member, db)).size).toBe(0);
  });
});

describe("grantPower", () => {
  it("records the member, the power and who granted it", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);

    const result = await grantPower(
      { userId: member, power: "games.manage", grantedByUserId: granter },
      db
    );

    expect(result).toEqual({ created: true });
    const rows = await rowsFor(member);
    expect(rows.map((row) => [row.userId, row.power, row.grantedByUserId])).toEqual([
      [member, "games.manage", granter],
    ]);
    expect(rows[0].grantedAt).toBeInstanceOf(Date);
  });

  it("refuses a power that is not in the vocabulary, names it, and stores nothing", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);

    await expect(
      grantPower({ userId: member, power: "permissions.grant", grantedByUserId: granter }, db)
    ).rejects.toThrow(/"permissions\.grant"/);

    expect(await rowsFor(member)).toEqual([]);
  });

  /*
   * The first grant is backdated by hand, so "did not move" is a comparison
   * against a fixed instant rather than against two `now()`s a few
   * microseconds apart. The second grant comes from somebody else, so a
   * rewrite of the row would show in who granted it as well.
   */
  it("leaves one row, its time and its granter alone when the same power is granted twice", async () => {
    const first = await makeUser(db);
    const second = await makeUser(db);
    const member = await makeUser(db);
    const then = new Date("2020-01-01T12:00:00Z");
    await grantPower({ userId: member, power: "templates.manage", grantedByUserId: first }, db);
    await db.update(userPermissions).set({ grantedAt: then }).where(eq(userPermissions.userId, member));

    const again = await grantPower(
      { userId: member, power: "templates.manage", grantedByUserId: second },
      db
    );

    expect(again).toEqual({ created: false });
    expect(await rowsFor(member)).toEqual([
      { userId: member, power: "templates.manage", grantedByUserId: first, grantedAt: then },
    ]);
  });
});

describe("a grant and the people on it", () => {
  it("goes when the member goes", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);
    await grantPower({ userId: member, power: "members.read", grantedByUserId: granter }, db);

    await db.delete(users).where(eq(users.id, member));

    expect(await rowsFor(member)).toEqual([]);
  });

  it("stays, with nobody named, when whoever granted it goes", async () => {
    const granter = await makeUser(db);
    const member = await makeUser(db);
    await grantPower({ userId: member, power: "members.read", grantedByUserId: granter }, db);

    await db.delete(users).where(eq(users.id, granter));

    expect((await rowsFor(member)).map((row) => [row.power, row.grantedByUserId])).toEqual([
      ["members.read", null],
    ]);
  });
});
