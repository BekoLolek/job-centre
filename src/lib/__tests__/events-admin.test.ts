import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  applications,
  availability,
  eventDays,
  games,
  profileFields,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type EventResult,
  MAX_EVENT_DAYS,
  applyToEvent,
  countApplicationsByStatus,
  createEvent,
  emptyApplicationCounts,
  getApplicationsForEvent,
  previewEventDays,
  publishEvent,
  setApplicationNote,
  setApplicationStatus,
  setAvailability,
  setEventDays,
} from "@/lib/events";

/**
 * The three reads and writes `/admin/events` added to the events layer.
 *
 * Against PGlite rather than a mock, for the reason the rest of this directory
 * gives: what is interesting is cascade deletes (availability hanging off a
 * day), a partial unique index over the waitlist, and grouped counts — and a
 * fake would not get any of those wrong in the same way Postgres does.
 */

let harness: TestDatabase;
let db: Database;
let rivalsId: string;

const NOW = new Date("2026-05-01T18:00:00Z");
const hours = (count: number) => new Date(NOW.getTime() + count * 3_600_000);
const days = (count: number) => new Date(NOW.getTime() + count * 86_400_000);

let titleCounter = 0;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;

  const [game] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = game.id;

  await db
    .insert(profileFields)
    .values({ gameId: rivalsId, key: "rank", label: "Rank", type: "rank", sort: 0 });
});

afterAll(async () => {
  await harness.close();
});

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got: ${result.error} ${JSON.stringify(result.errors ?? {})}`);
  }
  return result.data;
}

function expectFail<T>(result: EventResult<T>): { error: string } {
  if (result.ok) throw new Error("Expected a failure, got success.");
  return result;
}

/** A published, capacity-`seats` event with `dayCount` days, ready to apply to. */
async function makeEvent(
  options: { seats?: number | null; dayCount?: number; publish?: boolean } = {}
) {
  titleCounter += 1;
  const event = expectOk(
    await createEvent(
      {
        title: `Preview subject ${titleCounter}`,
        gameId: rivalsId,
        capacity: options.seats === undefined ? 4 : options.seats,
        startsAt: days(30),
      },
      db
    )
  );

  const dayCount = options.dayCount ?? 0;
  if (dayCount > 0) {
    expectOk(
      await setEventDays(
        event.id,
        Array.from({ length: dayCount }, (_, index) => ({
          startsAt: days(30 + index),
          label: `Day ${index + 1}`,
        })),
        db
      )
    );
  }

  if (options.publish !== false) expectOk(await publishEvent(event.id, db));
  return event;
}

async function dayIds(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ id: eventDays.id })
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId))
    .orderBy(asc(eventDays.dayIndex));
  return rows.map((row) => row.id);
}

/* ================================================================== */
/* previewEventDays                                                   */
/* ================================================================== */

describe("previewEventDays", () => {
  it("reports nothing for an event that has no days", async () => {
    const event = await makeEvent();

    expect(await previewEventDays(event.id, [], db)).toEqual({
      removed: [],
      clearedAvailability: 0,
      affectedApplicants: 0,
      moved: [],
      problem: null,
    });
  });

  it("costs nothing to keep every day, and names the ones that move", async () => {
    const event = await makeEvent({ dayCount: 3 });
    const [first, second, third] = await dayIds(event.id);

    const impact = await previewEventDays(
      event.id,
      [{ id: third }, { id: first }, { id: second }],
      db
    );

    expect(impact.problem).toBeNull();
    expect(impact.removed).toEqual([]);
    expect(impact.clearedAvailability).toBe(0);
    // Every one of them lands somewhere new, and none of it costs an answer.
    expect(impact.moved).toEqual([
      { id: third, from: 2, to: 0 },
      { id: first, from: 0, to: 1 },
      { id: second, from: 1, to: 2 },
    ]);
  });

  it("counts the availability answers a delete would clear, without clearing them", async () => {
    const event = await makeEvent({ dayCount: 3, seats: 10 });
    const [first, second, third] = await dayIds(event.id);

    // Two applicants answer all three days; a third answers only day one.
    const members = await Promise.all([makeUser(db), makeUser(db), makeUser(db)]);
    for (const [index, userId] of members.entries()) {
      const application = expectOk(
        await applyToEvent(
          event.id,
          userId,
          {
            now: hours(index),
            availability:
              index < 2
                ? { [first]: "yes", [second]: "maybe", [third]: "no" }
                : { [first]: "yes" },
          },
          db
        )
      );
      expect(Object.keys(application.availability).length).toBe(index < 2 ? 3 : 1);
    }

    const impact = await previewEventDays(event.id, [{ id: first }], db);

    expect(impact.problem).toBeNull();
    expect(impact.removed.map((day) => day.label)).toEqual(["Day 2", "Day 3"]);
    // Two applicants × two doomed days.
    expect(impact.clearedAvailability).toBe(4);
    expect(impact.affectedApplicants).toBe(2);

    // Nothing was written: the days and every answer are still there.
    expect(await dayIds(event.id)).toEqual([first, second, third]);
    const stored = await db
      .select()
      .from(availability)
      .where(eq(availability.eventDayId, second));
    expect(stored.length).toBe(2);
  });

  it("predicts exactly what setEventDays then reports", async () => {
    const event = await makeEvent({ dayCount: 2, seats: 10 });
    const [first, second] = await dayIds(event.id);

    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, availability: { [first]: "yes", [second]: "no" } },
        db
      )
    );

    const impact = await previewEventDays(event.id, [{ id: first }], db);
    const written = expectOk(await setEventDays(event.id, [{ id: first }], db));

    expect(impact.clearedAvailability).toBe(1);
    expect(written.clearedAvailability).toBe(impact.clearedAvailability);
    expect(written.days.map((day) => day.id)).toEqual([first]);
  });

  it("reports the same refusals setEventDays would, and writes nothing", async () => {
    const event = await makeEvent({ dayCount: 1 });
    const other = await makeEvent({ dayCount: 1 });
    const [strayDay] = await dayIds(other.id);

    const tooMany = await previewEventDays(
      event.id,
      Array.from({ length: MAX_EVENT_DAYS + 1 }, () => ({ startsAt: null, label: null })),
      db
    );
    expect(tooMany.problem).toMatch(new RegExp(`${MAX_EVENT_DAYS} days`));
    expect(expectFail(await setEventDays(event.id, tooManyDays(), db)).error).toBe(
      tooMany.problem
    );

    const stray = await previewEventDays(event.id, [{ id: strayDay }], db);
    expect(stray.problem).toMatch(/different event/i);
    expect(expectFail(await setEventDays(event.id, [{ id: strayDay }], db)).error).toBe(
      stray.problem
    );

    // The event still has the day it started with.
    expect((await dayIds(event.id)).length).toBe(1);
  });

  it("says so when the event is gone rather than throwing", async () => {
    const impact = await previewEventDays(
      "00000000-0000-0000-0000-000000000000",
      [],
      db
    );
    expect(impact.problem).toMatch(/no longer exists/i);
  });
});

function tooManyDays() {
  return Array.from({ length: MAX_EVENT_DAYS + 1 }, () => ({
    startsAt: null,
    label: null,
  }));
}

/* ================================================================== */
/* setApplicationNote                                                 */
/* ================================================================== */

describe("setApplicationNote", () => {
  it("writes, trims and clears the note", async () => {
    const event = await makeEvent({ seats: 5 });
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expect(expectOk(await setApplicationNote(application.id, "  said he might be late  ", db)).note).toBe(
      "said he might be late"
    );
    expect(expectOk(await setApplicationNote(application.id, "   ", db)).note).toBeNull();
    expect(expectOk(await setApplicationNote(application.id, null, db)).note).toBeNull();
  });

  it("leaves a waitlisted applicant exactly where they were in the queue", async () => {
    const event = await makeEvent({ seats: 1 });

    // One seat, four applicants: one in, three queueing 1-2-3.
    const members = await Promise.all([
      makeUser(db),
      makeUser(db),
      makeUser(db),
      makeUser(db),
    ]);
    for (const [index, userId] of members.entries()) {
      expectOk(await applyToEvent(event.id, userId, { now: hours(index) }, db));
    }

    const queue = async () =>
      (await getApplicationsForEvent(event.id, db))
        .filter((row) => row.status === "waitlisted")
        .map((row) => [row.userId, row.waitlistPosition] as const);

    expect(await queue()).toEqual([
      [members[1], 1],
      [members[2], 2],
      [members[3], 3],
    ]);

    const front = (await getApplicationsForEvent(event.id, db)).find(
      (row) => row.userId === members[1]
    );
    expectOk(await setApplicationNote(front!.id, "asked to be kept informed", db));

    // The note landed and nobody moved.
    expect(await queue()).toEqual([
      [members[1], 1],
      [members[2], 2],
      [members[3], 3],
    ]);
    const after = (await getApplicationsForEvent(event.id, db)).find(
      (row) => row.userId === members[1]
    );
    expect(after?.note).toBe("asked to be kept informed");
  });

  it("is not the same as re-affirming the status, which does move them", async () => {
    // The reason `setApplicationNote` exists. `setApplicationStatus` recomputes
    // `waitlistPosition` from the back of the queue, so re-saving "waitlisted"
    // on the person at the front costs them their place. Pinned here so the
    // day somebody merges the two functions, this fails loudly.
    const event = await makeEvent({ seats: 1 });
    const members = await Promise.all([makeUser(db), makeUser(db), makeUser(db)]);
    for (const [index, userId] of members.entries()) {
      expectOk(await applyToEvent(event.id, userId, { now: hours(index) }, db));
    }

    const front = (await getApplicationsForEvent(event.id, db)).find(
      (row) => row.userId === members[1]
    );
    expectOk(
      await setApplicationStatus(front!.id, "waitlisted", { note: "hello" }, db)
    );

    const queue = (await getApplicationsForEvent(event.id, db))
      .filter((row) => row.status === "waitlisted")
      .map((row) => row.userId);
    expect(queue).toEqual([members[2], members[1]]);
  });

  it("says so when the application is gone", async () => {
    expect(
      expectFail(
        await setApplicationNote("00000000-0000-0000-0000-000000000000", "hi", db)
      ).error
    ).toMatch(/no longer exists/i);
  });
});

/* ================================================================== */
/* countApplicationsByStatus                                          */
/* ================================================================== */

describe("countApplicationsByStatus", () => {
  it("returns an empty map for an empty list without touching the database", async () => {
    expect(await countApplicationsByStatus([], db)).toEqual(new Map());
  });

  it("counts every status per event, including the ones that came to nothing", async () => {
    const busy = await makeEvent({ seats: 2 });
    const quiet = await makeEvent({ seats: 5 });

    const members = await Promise.all([
      makeUser(db),
      makeUser(db),
      makeUser(db),
      makeUser(db),
    ]);
    for (const [index, userId] of members.entries()) {
      expectOk(await applyToEvent(busy.id, userId, { now: hours(index) }, db));
    }

    // Two seats taken, two queued. Decline one of the queue.
    const rows = await getApplicationsForEvent(busy.id, db);
    const declined = rows.find((row) => row.userId === members[3]);
    expectOk(await setApplicationStatus(declined!.id, "declined", {}, db));

    const counts = await countApplicationsByStatus([busy.id, quiet.id], db);

    expect(counts.get(busy.id)).toEqual({
      accepted: 2,
      waitlisted: 1,
      declined: 1,
      withdrawn: 0,
    });
    // An event nobody applied to is simply absent — callers fall back to zeroes.
    expect(counts.has(quiet.id)).toBe(false);
    expect(emptyApplicationCounts()).toEqual({
      accepted: 0,
      waitlisted: 0,
      declined: 0,
      withdrawn: 0,
    });
  });

  it("ignores event ids that do not exist", async () => {
    const event = await makeEvent({ seats: 1 });
    expectOk(await applyToEvent(event.id, await makeUser(db), { now: NOW }, db));

    const counts = await countApplicationsByStatus(
      [event.id, "00000000-0000-0000-0000-000000000000"],
      db
    );
    expect([...counts.keys()]).toEqual([event.id]);
  });
});

/* ================================================================== */
/* The admin flow end to end                                          */
/* ================================================================== */

describe("the admin screens' round trip", () => {
  it("previews, deletes a day, and the applicant's remaining answers survive", async () => {
    const event = await makeEvent({ dayCount: 3, seats: 6 });
    const [first, second, third] = await dayIds(event.id);

    const userId = await makeUser(db);
    const application = expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, availability: { [first]: "yes", [second]: "no", [third]: "maybe" } },
        db
      )
    );

    // An admin correcting somebody's answer, as the applicants table allows.
    expectOk(await setAvailability(application.id, { [second]: "yes" }, db));

    const impact = await previewEventDays(event.id, [{ id: first }, { id: second }], db);
    expect(impact.clearedAvailability).toBe(1);
    expect(impact.affectedApplicants).toBe(1);

    expectOk(await setEventDays(event.id, [{ id: second }, { id: first }], db));

    const [after] = await getApplicationsForEvent(event.id, db);
    // Day three's answer is gone; the other two survived the reorder intact.
    expect(after.availability).toEqual({ [first]: "yes", [second]: "yes" });

    const remaining = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.eventId, event.id));
    expect(remaining.length).toBe(1);
  });
});
