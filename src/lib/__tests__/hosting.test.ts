import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, hostApplications } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { createEvent } from "@/lib/events";
import {
  addHost,
  applyToHost,
  approveHostApplication,
  canManageEvent,
  declineHostApplication,
  eventsHostedBy,
  getHostApplication,
  hostsOf,
  listHostApplications,
  myHostApplications,
  removeHost,
  withdrawHostApplication,
} from "@/lib/hosting";

/**
 * Applying to host, and the permission it grants.
 *
 * `canManageEvent` is the only thing standing between "a member" and "an
 * editor for somebody else's event", so most of what is here is that one
 * function answered from every direction.
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

let counter = 0;
async function anEvent(): Promise<string> {
  counter += 1;
  const created = await createEvent({ title: `Hosted fixture ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

const APPLICATION = {
  title: "Friday REPO night",
  gameName: "REPO",
  summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
  playerInfoNeeded: "Their in-game name, and whether they own the DLC.",
};

/* ------------------------------------------------------------------ */
/* The permission                                                     */
/* ------------------------------------------------------------------ */

describe("canManageEvent", () => {
  it("lets an admin manage any event", async () => {
    const eventId = await anEvent();
    const admin = { id: await makeUser(db), isAdmin: true };
    expect(await canManageEvent(admin, eventId, db)).toBe(true);
  });

  it("refuses an ordinary member", async () => {
    const eventId = await anEvent();
    const member = { id: await makeUser(db), isAdmin: false };
    expect(await canManageEvent(member, eventId, db)).toBe(false);
  });

  it("refuses nobody at all", async () => {
    expect(await canManageEvent(null, await anEvent(), db)).toBe(false);
  });

  it("lets a host manage the event they were given", async () => {
    const eventId = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await addHost(eventId, host.id, null, db);
    expect(await canManageEvent(host, eventId, db)).toBe(true);
  });

  it("does NOT let a host manage anybody else's event", async () => {
    // The whole boundary. A host is trusted with one evening, not with the site.
    const mine = await anEvent();
    const theirs = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await addHost(mine, host.id, null, db);

    expect(await canManageEvent(host, mine, db)).toBe(true);
    expect(await canManageEvent(host, theirs, db)).toBe(false);
  });

  it("stops letting them once the grant is taken away", async () => {
    const eventId = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await addHost(eventId, host.id, null, db);
    await removeHost(eventId, host.id, db);
    expect(await canManageEvent(host, eventId, db)).toBe(false);
  });

  it("is idempotent, so granting twice is not two grants", async () => {
    const eventId = await anEvent();
    const host = await makeUser(db);
    await addHost(eventId, host, null, db);
    await addHost(eventId, host, null, db);
    expect(await hostsOf(eventId, db)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Applying                                                           */
/* ------------------------------------------------------------------ */

describe("applying", () => {
  it("keeps what the admin needs to set the event up", async () => {
    const userId = await makeUser(db, { displayName: "Ada" });
    const { id } = unwrap(await applyToHost(userId, APPLICATION, db));

    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("pending");
    expect(application?.gameName).toBe("REPO");
    expect(application?.playerInfoNeeded).toMatch(/in-game name/);
    expect(application?.by?.name).toBe("Ada");
  });

  it("insists on the two things approving it depends on", async () => {
    const userId = await makeUser(db);
    // No game: the admin cannot attach one.
    expect((await applyToHost(userId, { ...APPLICATION, gameName: "" }, db)).ok).toBe(false);
    // No player info: the admin cannot write the questions.
    expect(
      (await applyToHost(userId, { ...APPLICATION, playerInfoNeeded: "" }, db)).ok
    ).toBe(false);
    // A summary that says nothing.
    expect((await applyToHost(userId, { ...APPLICATION, summary: "pls" }, db)).ok).toBe(false);
  });

  it("allows one pending application at a time", async () => {
    const userId = await makeUser(db);
    unwrap(await applyToHost(userId, APPLICATION, db));

    const second = await applyToHost(userId, { ...APPLICATION, title: "Another idea" }, db);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toMatch(/already have an application/);
  });

  it("frees them up again once they withdraw", async () => {
    const userId = await makeUser(db);
    const { id } = unwrap(await applyToHost(userId, APPLICATION, db));
    await withdrawHostApplication(id, db);

    expect((await applyToHost(userId, APPLICATION, db)).ok).toBe(true);
    expect((await getHostApplication(id, db))?.status).toBe("withdrawn");
  });

  it("shows a person only their own", async () => {
    const mine = await makeUser(db);
    const theirs = await makeUser(db);
    unwrap(await applyToHost(mine, APPLICATION, db));
    unwrap(await applyToHost(theirs, APPLICATION, db));

    const list = await myHostApplications(mine, db);
    expect(list).toHaveLength(1);
    expect(list[0].by?.id).toBe(mine);
  });
});

/* ------------------------------------------------------------------ */
/* Deciding                                                           */
/* ------------------------------------------------------------------ */

describe("approving", () => {
  it("makes them the host of the event, in one go", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));
    const eventId = await anEvent();

    unwrap(await approveHostApplication(id, admin, { eventId }, db));

    expect(await canManageEvent({ id: applicant, isAdmin: false }, eventId, db)).toBe(true);
    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("approved");
    expect(application?.eventId).toBe(eventId);
    expect(await eventsHostedBy(applicant, db)).toHaveLength(1);
  });

  it("refuses to decide the same application twice", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    unwrap(await approveHostApplication(id, admin, { eventId: await anEvent() }, db));
    const again = await approveHostApplication(id, admin, { eventId: await anEvent() }, db);

    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already been decided/);
  });

  it("does not grant anything on a decline, and says why", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));
    const eventId = await anEvent();

    await declineHostApplication(id, admin, "Clashes with the tournament", db);

    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("declined");
    expect(application?.decisionNote).toBe("Clashes with the tournament");
    expect(application?.eventId).toBeNull();
    expect(await canManageEvent({ id: applicant, isAdmin: false }, eventId, db)).toBe(false);
  });

  it("leaves the queue with the undecided ones on top", async () => {
    const settled = await makeUser(db);
    const waiting = await makeUser(db);

    const first = unwrap(await applyToHost(settled, APPLICATION, db));
    await db
      .update(hostApplications)
      .set({ status: "declined" })
      .where(eq(hostApplications.id, first.id));
    const second = unwrap(
      await applyToHost(waiting, { ...APPLICATION, title: "Still waiting" }, db)
    );

    // Relative order against the shared database — see the note in
    // `suggestions.test.ts` for why not a fresh one per test.
    const queue = await listHostApplications(db);
    const at = (id: string) => queue.findIndex((row) => row.id === id);
    expect(at(second.id)).toBeLessThan(at(first.id));
    expect(queue[0].status).toBe("pending");
  });
});
