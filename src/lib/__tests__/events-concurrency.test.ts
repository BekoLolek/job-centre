import { and, asc, eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { type Database, applications, eventTemplates, events } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  expectRejection,
  freshDatabase,
  makeUser,
} from "@/db/__tests__/helpers";
import { createTemplate, duplicateTemplate } from "@/lib/admin-templates";
import { MIN_CAPACITY } from "@/lib/events-policy";
import { applyToEvent, createEvent, publishEvent } from "@/lib/events";

/**
 * Two writes that both decided the same thing was free.
 *
 * "Read, decide, insert" reads fine and is wrong: between the read and the
 * insert, somebody else can take the thing you just decided was free. Two of
 * them live here — the last seat in an event, and a template's name — because
 * they are one shape with two different closing moves, and the argument below
 * about forcing the race is the same argument for both.
 *
 * `applyToEvent` closes its window by doing both halves inside one transaction
 * that holds a row lock on the event. `createTemplate` cannot: there is no row
 * to lock, because the conflict is between two rows that do not exist yet. Its
 * closing move is a unique index (`event_templates_name_uniq`,
 * drizzle/0028) whose rejection is turned back into the sentence the read
 * produces.
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
 *
 * ## And why the name race needs a second kind of proof on top of that
 *
 * The seat race can be read off the *outcome*: two acceptances means the lock
 * is missing. The name race cannot, and this is the trap. If the two creates
 * happened to run in sequence, the second one's `nameTaken` would find the
 * first one's row and refuse it — the same refusal, the same sentence, for
 * entirely the wrong reason. A test reading only the outcome would stay green
 * with the index dropped.
 *
 * So the name tests prove the *source* of the refusal rather than its text, in
 * the two ways that are available without a second connection:
 *
 *  * the statements, with `logging()` — both calls reach an `insert into
 *    "event_templates"`, which a call refused by the read never would. That is
 *    the `logging()` shape `format-db.test.ts` and `archive-lock.test.ts` use
 *    for lock ordering, asked here about which half did the refusing.
 *  * the database itself, asked directly — a raw insert that no application
 *    code has seen is rejected by name.
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

/**
 * A published event with its last seat free, and somebody already in the other
 * one.
 *
 * R-26 puts the smallest cap at two seats (`MIN_CAPACITY`), so "two people race
 * for the last seat" is a two-seat event with one taken rather than a one-seat
 * event with none. The race is the same one — a single seat, read and written
 * by two calls at once — with a bystander in the room, so `statuses` below
 * carries one extra `accepted` that belongs to nobody in the test.
 */
async function lastSeatEvent(title: string): Promise<string> {
  const eventId = await seatedEvent(title, MIN_CAPACITY);
  const result = await applyToEvent(eventId, await makeUser(db), {}, db);
  if (!result.ok) throw new Error(result.error);
  return eventId;
}

/** A published event with `capacity` seats and nothing else in the way. */
async function seatedEvent(title: string, capacity: number | null): Promise<string> {
  const created = await createEvent({ ...PUBLISHABLE, title, capacity }, db);
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
    const eventId = await lastSeatEvent("Naive control");
    const [a, b] = await Promise.all([makeUser(db), makeUser(db)]);

    await Promise.all([naiveApply(eventId, a), naiveApply(eventId, b)]);

    // Both counted one seat taken of two before either inserted, so both took
    // the last one. If these calls had run in sequence this would be
    // ["accepted", "accepted", "waitlisted"] — two seats filled and the third
    // applicant queued — and the tests below would prove nothing at all.
    expect(await statuses(eventId)).toEqual(["accepted", "accepted", "accepted"]);
  });
});

describe("applyToEvent under concurrency", () => {
  it("gives the last seat to exactly one of two simultaneous applicants", async () => {
    const eventId = await lastSeatEvent("One seat, two people");
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

    // Plus the bystander's seat, which was taken before the race began.
    expect(await statuses(eventId)).toEqual(["accepted", "accepted", "waitlisted"]);
  });

  it("leaves the loser at the front of the queue rather than nowhere", async () => {
    const eventId = await lastSeatEvent("Queue after the race");
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

/* ------------------------------------------------------------------ */
/* One template name, wanted by two admins (R-125 / UC-28 4a)         */
/* ------------------------------------------------------------------ */

/**
 * This file's database again, over the same PGlite client, with every statement
 * pushed onto `log` in the order it was issued.
 *
 * drizzle's own `logger` hook rather than a proxy over the query builders, for
 * the reason `format-db.test.ts` gives where this helper comes from: the hook
 * fires from the prepared query, so it sees statements issued inside a
 * transaction too. Here it answers a question the outcome cannot — *which half
 * refused*, the read in front of the index or the index itself.
 */
function logging(log: string[]): Database {
  return drizzlePglite(harness.client, {
    schema,
    logger: { logQuery: (query) => log.push(query) },
  });
}

/** How many statements in `log` are inserts into `event_templates`. */
function templateInserts(log: readonly string[]): number {
  return log.filter((query) => /insert\s+into\s+"event_templates"/i.test(query)).length;
}

async function templateNames(): Promise<string[]> {
  const rows = await db
    .select({ name: eventTemplates.name })
    .from(eventTemplates)
    .orderBy(asc(eventTemplates.name));
  return rows.map((row) => row.name);
}

describe("createTemplate under concurrency", () => {
  beforeEach(async () => {
    await db.delete(eventTemplates);
  });

  it("gives one name to exactly one of two simultaneous creates", async () => {
    const log: string[] = [];
    const handle = logging(log);

    const results = await Promise.all([
      createTemplate({ name: "Rivals cup" }, handle),
      createTemplate({ name: "Rivals cup" }, handle),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await templateNames()).toEqual(["Rivals cup"]);

    /*
     * The refusal is 4a's sentence and not a database error — the second
     * criterion, and the whole reason `insertTemplate` catches by index name
     * rather than letting drizzle's "Failed query" out.
     */
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.error).toMatch(
      /A template is already called "Rivals cup"\. Pick another name\./
    );

    /*
     * And the proof that this is the *index* refusing rather than the read.
     *
     * Both calls got as far as issuing an insert, which is only possible if
     * both of their `nameTaken` reads found the name free — the interleave was
     * real. A second call that had been refused by its read would have returned
     * before any insert, and this count would be 1. Drop the unique index and
     * this test still sees two inserts, but `templateNames()` above comes back
     * with two rows and the suite fails there; keep the index and remove the
     * catch, and the refusal is a Postgres error and the assertion above
     * fails. The two assertions together have no green state in which the rule
     * is missing.
     */
    expect(templateInserts(log)).toBe(2);
  });

  it("is the database refusing, asked without any application code at all", async () => {
    // The other half of the proof: no read, no fold in TypeScript, nothing but
    // a row and an index. Also the only place the fold's *reach* is pinned —
    // case, collapsed runs, tabs and padding are all one name (UC-28 4a).
    await db.insert(eventTemplates).values({ name: "Rivals cup" });

    for (const name of ["Rivals cup", "RIVALS CUP", "Rivals  cup", "Rivals\tcup", "  Rivals cup  "]) {
      await expectRejection(
        () => db.insert(eventTemplates).values({ name }),
        /event_templates_name_uniq/
      );
    }

    expect(await templateNames()).toEqual(["Rivals cup"]);
  });

  it("refuses a rename onto a name that was free when it was read", async () => {
    // A rename is a typed name too, so the index has to answer it with the same
    // sentence. Both templates read the other's name as not-yet-"Final", both
    // decide they may take it, and one of them writes second.
    const [left, right] = await Promise.all([
      createTemplate({ name: "Left" }, db),
      createTemplate({ name: "Right" }, db),
    ]);
    if (!left.ok || !right.ok) throw new Error("setup failed");

    const { updateTemplate } = await import("@/lib/admin-templates");
    const results = await Promise.all([
      updateTemplate(left.data.id, { name: "Final" }, db),
      updateTemplate(right.data.id, { name: "Final" }, db),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.error).toMatch(/already called "Final"/);
    // And the loser kept its old name rather than being half-renamed.
    expect(await templateNames()).toEqual(expect.arrayContaining(["Final"]));
    expect((await templateNames()).filter((name) => name === "Final")).toHaveLength(1);
  });

  it("folds a stored name the same way the index does, so the read still refuses first", async () => {
    /*
     * The fifth criterion: `cleanTemplateName`'s space-collapsing and the index
     * have to agree on what "the same name" means. The index folds whitespace,
     * so `takenNames` must too — and the row that can tell them apart is one
     * written *without* going through `cleanTemplateName`, which is what the
     * raw insert below is. A seed, an older migration, or any write from before
     * the collapsing existed leaves exactly this shape.
     *
     * Asserted on the statements rather than on the sentence, because the
     * sentence is identical either way — that is the whole trap. If
     * `takenNames` folded case alone it would find "Rivals cup" free, issue an
     * insert, and the index would refuse it; `insertTemplate` would catch that
     * and return the same words. Only the insert count says which half
     * refused, and UC-28 4a wants the read to, so an admin is told before the
     * database has to object.
     */
    await db.insert(eventTemplates).values({ name: "Rivals  cup" });

    const log: string[] = [];
    const result = await createTemplate({ name: "Rivals cup" }, logging(log));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already called "Rivals cup"/);
    expect(templateInserts(log)).toBe(0);
    // The legacy row is untouched — nothing here rewrites a name nobody asked
    // to change.
    expect(await templateNames()).toEqual(["Rivals  cup"]);
  });

  it("suffixes rather than fails when the name was the system's own choice", async () => {
    /*
     * The third criterion. `duplicateTemplate`'s "… copy" is nobody's typed
     * name, so a lost race is not something to tell an admin about — it is
     * something to round again on. Both calls read every name, both find
     * "Source copy" free, both offer it; the loser's catch sends it back
     * through `freeName`, which now sees the winner's row and picks "Source
     * copy 2".
     */
    const source = await createTemplate({ name: "Source" }, db);
    if (!source.ok) throw new Error("setup failed");

    const results = await Promise.all([
      duplicateTemplate(source.data.id, undefined, db),
      duplicateTemplate(source.data.id, undefined, db),
    ]);

    // Both succeeded — that is the criterion. Neither admin is told their
    // click failed because the other one happened at the same moment.
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await templateNames()).toEqual(["Source", "Source copy", "Source copy 2"]);
  });
});
