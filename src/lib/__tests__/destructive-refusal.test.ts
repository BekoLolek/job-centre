import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, events } from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import { AUDIT_ACTIONS, type AuditAction, actionTone, isDestructive } from "@/lib/audit";
import { DESTRUCTIVE_REFUSAL, destructiveRefusal, grantPower } from "@/lib/permissions";
import { POWERS } from "@/lib/permissions-policy";

/**
 * The `destructive` modifier, asked directly (R-267 / UC-57), against a real
 * Postgres.
 *
 * `destructiveRefusal` is what every action that writes a line under a
 * destructive key asks after its own guard. These are its four answers - a
 * holder without the modifier, one with it, an admin, a host - and the claim
 * that it has no list of its own: over the **whole** vocabulary it refuses
 * exactly what `audit.ts` marks, so an entry added to or taken from that set
 * is an entry added to or taken from this.
 */

let handle: TestDatabase;
let db: Database;
let granter: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  granter = await makeUser(db, { displayName: "The admin who granted" });
});

afterAll(async () => {
  await handle.close();
});

/** A member holding exactly these, and not an admin. */
async function holding(...powers: string[]) {
  const id = await makeUser(db);
  for (const power of powers) await grantPower({ userId: id, power, grantedByUserId: granter }, db);
  return { id, isAdmin: false };
}

async function anEvent(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `destructive-${counter}`, title: `Destructive ${counter}` })
    .returning({ id: events.id });
  return row.id;
}

const EVERY_ACTION = Object.keys(AUDIT_ACTIONS) as AuditAction[];
const MARKED = EVERY_ACTION.filter(isDestructive);
const UNMARKED = EVERY_ACTION.filter((action) => !isDestructive(action));

describe("the set in audit.ts is the only thing that decides", () => {
  it("marks something, and leaves something unmarked", () => {
    // Both halves below are vacuous if either list is empty.
    expect(MARKED.length).toBeGreaterThan(0);
    expect(UNMARKED.length).toBeGreaterThan(0);
  });

  it.each(MARKED)("refuses %s to a holder of every power but destructive", async (action) => {
    const holder = await holding(...POWERS.filter((power) => power !== "destructive"));

    expect(await destructiveRefusal(holder, action, null, db)).toBe(DESTRUCTIVE_REFUSAL);
  });

  it.each(UNMARKED)("does not refuse %s to a member holding nothing", async (action) => {
    // Nothing: this function is the modifier and not the area's guard, so for
    // an action outside the set it has no opinion about anybody.
    const member = await holding();

    expect(await destructiveRefusal(member, action, null, db)).toBeNull();
  });

  it.each(MARKED)("refuses only what the log shows as taken away: %s", (action) => {
    expect(actionTone(action)).toBe("flare");
  });
});

describe("who the modifier lets through a marked action", () => {
  it("lets through a holder who has destructive", async () => {
    const holder = await holding("polls.manage", "destructive");

    expect(await destructiveRefusal(holder, "poll.deleted", null, db)).toBeNull();
  });

  it("lets an admin through, with nothing stored for them", async () => {
    const admin = { id: await makeUser(db), isAdmin: true };

    expect(await destructiveRefusal(admin, "poll.deleted", null, db)).toBeNull();
  });

  it("lets a host through on the event they host, holding no power at all", async () => {
    const eventId = await anEvent();
    const host = await holding();
    await makeHost(db, eventId, host.id);

    expect(await destructiveRefusal(host, "result.cleared", eventId, db)).toBeNull();
  });

  it("refuses a host on an event that is somebody else's", async () => {
    const [mine, theirs] = [await anEvent(), await anEvent()];
    const host = await holding("events.manage");
    await makeHost(db, mine, host.id);

    expect(await destructiveRefusal(host, "result.cleared", theirs, db)).toBe(DESTRUCTIVE_REFUSAL);
  });

  it("refuses a host when the action is not on an event at all", async () => {
    const host = await holding("polls.manage");
    await makeHost(db, await anEvent(), host.id);

    expect(await destructiveRefusal(host, "poll.deleted", null, db)).toBe(DESTRUCTIVE_REFUSAL);
  });

  it("refuses somebody else on an event that has a host", async () => {
    const eventId = await anEvent();
    await makeHost(db, eventId, (await holding()).id);
    const holder = await holding("events.manage");

    expect(await destructiveRefusal(holder, "result.cleared", eventId, db)).toBe(
      DESTRUCTIVE_REFUSAL
    );
  });
});

describe("the refusal", () => {
  it("names the power that is missing", () => {
    expect(DESTRUCTIVE_REFUSAL).toContain("“destructive”");
  });
});
