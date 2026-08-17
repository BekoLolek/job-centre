import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, applications, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { applyToEvent, createEvent, publishEvent } from "@/lib/events";

/**
 * The last seat, wanted by two people at once.
 *
 * "Count the accepted, then insert" reads fine and is wrong: between the count
 * and the insert, somebody else can take the seat you just decided was free.
 * `applyToEvent` closes the window by doing both inside one transaction that
 * holds a row lock on the event.
 *
 * ## How this test forces the race rather than pretending to
 *
 * PGlite is a single connection, so two overlapping calls interleave at the
 * *statement* level: `Promise.all` starts application A, and while A is
 * awaiting its first query, B's first query is issued. What PGlite does not
 * interleave is transactions — `client.transaction()` holds an exclusive lock
 * for the whole callback, exactly as a second Postgres connection would block
 * on `select … for update`.
 *
 * That combination is what makes the assertion meaningful, but only if the
 * overlap is real. So the first test here is a **control**: the same two calls,
 * through a deliberately naive read-then-write that has no transaction. If the
 * harness were quietly running them in sequence, the control would produce one
 * acceptance and this file would fail rather than pass for the wrong reason.
 * It produces two — the bug, reproduced on demand — and the real function,
 * given the identical harness, produces one.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

/** A published event with `capacity` seats and nothing else in the way. */
async function seatedEvent(title: string, capacity: number | null): Promise<string> {
  const created = await createEvent({ title, capacity }, db);
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);
  return created.data.id;
}

async function statuses(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ status: applications.status })
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .orderBy(asc(applications.status));
  return rows.map((row) => row.status);
}

/**
 * The version everybody writes first: count, decide, insert. No transaction,
 * no lock. Kept here as the control that proves the harness interleaves.
 */
async function naiveApply(eventId: string, userId: string): Promise<void> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  const taken = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")));

  const room = event.capacity === null || taken.length < event.capacity;
  await db.insert(applications).values({
    eventId,
    userId,
    status: room ? "accepted" : "waitlisted",
    waitlistPosition: room ? null : taken.length,
    submittedAt: new Date(),
  });
}

describe("the control — proving the race is really being run", () => {
  it("double-books the last seat when the read and the write are not one transaction", async () => {
    const eventId = await seatedEvent("Naive control", 1);
    const [a, b] = await Promise.all([makeUser(db), makeUser(db)]);

    await Promise.all([naiveApply(eventId, a), naiveApply(eventId, b)]);

    // Both counted zero before either inserted. If these calls had run in
    // sequence this would be ["accepted", "waitlisted"], and the tests below
    // would prove nothing at all.
    expect(await statuses(eventId)).toEqual(["accepted", "accepted"]);
  });
});

describe("applyToEvent under concurrency", () => {
  it("gives the last seat to exactly one of two simultaneous applicants", async () => {
    const eventId = await seatedEvent("One seat, two people", 1);
    const [a, b] = await Promise.all([makeUser(db), makeUser(db)]);

    const results = await Promise.all([
      applyToEvent(eventId, a, {}, db),
      applyToEvent(eventId, b, {}, db),
    ]);

    // Both applications succeed — being waitlisted is a success, not an error.
    expect(results.every((result) => result.ok)).toBe(true);

    const decided = results.flatMap((result) => (result.ok ? [result.data.status] : []));
    expect(decided.filter((status) => status === "accepted")).toHaveLength(1);
    expect(decided.filter((status) => status === "waitlisted")).toHaveLength(1);

    expect(await statuses(eventId)).toEqual(["accepted", "waitlisted"]);
  });

  it("leaves the loser at the front of the queue rather than nowhere", async () => {
    const eventId = await seatedEvent("Queue after the race", 1);
    const [a, b] = await Promise.all([makeUser(db), makeUser(db)]);

    await Promise.all([applyToEvent(eventId, a, {}, db), applyToEvent(eventId, b, {}, db)]);

    const [queued] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.eventId, eventId), eq(applications.status, "waitlisted")));
    expect(queued.waitlistPosition).toBe(1);
  });

  it("fills exactly the seats it has when five people arrive at once", async () => {
    const eventId = await seatedEvent("Two seats, five people", 2);
    const members = await Promise.all([
      makeUser(db),
      makeUser(db),
      makeUser(db),
      makeUser(db),
      makeUser(db),
    ]);

    const results = await Promise.all(
      members.map((userId) => applyToEvent(eventId, userId, {}, db))
    );
    expect(results.every((result) => result.ok)).toBe(true);

    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.eventId, eventId));

    expect(rows.filter((row) => row.status === "accepted")).toHaveLength(2);

    // The three who missed out hold 1, 2, 3 — contiguous, no duplicates. The
    // partial unique index would have refused a duplicate outright, so this is
    // really checking that nobody was left without a place at all.
    const queue = rows
      .filter((row) => row.status === "waitlisted")
      .map((row) => row.waitlistPosition)
      .sort((first, second) => (first ?? 0) - (second ?? 0));
    expect(queue).toEqual([1, 2, 3]);
  });

  it("accepts everybody when the event is uncapped, however many arrive together", async () => {
    const eventId = await seatedEvent("Uncapped", null);
    const members = await Promise.all([makeUser(db), makeUser(db), makeUser(db)]);

    await Promise.all(members.map((userId) => applyToEvent(eventId, userId, {}, db)));

    expect(await statuses(eventId)).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("still refuses a second application from the same member under a race", async () => {
    const eventId = await seatedEvent("Double click", 5);
    const userId = await makeUser(db);

    const results = await Promise.all([
      applyToEvent(eventId, userId, {}, db),
      applyToEvent(eventId, userId, {}, db),
    ]);

    // One goes in; the other is told, rather than tripping the unique index or
    // quietly creating a second row.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.error).toMatch(/already applied/i);
    expect(await statuses(eventId)).toEqual(["accepted"]);
  });
});
