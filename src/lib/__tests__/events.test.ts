import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventRow,
  type ProfileFieldOption,
  applications,
  availability,
  eventDays,
  eventQuestions,
  events,
  games,
  profileFields,
  profileValues,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type CreateEventInput,
  type EventQuestionInput,
  type EventResult,
  answersEditable,
  applyToEvent,
  createEvent,
  editApplicationAnswers,
  getApplicationsForEvent,
  getEventById,
  getEventBySlug,
  getMyApplications,
  listEventOptions,
  listEvents,
  loadApplicationForm,
  publishEvent,
  setApplicationStatus,
  setAvailability,
  setConfirmation,
  setEventDays,
  setEventQuestions,
  updateEvent,
  withdrawApplication,
} from "@/lib/events";
import {
  type ApplicationsState,
  type ClosedReason,
  MIN_CAPACITY,
  entryMode,
} from "@/lib/events-policy";

/**
 * The events data layer, against real Postgres.
 *
 * PGlite rather than a mock, for the same reason `src/db/__tests__` uses it:
 * what is interesting here is unique indexes, cascade deletes, a partial index
 * over the waitlist and jsonb round trips, and a fake would not get any of
 * those wrong in the same way Postgres does.
 *
 * The race on the last seat has a file of its own — `events-concurrency.test.ts`
 * — because proving it needs a harness rather than an assertion.
 */

let harness: TestDatabase;
let db: Database;

let rivalsId: string;
let rankFieldId: string;
let roleFieldId: string;
let voiceFieldId: string;

const NOW = new Date("2026-04-01T18:00:00Z");
const hours = (count: number) => new Date(NOW.getTime() + count * 3_600_000);

const ROLE_OPTIONS: ProfileFieldOption[] = [
  { value: "vanguard", label: "Vanguard" },
  { value: "duelist", label: "Duelist" },
  { value: "strategist", label: "Strategist" },
];

let titleCounter = 0;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;

  const [game] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = game.id;

  const [rank] = await db
    .insert(profileFields)
    .values({ gameId: rivalsId, key: "rank", label: "Rank", type: "rank", sort: 0 })
    .returning({ id: profileFields.id });
  rankFieldId = rank.id;

  const [role] = await db
    .insert(profileFields)
    .values({
      gameId: rivalsId,
      key: "role",
      label: "Preferred role",
      type: "select",
      options: ROLE_OPTIONS,
      sort: 1,
    })
    .returning({ id: profileFields.id });
  roleFieldId = role.id;

  const [voice] = await db
    .insert(profileFields)
    .values({ gameId: null, key: "voice", label: "Voice chat", type: "bool" })
    .returning({ id: profileFields.id });
  voiceFieldId = voice.id;
});

afterAll(async () => {
  await harness.close();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Expected success, got: ${result.error} ${JSON.stringify(result.errors ?? {})}`
    );
  }
  return result.data;
}

function expectFail<T>(result: EventResult<T>): {
  error: string;
  errors?: Record<string, string>;
} {
  if (result.ok) throw new Error("Expected a failure, but the call succeeded.");
  return result;
}

async function makeEvent(over: Partial<CreateEventInput> = {}): Promise<EventRow> {
  titleCounter += 1;
  return expectOk(
    await createEvent({ title: `Event ${titleCounter}`, ...over }, db)
  );
}

/** An event members can actually apply to, with everything else left open. */
async function openEvent(over: Partial<CreateEventInput> = {}): Promise<EventRow> {
  const event = await makeEvent({ ...PUBLISHABLE, ...over });
  return expectOk(await publishEvent(event.id, db));
}

/**
 * An open event whose first day — and therefore whose start (R-24) — is
 * `startsAt`, with a sign-up window that makes sense around it.
 *
 * Sign-ups have to close no later than the first day starts (R-25, UC-08 10c),
 * so a test that moves the date moves the deadline with it rather than keeping
 * `PUBLISHABLE`'s far-future one. Passing `null` publishes the event with a
 * date and then takes it away, because UC-09 2 will not publish an event with
 * no day — which is the only way to get the undated state UC-13 7a is about.
 */
async function datedEvent(
  startsAt: Date | null,
  over: Partial<CreateEventInput> = {}
): Promise<EventRow> {
  const dated = startsAt ?? PUBLISHABLE.days[0].startsAt;
  const event = await openEvent({
    days: [{ startsAt: dated }],
    signupClosesAt: dated,
    ...over,
  });
  if (startsAt !== null) return event;

  expectOk(await setEventDays(event.id, [{ startsAt: null }], db));
  return { ...event, startsAt: null, endsAt: null };
}

/**
 * An open event with **one seat left**, and somebody already in the other.
 *
 * R-26's minimum is two seats (`MIN_CAPACITY`), so the smallest capped event
 * there is has two of them, and "the last seat" is that event with one taken.
 * The bystander below is what the tests that used to make a one-seat event are
 * missing: they are about what happens to the *next* applicant, and that is
 * the same question either way — it just takes one more member to ask it.
 */
async function lastSeatEvent(
  over: Partial<CreateEventInput> = {}
): Promise<{ event: EventRow; bystander: string }> {
  const event = await openEvent({ capacity: MIN_CAPACITY, ...over });
  const bystander = await makeUser(db);
  expectOk(await applyToEvent(event.id, bystander, { now: NOW }, db));
  return { event, bystander };
}

/**
 * This file's database, except that the first `update` it is asked for runs
 * `between` to completion before it is issued. Everything read before that
 * point is then stale, which pins the read-write gap a race needs without
 * relying on how two promises happen to interleave.
 */
function writingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "update") return Reflect.get(target, property, receiver);
      return (table: typeof events) => ({
        set: (values: Partial<EventRow>) => ({
          where: (condition: Parameters<ReturnType<ReturnType<Database["update"]>["set"]>["where"]>[0]) => ({
            returning: async () => {
              const run = pending;
              pending = null;
              if (run) await run();
              return target.update(table).set(values).where(condition).returning();
            },
          }),
        }),
      });
    },
  });
}

/**
 * This file's database, except that the first transaction it opens runs
 * `between` to completion first -- `committingAfter` in
 * `championship-results.test.ts` and `admin-users.test.ts`, for the window
 * between a seat freeing and the promotion that fills it.
 *
 * Sequenced rather than raced. Two seats freeing at once is not a thing a timer
 * can be trusted to reproduce, and a test that had to *win* a race to see the
 * bug would pass by luck on the days it did not. This pins the interleave
 * exactly: everything the outer call could have read before it opened its
 * transaction is stale, because the inner one has already committed.
 */
function committingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) => {
        const first = pending;
        pending = null;
        if (first) await first();
        return target.transaction(run);
      };
    },
  });
}

async function setProfileValue(userId: string, fieldId: string, value: unknown): Promise<void> {
  await db
    .insert(profileValues)
    .values({ userId, fieldId, value: value as never })
    .onConflictDoUpdate({
      target: [profileValues.userId, profileValues.fieldId],
      set: { value: value as never },
    });
}

/** The member's stored answer to one profile detail, or null. */
async function storedProfileValue(userId: string, fieldId: string) {
  const [row] = await db
    .select()
    .from(profileValues)
    .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, fieldId)));
  return row?.value ?? null;
}

/** When the member last confirmed one detail, or null — never. */
async function storedConfirmedAt(userId: string, fieldId: string) {
  const [row] = await db
    .select()
    .from(profileValues)
    .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, fieldId)));
  return row?.confirmedAt ?? null;
}

/**
 * When one detail's **value** last changed, or null when there is no answer.
 *
 * Read beside `storedConfirmedAt` rather than folded into it: the two columns
 * answer different questions, and a stamp that moved `updated_at` would erase
 * the difference between "given in March" and "re-checked today".
 */
async function storedUpdatedAt(userId: string, fieldId: string) {
  const [row] = await db
    .select()
    .from(profileValues)
    .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, fieldId)));
  return row?.updatedAt ?? null;
}

/**
 * The `answers` column **as stored**, not as composed on read.
 *
 * `ApplicationView.answers` merges the profile's answers in for linked
 * questions (`linkedAnswers`), which is exactly what makes "is there a second
 * copy of this answer?" invisible through the normal read. So the assertions
 * about duplication go straight at the column.
 */
async function storedAnswers(eventId: string, userId: string) {
  const [row] = await db
    .select({ answers: applications.answers })
    .from(applications)
    .where(and(eq(applications.eventId, eventId), eq(applications.userId, userId)));
  return row?.answers ?? null;
}

/** One profile detail out of a loaded application form, by field id. */
function detailIn(
  form: Awaited<ReturnType<typeof loadApplicationForm>>,
  fieldId: string
) {
  return form?.profile.flatMap((section) => section.fields).find((field) => field.id === fieldId);
}

async function rowsFor(eventId: string) {
  return db
    .select()
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .orderBy(asc(applications.submittedAt));
}

/** Status and queue place per member, which is what most assertions are about. */
async function queueFor(eventId: string): Promise<Record<string, [string, number | null]>> {
  const rows = await rowsFor(eventId);
  return Object.fromEntries(
    rows.map((row) => [row.userId, [row.status, row.waitlistPosition] as [string, number | null]])
  );
}

/* ------------------------------------------------------------------ */
/* Creating and editing                                               */
/* ------------------------------------------------------------------ */

describe("createEvent", () => {
  it("creates a draft with a slug taken from the title", async () => {
    const event = await makeEvent({ title: "Rivals Cup: Spring" });
    expect(event.slug).toBe("rivals-cup-spring");
    expect(event.status).toBe("draft");
    expect(event.type).toBe("custom");
  });

  it("disambiguates a slug rather than refusing the title", async () => {
    await makeEvent({ title: "Jackbox Night" });
    const second = await makeEvent({ title: "Jackbox Night" });
    expect(second.slug).toBe("jackbox-night-2");
  });

  it("insists on a title", async () => {
    expect(expectFail(await createEvent({ title: "   " }, db)).error).toMatch(/title/i);
  });

  it("refuses a capacity of zero or less", async () => {
    expect(expectFail(await createEvent({ title: "No seats", capacity: 0 }, db)).error).toMatch(
      /seats/i
    );
  });

  it("refuses a signup window that closes before it opens", async () => {
    const result = await createEvent(
      { title: "Backwards", signupOpensAt: hours(5), signupClosesAt: hours(1) },
      db
    );
    expect(expectFail(result).error).toMatch(/close before they open/i);
  });

  /*
   * What used to be "refuses an event that ends before it starts" — the two
   * columns it compared are gone, and the calendar it was protecting is now the
   * day list (R-24). Same mistake, same refusal, named per day (UC-08 10c).
   */
  it("refuses days that run backwards", async () => {
    const result = await createEvent(
      { title: "Time travel", days: [{ startsAt: hours(5) }, { startsAt: hours(1) }] },
      db
    );
    expect(expectFail(result).error).toMatch(/Day 2 starts before Day 1/i);
    // UC-08 10c: nothing saved. Not even the event row, which is written
    // before the days are.
    const rows = await db.select().from(events).where(eq(events.title, "Time travel"));
    expect(rows).toHaveLength(0);
  });

  it("refuses signups that open after the event has already begun", async () => {
    const result = await createEvent(
      { title: "Too late", signupOpensAt: hours(5), days: [{ startsAt: hours(1) }] },
      db
    );
    expect(expectFail(result).error).toMatch(/nobody could ever apply/i);
  });

  it("accepts a rank threshold that is on the game's ladder", async () => {
    const event = await makeEvent({
      title: "Platinum and up",
      gameId: rivalsId,
      minRankToEnter: "Platinum III",
      minRankToCaptain: "Diamond II",
    });
    expect(event.minRankToEnter).toBe("Platinum III");
  });

  it("refuses a rank threshold the ladder has never heard of", async () => {
    const result = await createEvent(
      { title: "Vibranium only", gameId: rivalsId, minRankToEnter: "Vibranium I" },
      db
    );
    expect(expectFail(result).error).toMatch(/not one of Marvel Rivals's ranks/i);
  });

  it("refuses a rank threshold on an event with no game", async () => {
    const result = await createEvent({ title: "Gameless gate", minRankToEnter: "Gold I" }, db);
    expect(expectFail(result).error).toMatch(/pick the game/i);
  });

  it("refuses a game that does not exist", async () => {
    const result = await createEvent(
      { title: "Ghost game", gameId: "00000000-0000-0000-0000-000000000000" },
      db
    );
    expect(expectFail(result).error).toMatch(/no longer exists/i);
  });

  it("creates the days it was handed", async () => {
    const event = await makeEvent({
      title: "Three dayer",
      days: [{ label: "Friday" }, { label: "Saturday" }, { label: "Sunday" }],
    });
    const days = await db.select().from(eventDays).where(eq(eventDays.eventId, event.id));
    expect(days.map((day) => day.dayIndex).sort()).toEqual([0, 1, 2]);
  });
});

describe("updateEvent and publishEvent", () => {
  it("changes only what it was given", async () => {
    const event = await makeEvent({ title: "Before", description: "Kept" });
    const updated = expectOk(await updateEvent(event.id, { title: "After" }, db));
    expect(updated.title).toBe("After");
    expect(updated.description).toBe("Kept");
    expect(updated.slug).toBe(event.slug);
  });

  it("publishes a draft, and publishing twice is not an error", async () => {
    const event = await makeEvent(PUBLISHABLE);
    expect(expectOk(await publishEvent(event.id, db)).status).toBe("published");
    expect(expectOk(await publishEvent(event.id, db)).status).toBe("published");
  });

  it("refuses to publish without a day or a sign-up window, and says which", async () => {
    // UC-09 2a: required setup missing — the system lists what is missing and
    // the event stays unpublished. (This used to be advice only.)
    const event = await makeEvent();

    const error = expectFail(await publishEvent(event.id, db)).error;

    expect(error).toMatch(/at least one day with a start time/);
    expect(error).toMatch(/sign-up window/);
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].status).toBe(
      "draft"
    );
  });

  it("refuses to publish when the only day has no start time", async () => {
    const event = await makeEvent({ ...PUBLISHABLE, days: [{ label: "Some day" }] });

    const error = expectFail(await publishEvent(event.id, db)).error;

    expect(error).toMatch(/at least one day with a start time/);
    expect(error).not.toMatch(/sign-up window/);
  });

  it("refuses the same publish through the status control", async () => {
    // UC-09 2a on every path: moving the status to published is publishing.
    const event = await makeEvent({ signupOpensAt: hours(1) });

    const error = expectFail(await updateEvent(event.id, { status: "published" }, db)).error;

    expect(error).toMatch(/at least one day with a start time/);
    expect(error).toMatch(/sign-up window/);
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].status).toBe(
      "draft"
    );
  });

  it("publishes a ready event through the status control", async () => {
    const event = await makeEvent(PUBLISHABLE);
    expect(expectOk(await updateEvent(event.id, { status: "published" }, db)).status).toBe(
      "published"
    );
  });

  it("keeps a basics save that lands between a cancel's read and its write", async () => {
    // The cancel has read the old title; the rename commits; then the cancel
    // writes. Only the keys in each patch may change, so both survive.
    const event = await openEvent();
    const save = () => updateEvent(event.id, { title: "Renamed while cancelling" }, db);

    expectOk(await updateEvent(event.id, { status: "cancelled" }, writingAfter(save)));

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.status).toBe("cancelled");
    expect(row.title).toBe("Renamed while cancelling");
  });

  it("keeps a cancel that lands between a basics save's read and its write", async () => {
    // The other order: the save has read `published`; the cancel commits; then
    // the save writes. A save that did not ask to move the status must not
    // put the event back to published.
    const event = await openEvent();
    const cancel = () => updateEvent(event.id, { status: "cancelled" }, db);

    expectOk(
      await updateEvent(event.id, { title: "Renamed while cancelling" }, writingAfter(cancel))
    );

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.status).toBe("cancelled");
    expect(row.title).toBe("Renamed while cancelling");
  });

  it("refuses an edit to an event completed between the edit's read and its write", async () => {
    // UC-09 6b: the lock is checked against the status the edit read, so the
    // write must not land if the event was finished after that read.
    const event = await openEvent();
    expectOk(await updateEvent(event.id, { status: "live" }, db));
    const complete = () => updateEvent(event.id, { status: "complete" }, db);

    const late = await updateEvent(event.id, { title: "Renamed too late" }, writingAfter(complete));

    expect(expectFail(late).error).toBe("The event changed meanwhile - reload.");
    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.status).toBe("complete");
    expect(row.title).toBe(event.title);
  });

  it("refuses a move when the event is no longer in the status the caller saw", async () => {
    const event = await openEvent();
    expectOk(await updateEvent(event.id, { status: "cancelled" }, db));

    const stale = await updateEvent(event.id, { from: "published", status: "live" }, db);

    expect(expectFail(stale).error).toBe("The event changed meanwhile - reload.");
  });

  it("treats saving the status it already has as no move at all", async () => {
    const event = await makeEvent();
    expect(expectOk(await updateEvent(event.id, { status: "draft" }, db)).status).toBe("draft");
  });

  it("refuses a status jump that skips being published", async () => {
    const event = await makeEvent();
    expect(expectFail(await updateEvent(event.id, { status: "live" }, db)).error).toMatch(
      /cannot go from draft to live/i
    );
  });

  it("walks a real event through its lifecycle, reopening included", async () => {
    // UC-09 1, 3, 5 and 6a.
    const event = await openEvent();
    expect(expectOk(await updateEvent(event.id, { status: "draft" }, db)).status).toBe("draft");
    expectOk(await publishEvent(event.id, db));
    expect(expectOk(await updateEvent(event.id, { status: "live" }, db)).status).toBe("live");
    expect(expectOk(await updateEvent(event.id, { status: "complete" }, db)).status).toBe(
      "complete"
    );
    expect(expectOk(await updateEvent(event.id, { status: "live" }, db)).status).toBe("live");
  });

  it("refuses a completed event going back to unpublished", async () => {
    // UC-09 3a, the example the use case gives.
    const event = await openEvent();
    expectOk(await updateEvent(event.id, { status: "live" }, db));
    expectOk(await updateEvent(event.id, { status: "complete" }, db));

    expect(expectFail(await updateEvent(event.id, { status: "draft" }, db)).error).toMatch(
      /cannot go from complete to draft/i
    );
  });

  it("keeps a cancelled event cancelled", async () => {
    const event = await openEvent();
    expectOk(await updateEvent(event.id, { status: "cancelled" }, db));

    expect(expectFail(await updateEvent(event.id, { status: "draft" }, db)).error).toMatch(
      /cannot go from cancelled to draft/i
    );
    expect(expectFail(await publishEvent(event.id, db)).error).toMatch(/cannot be published/);
  });

  it("keeps validating once the event exists", async () => {
    const event = await makeEvent({ gameId: rivalsId });
    expect(
      expectFail(await updateEvent(event.id, { minRankToEnter: "Vibranium I" }, db)).error
    ).toMatch(/not one of/i);
  });

  /*
   * Rewritten to follow UC-08 E2a: "Address taken or not letters, numbers and
   * hyphens - System rejects with the reason; the old address stays."
   *
   * It used to assert the opposite — that a taken address was quietly saved as
   * `…-2` — which is `freeSlug`'s behaviour and is right for the address
   * *derived from a title* at creation (UC-08 2), where there is nothing the
   * admin typed for a suffix to contradict. An address the manager typed is
   * E2a's case, and the full set of it is in `web-address.test.ts`.
   */
  it("refuses another event's slug by name, leaving the old address alone (UC-08 E2a)", async () => {
    const first = await makeEvent({ title: "Slug holder" });
    const second = await makeEvent({ title: "Slug wanter" });
    const was = second.slug;

    const refusal = expectFail(await updateEvent(second.id, { slug: first.slug }, db));
    expect(refusal.error).toContain(first.slug);
    expect(refusal.error).toMatch(/already another event's address/i);

    const after = await getEventById(second.id, {}, db);
    expect(after?.slug).toBe(was);
  });

  it("says so when the event has gone", async () => {
    const result = await updateEvent("00000000-0000-0000-0000-000000000000", { title: "x" }, db);
    expect(expectFail(result).error).toMatch(/no longer exists/i);
  });
});

/* ------------------------------------------------------------------ */
/* Days                                                               */
/* ------------------------------------------------------------------ */

describe("setEventDays", () => {
  it("numbers the days 0…n-1 in the order given", async () => {
    const event = await makeEvent();
    const { days } = expectOk(
      await setEventDays(event.id, [{ label: "Fri" }, { label: "Sat" }], db)
    );
    expect(days.map((day) => [day.dayIndex, day.label])).toEqual([
      [0, "Fri"],
      [1, "Sat"],
    ]);
  });

  it("refuses a fifth day", async () => {
    const event = await makeEvent();
    const result = await setEventDays(
      event.id,
      [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }],
      db
    );
    expect(expectFail(result).error).toMatch(/at most 4 days/i);
  });

  it("rotates four days without losing anyone's availability", async () => {
    // The hard case: a permutation of a full set, against a unique
    // (event, day_index) constraint with no free slot to move through.
    const event = await openEvent();
    const { days } = expectOk(
      await setEventDays(
        event.id,
        [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
        db
      )
    );

    const userId = await makeUser(db);
    const applied = expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, availability: { [days[0].id]: "yes", [days[3].id]: "no" } },
        db
      )
    );
    expect(applied.availability[days[0].id]).toBe("yes");

    const rotated = expectOk(
      await setEventDays(
        event.id,
        [days[3], days[0], days[1], days[2]].map((day) => ({ id: day.id, label: day.label })),
        db
      )
    );

    expect(rotated.days.map((day) => day.label)).toEqual(["D", "A", "B", "C"]);
    expect(rotated.clearedAvailability).toBe(0);
    expect(rotated.days.map((day) => day.dayIndex)).toEqual([0, 1, 2, 3]);
    // Same rows, so the answers are still attached to the same days.
    expect(rotated.days.map((day) => day.id).sort()).toEqual(days.map((day) => day.id).sort());

    const stored = await db
      .select()
      .from(availability)
      .where(eq(availability.applicationId, applied.id));
    expect(stored).toHaveLength(2);
  });

  it("reports how much availability dropping a day destroys", async () => {
    const event = await openEvent();
    const { days } = expectOk(
      await setEventDays(event.id, [{ label: "Keep" }, { label: "Drop" }], db)
    );
    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, availability: { [days[0].id]: "yes", [days[1].id]: "maybe" } },
        db
      )
    );

    const result = expectOk(await setEventDays(event.id, [{ id: days[0].id, label: "Keep" }], db));
    expect(result.clearedAvailability).toBe(1);
    expect(result.days).toHaveLength(1);
  });

  it("refuses a day belonging to another event", async () => {
    const mine = await makeEvent();
    const theirs = await makeEvent();
    const { days } = expectOk(await setEventDays(theirs.id, [{ label: "Theirs" }], db));

    const result = await setEventDays(mine.id, [{ id: days[0].id, label: "Mine now" }], db);
    expect(expectFail(result).error).toMatch(/different event/i);
  });
});

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

async function addQuestions(
  eventId: string,
  questions: EventQuestionInput[]
): Promise<Awaited<ReturnType<typeof setEventQuestions>>> {
  return setEventQuestions(eventId, questions, db);
}

describe("setEventQuestions", () => {
  it("writes questions in order, with keys derived from the labels", async () => {
    const event = await makeEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Your in-game name", type: "text" },
        { label: "Preferred role", type: "select", options: ROLE_OPTIONS, required: true },
      ])
    );

    expect(questions.map((question) => [question.key, question.sort])).toEqual([
      ["your-in-game-name", 0],
      ["preferred-role", 1],
    ]);
    expect(questions[1].required).toBe(true);
    expect(questions[1].options).toEqual(ROLE_OPTIONS);
  });

  it("keeps two questions with the same label apart", async () => {
    const event = await makeEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Notes", type: "text" },
        { label: "Notes", type: "text" },
      ])
    );
    expect(questions.map((question) => question.key)).toEqual(["notes", "notes-2"]);
  });

  it("insists a pick-one question has something to pick", async () => {
    const event = await makeEvent();
    const result = await addQuestions(event.id, [{ label: "Pick", type: "select" }]);
    expect(expectFail(result).errors?.["new-0"]).toMatch(/at least one option/i);
  });

  it("refuses a rank question on an event with no ladder behind it", async () => {
    const event = await makeEvent();
    const result = await addQuestions(event.id, [{ label: "Rank", type: "rank" }]);
    expect(expectFail(result).errors?.["new-0"]).toMatch(/rank ladder/i);
  });

  it("links a question to a profile field so it can prefill", async () => {
    const event = await makeEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
      ])
    );
    expect(questions[0].profileFieldId).toBe(roleFieldId);
  });

  it("links to a global profile field even when the event has no game", async () => {
    const event = await makeEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Voice chat", type: "bool", profileFieldId: voiceFieldId },
      ])
    );
    expect(questions[0].profileFieldId).toBe(voiceFieldId);
  });

  it("refuses to prefill from another game's profile field", async () => {
    const [other] = await db
      .insert(games)
      .values({ key: "other-game", name: "Other" })
      .returning({ id: games.id });
    const [strayField] = await db
      .insert(profileFields)
      .values({ gameId: other.id, key: "handle", label: "Handle", type: "text" })
      .returning({ id: profileFields.id });

    const event = await makeEvent({ gameId: rivalsId });
    const result = await addQuestions(event.id, [
      { label: "Handle", type: "text", profileFieldId: strayField.id },
    ]);
    expect(expectFail(result).errors?.["new-0"]).toMatch(/not one this event can prefill/i);
  });

  it("refuses to prefill from a field of a different type", async () => {
    const event = await makeEvent({ gameId: rivalsId });
    const result = await addQuestions(event.id, [
      { label: "Role as text", type: "text", profileFieldId: roleFieldId },
    ]);
    expect(expectFail(result).errors?.["new-0"]).toMatch(/different type/i);
  });

  it("refuses a question id belonging to another event", async () => {
    const theirs = await makeEvent();
    const { questions } = expectOk(await addQuestions(theirs.id, [{ label: "Theirs", type: "text" }]));

    const mine = await makeEvent();
    const result = await addQuestions(mine.id, [
      { id: questions[0].id, label: "Mine now", type: "text" },
    ]);
    expect(expectFail(result).errors?.[questions[0].id]).toMatch(/different event/i);
  });

  it("keeps ids and answers through a reorder", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "First", type: "text" },
        { label: "Second", type: "text" },
      ])
    );

    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, answers: { [questions[0].id]: "one", [questions[1].id]: "two" } },
        db
      )
    );

    const reordered = expectOk(
      await addQuestions(event.id, [
        { id: questions[1].id, key: questions[1].key, label: "Second", type: "text" },
        { id: questions[0].id, key: questions[0].key, label: "First", type: "text" },
      ])
    );
    expect(reordered.questions.map((question) => question.label)).toEqual(["Second", "First"]);
    expect(reordered.clearedAnswers).toBe(0);

    const [row] = await rowsFor(event.id);
    expect(row.answers[questions[0].id]).toBe("one");
  });

  it("clears the answers a deleted question leaves behind, and counts them", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Keep", type: "text" },
        { label: "Delete", type: "text" },
      ])
    );

    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, answers: { [questions[0].id]: "kept", [questions[1].id]: "doomed" } },
        db
      )
    );

    const after = expectOk(
      await addQuestions(event.id, [
        { id: questions[0].id, key: questions[0].key, label: "Keep", type: "text" },
      ])
    );
    expect(after.clearedAnswers).toBe(1);

    const [row] = await rowsFor(event.id);
    expect(Object.keys(row.answers)).toEqual([questions[0].id]);
  });

  it("clears answers that a retype has invalidated", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Role", type: "select", options: ROLE_OPTIONS },
      ])
    );

    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(event.id, userId, { now: NOW, answers: { [questions[0].id]: "duelist" } }, db)
    );

    const after = expectOk(
      await addQuestions(event.id, [
        { id: questions[0].id, key: questions[0].key, label: "Role", type: "number" },
      ])
    );
    expect(after.clearedAnswers).toBe(1);
    const [row] = await rowsFor(event.id);
    expect(row.answers).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Applying — the open/closed matrix, for real                        */
/* ------------------------------------------------------------------ */

describe("applyToEvent — when applications are open", () => {
  it("takes an application to a published event with no window", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expect(application.status).toBe("accepted");
    expect(application.waitlistPosition).toBeNull();
    expect(application.submittedAt).toEqual(NOW);
  });

  it("refuses a draft", async () => {
    const event = await makeEvent();
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /not been published/i
    );
  });

  it("refuses before signups open", async () => {
    const event = await openEvent({ signupOpensAt: hours(2) });
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /have not opened/i
    );
  });

  it("refuses after signups close", async () => {
    const event = await openEvent({ signupClosesAt: hours(-1) });
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /have closed/i
    );
  });

  it("refuses once the event has started", async () => {
    const event = await datedEvent(hours(-1));
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /already started/i
    );
  });

  it("refuses a cancelled event", async () => {
    const event = await openEvent();
    expectOk(await updateEvent(event.id, { status: "cancelled" }, db));
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /cancelled/i
    );
  });

  it("accepts inside the window", async () => {
    const event = await openEvent({ signupOpensAt: hours(-2), signupClosesAt: hours(2) });
    const userId = await makeUser(db);
    expect(expectOk(await applyToEvent(event.id, userId, { now: NOW }, db)).status).toBe(
      "accepted"
    );
  });

  it("queues rather than refusing when a full event keeps its waitlist", async () => {
    const { event } = await lastSeatEvent();
    const first = await makeUser(db);
    const second = await makeUser(db);
    expectOk(await applyToEvent(event.id, first, { now: NOW }, db));

    const queued = expectOk(await applyToEvent(event.id, second, { now: NOW }, db));
    expect(queued.status).toBe("waitlisted");
    expect(queued.waitlistPosition).toBe(1);
  });

  it("stores nothing when a full first-come event has its waitlist off (R-170, UC-12 E3)", async () => {
    const { event, bystander } = await lastSeatEvent({ config: { waitlist: false } });
    const first = await makeUser(db);
    const second = await makeUser(db);
    expectOk(await applyToEvent(event.id, first, { now: NOW }, db));

    const refused = expectFail(await applyToEvent(event.id, second, { now: NOW }, db));

    expect(refused.error).toBe("This event is full.");
    expect(Object.keys(await queueFor(event.id)).sort()).toEqual([bystander, first].sort());
  });

  it("refuses a second application from the same member", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /already applied/i
    );
  });

  it("refuses a member whose application was declined", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expectOk(await setApplicationStatus(application.id, "declined", { now: NOW }, db));

    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /was declined/i
    );
  });

  it("refuses an account that does not exist", async () => {
    const event = await openEvent();
    const result = await applyToEvent(
      event.id,
      "00000000-0000-0000-0000-000000000000",
      { now: NOW },
      db
    );
    expect(expectFail(result).error).toMatch(/account/i);
  });
});

/* ------------------------------------------------------------------ */
/* Applying — answers and the rank gate                               */
/* ------------------------------------------------------------------ */

describe("applyToEvent — answers", () => {
  it("rejects an answer naming a question from another event", async () => {
    const theirs = await makeEvent();
    const { questions: theirQuestions } = expectOk(
      await addQuestions(theirs.id, [{ label: "Theirs", type: "text" }])
    );

    const mine = await openEvent();
    expectOk(await addQuestions(mine.id, [{ label: "Mine", type: "text" }]));

    const userId = await makeUser(db);
    const result = await applyToEvent(
      mine.id,
      userId,
      { now: NOW, answers: { [theirQuestions[0].id]: "smuggled" } },
      db
    );

    expect(expectFail(result).errors?.[theirQuestions[0].id]).toMatch(/not part of this event/i);
    // Nothing was written: a rejected application is not a half-written one.
    expect(await rowsFor(mine.id)).toEqual([]);
  });

  it("rejects an unanswered required question", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [{ label: "In-game name", type: "text", required: true }])
    );

    const userId = await makeUser(db);
    const result = await applyToEvent(event.id, userId, { now: NOW }, db);
    expect(expectFail(result).errors?.[questions[0].id]).toMatch(/required/i);
  });

  it("rejects an option that is not on the list", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [{ label: "Role", type: "select", options: ROLE_OPTIONS }])
    );

    const userId = await makeUser(db);
    const result = await applyToEvent(
      event.id,
      userId,
      { now: NOW, answers: { [questions[0].id]: "healer" } },
      db
    );
    expect(expectFail(result).errors?.[questions[0].id]).toMatch(/not one of the options/i);
  });

  it("stores answers keyed by question id", async () => {
    const event = await openEvent();
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Role", type: "select", options: ROLE_OPTIONS },
        { label: "Hours", type: "number" },
      ])
    );

    const userId = await makeUser(db);
    const application = expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, answers: { [questions[0].id]: "duelist", [questions[1].id]: 6 } },
        db
      )
    );

    expect(application.answers).toEqual({
      [questions[0].id]: "duelist",
      [questions[1].id]: 6,
    });
  });

  it("reads a linked question's answer from the profile, the payload saying nothing", async () => {
    /*
     * Not a prefill — there is no prefill any more. Nothing is copied onto the
     * application: `linkedAnswers` composes the answer out of `profile_values`
     * on every read, so the view shows what the profile says at the instant it
     * is read (R-11, Task 10).
     */
    const event = await openEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          required: true,
          profileFieldId: roleFieldId,
        },
      ])
    );

    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "strategist");

    // Nothing in the payload at all — the returning player who just taps submit.
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expect(application.answers[questions[0].id]).toBe("strategist");
  });

  it("refuses an answer posted under a linked question's id", async () => {
    /*
     * The forged-or-stale payload for the one question that is not asked on
     * the application any more. Storing it would be the second copy of an
     * answer Task 10 exists to remove, so it is refused rather than dropped —
     * the same judgement a question id from another event gets.
     */
    const event = await openEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
      ])
    );

    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "strategist");

    const result = await applyToEvent(
      event.id,
      userId,
      { now: NOW, answers: { [questions[0].id]: "vanguard" } },
      db
    );
    expect(expectFail(result).errors?.[questions[0].id]).toMatch(/not part of this event/i);
    expect(await rowsFor(event.id)).toEqual([]);
    // And the profile is untouched: a refusal writes nothing anywhere.
    expect(await storedProfileValue(userId, roleFieldId)).toBe("strategist");
  });

  it("writes a changed detail to the profile instead of onto the application", async () => {
    // UC-12 3a: "Member edits them in place; System saves them to their
    // profile too" — and the profile is the only place it lands (R-11).
    const event = await openEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
      ])
    );

    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "strategist");

    const application = expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, details: { [roleFieldId]: "vanguard" } },
        db
      )
    );
    expect(application.answers[questions[0].id]).toBe("vanguard");
    expect(await storedProfileValue(userId, roleFieldId)).toBe("vanguard");
    expect(await storedAnswers(event.id, userId)).toEqual({});
  });

  it("rejects availability naming a day from another event", async () => {
    const theirs = await makeEvent();
    const { days: theirDays } = expectOk(await setEventDays(theirs.id, [{ label: "Theirs" }], db));

    const mine = await openEvent();
    expectOk(await setEventDays(mine.id, [{ label: "Mine" }], db));

    const userId = await makeUser(db);
    const result = await applyToEvent(
      mine.id,
      userId,
      { now: NOW, availability: { [theirDays[0].id]: "yes" } },
      db
    );

    expect(expectFail(result).error).toMatch(/not part of this event/i);
    expect(await rowsFor(mine.id)).toEqual([]);
  });

  it("stores availability given at application time", async () => {
    const event = await openEvent();
    const { days } = expectOk(
      await setEventDays(event.id, [{ label: "Fri" }, { label: "Sat" }], db)
    );

    const userId = await makeUser(db);
    const application = expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, availability: { [days[0].id]: "yes", [days[1].id]: "maybe" } },
        db
      )
    );

    expect(application.availability).toEqual({
      [days[0].id]: "yes",
      [days[1].id]: "maybe",
    });
  });
});

describe("applyToEvent — the rank gate", () => {
  async function gatedEvent(): Promise<EventRow> {
    return openEvent({ gameId: rivalsId, minRankToEnter: "Platinum III" });
  }

  it("lets a member above the threshold in", async () => {
    const event = await gatedEvent();
    const userId = await makeUser(db);
    await setProfileValue(userId, rankFieldId, "Diamond II");
    expect(expectOk(await applyToEvent(event.id, userId, { now: NOW }, db)).status).toBe(
      "accepted"
    );
  });

  it("turns away a member below it, with the reason", async () => {
    const event = await gatedEvent();
    const userId = await makeUser(db);
    await setProfileValue(userId, rankFieldId, "Gold I");
    const result = await applyToEvent(event.id, userId, { now: NOW }, db);
    expect(expectFail(result).error).toMatch(/needs Platinum III or above/i);
  });

  it("turns away a member with no rank recorded, and sends them to their profile", async () => {
    const event = await gatedEvent();
    const userId = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /profile/i
    );
  });

  it("turns away a member whose rank has been dropped from the ladder", async () => {
    const event = await gatedEvent();
    const userId = await makeUser(db);
    await setProfileValue(userId, rankFieldId, "Vibranium I");
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /pick it again/i
    );
  });

  it("lets everyone in when the event sets no threshold", async () => {
    const event = await openEvent({ gameId: rivalsId });
    const userId = await makeUser(db);
    expect(expectOk(await applyToEvent(event.id, userId, { now: NOW }, db)).status).toBe(
      "accepted"
    );
  });
});

/* ------------------------------------------------------------------ */
/* The queue                                                          */
/* ------------------------------------------------------------------ */

/**
 * An event with its last seat taken, one member in it and two more queued
 * behind.
 *
 * `bystander` holds the other seat — see `lastSeatEvent` for why there is one:
 * two seats is the smallest capped event R-26 allows, so a test about the queue
 * behind a full event has one extra person sitting in it who never moves.
 */
async function queuedEvent(): Promise<{
  event: EventRow;
  bystander: string;
  seated: string;
  first: string;
  second: string;
}> {
  const { event, bystander } = await lastSeatEvent();
  const seated = await makeUser(db);
  const first = await makeUser(db);
  const second = await makeUser(db);

  expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
  expectOk(await applyToEvent(event.id, first, { now: hours(1) }, db));
  expectOk(await applyToEvent(event.id, second, { now: hours(2) }, db));

  return { event, bystander, seated, first, second };
}

describe("the waitlist", () => {
  it("seats the first arrivals and queues the rest in order", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["accepted", null],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });
  });

  it("promotes the earliest waitlister when the seat frees, and closes the gap", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();

    const result = expectOk(await withdrawApplication(event.id, seated, db));
    expect(result.application.status).toBe("withdrawn");
    expect(result.promoted.map((row) => row.userId)).toEqual([first]);

    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["withdrawn", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
    });
  });

  it("renumbers from 1 when somebody leaves the middle of the queue", async () => {
    const { event, bystander } = await lastSeatEvent();
    const seated = await makeUser(db);
    const middle = await makeUser(db);
    const last = await makeUser(db);
    expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, middle, { now: hours(1) }, db));
    expectOk(await applyToEvent(event.id, last, { now: hours(2) }, db));

    const result = expectOk(await withdrawApplication(event.id, middle, db));
    // Nobody moves up: the person leaving was holding a place, not a seat.
    expect(result.promoted).toEqual([]);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["accepted", null],
      [middle]: ["withdrawn", null],
      [last]: ["waitlisted", 1],
    });
  });

  it("promotes as many as the freed seats allow, in queue order", async () => {
    const event = await openEvent({ capacity: 2 });
    const a = await makeUser(db);
    const b = await makeUser(db);
    const c = await makeUser(db);
    const d = await makeUser(db);
    expectOk(await applyToEvent(event.id, a, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, b, { now: hours(1) }, db));
    expectOk(await applyToEvent(event.id, c, { now: hours(2) }, db));
    expectOk(await applyToEvent(event.id, d, { now: hours(3) }, db));

    expectOk(await withdrawApplication(event.id, a, db));
    expectOk(await withdrawApplication(event.id, b, db));

    expect(await queueFor(event.id)).toEqual({
      [a]: ["withdrawn", null],
      [b]: ["withdrawn", null],
      [c]: ["accepted", null],
      [d]: ["accepted", null],
    });
  });

  /**
   * Two seats freeing, one after the other, with the second decision's caller
   * having read the world before the first one committed (R-55, UC-13 3a).
   *
   * This is the bug the one `freeSeat` rule exists to make impossible. Compute
   * a promotion from rows read before the other seat freed and the arithmetic
   * comes out twice on the same person: C is promoted by the first withdrawal
   * and, on a stale read, is still the front of the queue for the second -- so
   * C is "promoted" again, the write is a no-op, and D is left queueing at #1
   * with an empty seat in front of them. Nobody is double-booked; somebody is
   * simply never let in, which is the half of it that goes unnoticed.
   *
   * So the assertion is both halves: each freed seat promoted a *different*
   * person, and nobody was skipped.
   */
  it("gives two seats freeing at once to two different people, skipping nobody", async () => {
    const event = await openEvent({ capacity: 2 });
    const [a, b, c, d] = [
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
    ];
    expectOk(await applyToEvent(event.id, a, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, b, { now: hours(1) }, db));
    expectOk(await applyToEvent(event.id, c, { now: hours(2) }, db));
    expectOk(await applyToEvent(event.id, d, { now: hours(3) }, db));

    // B withdraws and commits; only then does A's withdrawal open its own
    // transaction. A's promotion has to be decided from what B left behind.
    const outer = expectOk(
      await withdrawApplication(
        event.id,
        a,
        committingAfter(() => withdrawApplication(event.id, b, db))
      )
    );

    expect(outer.promoted.map((row) => row.userId)).toEqual([d]);
    expect(await queueFor(event.id)).toEqual({
      [a]: ["withdrawn", null],
      [b]: ["withdrawn", null],
      [c]: ["accepted", null],
      [d]: ["accepted", null],
    });
  });

  // The same interleave through the manager's door (UC-14 6). A decline and a
  // withdrawal free two seats between them, and the two promotions must not
  // land on the same person either.
  it("does not promote the same person for a seat somebody else has already freed", async () => {
    const event = await openEvent({ capacity: 2 });
    const [a, b, c, d] = [
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
    ];
    expectOk(await applyToEvent(event.id, a, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, b, { now: hours(1) }, db));
    expectOk(await applyToEvent(event.id, c, { now: hours(2) }, db));
    expectOk(await applyToEvent(event.id, d, { now: hours(3) }, db));

    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === a);

    const outer = expectOk(
      await setApplicationStatus(
        holder?.id ?? "",
        "declined",
        { now: NOW },
        committingAfter(() => withdrawApplication(event.id, b, db))
      )
    );

    expect(outer.promoted.map((row) => row.userId)).toEqual([d]);
    expect(outer.seats.accepted).toBe(2);
    expect(await queueFor(event.id)).toEqual({
      [a]: ["declined", null],
      [b]: ["withdrawn", null],
      [c]: ["accepted", null],
      [d]: ["accepted", null],
    });
  });

  it("withdrawing twice says withdrawn rather than failing", async () => {
    const { event, seated } = await queuedEvent();
    expectOk(await withdrawApplication(event.id, seated, db));
    const again = expectOk(await withdrawApplication(event.id, seated, db));
    expect(again.application.status).toBe("withdrawn");
    expect(again.promoted).toEqual([]);
  });

  it("says so when there is nothing to withdraw", async () => {
    const event = await openEvent();
    const stranger = await makeUser(db);
    expect(expectFail(await withdrawApplication(event.id, stranger, db)).error).toMatch(
      /not applied/i
    );
  });

  it("lets a member re-apply after withdrawing, back into a free seat", async () => {
    const event = await openEvent({ capacity: 2 });
    const userId = await makeUser(db);
    const first = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expectOk(await withdrawApplication(event.id, userId, db));

    const again = expectOk(await applyToEvent(event.id, userId, { now: hours(3) }, db));
    expect(again.status).toBe("accepted");
    expect(again.id).toBe(first.id);
    expect(again.submittedAt).toEqual(hours(3));
    expect(await rowsFor(event.id)).toHaveLength(1);
  });

  it("sends a re-applicant to the back of the queue when the seats have gone", async () => {
    const { event } = await lastSeatEvent();
    const seated = await makeUser(db);
    const leaver = await makeUser(db);
    const other = await makeUser(db);

    expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, leaver, { now: hours(1) }, db));
    expectOk(await withdrawApplication(event.id, leaver, db));
    expectOk(await applyToEvent(event.id, other, { now: hours(2) }, db));

    const again = expectOk(await applyToEvent(event.id, leaver, { now: hours(3) }, db));
    expect(again.status).toBe("waitlisted");
    expect(again.waitlistPosition).toBe(2);
  });
});

describe("approval entry mode (R-27, UC-12 7b, UC-14)", () => {
  // The smallest capped event R-26 allows, which is the point: an approval
  // event's applications are pending whatever the cap says.
  const approvalEvent = (over: Partial<CreateEventInput> = {}) =>
    openEvent({ capacity: MIN_CAPACITY, config: { entryMode: "approval" }, ...over });

  async function pendingApplication(eventId: string) {
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(eventId, userId, { now: NOW }, db));
    return { userId, application };
  }

  it("stores every application as pending, holding no seat and no queue place", async () => {
    const event = await approvalEvent();
    const first = await pendingApplication(event.id);
    const second = await pendingApplication(event.id);

    expect(await queueFor(event.id)).toEqual({
      [first.userId]: ["pending", null],
      [second.userId]: ["pending", null],
    });
  });

  it("stores pending even when the waitlist is off and every seat is taken", async () => {
    const event = await approvalEvent({ config: { entryMode: "approval", waitlist: false } });
    // Both seats, so the cap really is full when the late one arrives.
    for (let seat = 0; seat < MIN_CAPACITY; seat += 1) {
      const seated = await pendingApplication(event.id);
      expectOk(await setApplicationStatus(seated.application.id, "accepted", { now: NOW }, db));
    }

    const late = await pendingApplication(event.id);

    expect(late.application.status).toBe("pending");
  });

  it("refuses a second application while the first is pending", async () => {
    const event = await approvalEvent();
    const { userId } = await pendingApplication(event.id);

    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toMatch(
      /already applied/i
    );
  });

  it("lets a manager accept a pending applicant into a seat", async () => {
    const event = await approvalEvent();
    const { userId, application } = await pendingApplication(event.id);

    const result = expectOk(await setApplicationStatus(application.id, "accepted", { now: NOW }, db));

    expect(result.seats.accepted).toBe(1);
    expect(await queueFor(event.id)).toEqual({ [userId]: ["accepted", null] });
  });

  it("lets a manager waitlist a pending applicant at the back of the queue", async () => {
    const event = await approvalEvent();
    const { userId, application } = await pendingApplication(event.id);

    expectOk(await setApplicationStatus(application.id, "waitlisted", { now: NOW }, db));

    expect(await queueFor(event.id)).toEqual({ [userId]: ["waitlisted", 1] });
  });

  it("lets a manager decline a pending applicant", async () => {
    const event = await approvalEvent();
    const { userId, application } = await pendingApplication(event.id);

    expectOk(await setApplicationStatus(application.id, "declined", { now: NOW }, db));

    expect(await queueFor(event.id)).toEqual({ [userId]: ["declined", null] });
  });

  it("refuses a manager moving an application back to pending", async () => {
    const event = await approvalEvent();
    const { application } = await pendingApplication(event.id);
    expectOk(await setApplicationStatus(application.id, "accepted", { now: NOW }, db));

    expect(
      expectFail(await setApplicationStatus(application.id, "pending", { now: NOW }, db)).error
    ).toMatch(/pending/i);
  });

  it("refuses a manager withdrawing an application on the applicant's behalf", async () => {
    /*
     * The other state no decision may name. `withdrawApplication` is closed
     * against `declined → withdrawn`, but this is the second door into the
     * same room: a decision writing `withdrawn` over a declined row would let
     * `applyToEvent` readmit somebody R-122 says is out for good ("Beats
     * R-121" / UC-12 E1, E2), and the member would be back in the queue the
     * manager had just taken them out of.
     *
     * Driven from `declined` because that is the transition with the
     * consequence, and the row is read back: a refusal that had already
     * written would be worse than no refusal at all.
     */
    const event = await approvalEvent();
    const { userId, application } = await pendingApplication(event.id);
    expectOk(await setApplicationStatus(application.id, "declined", { now: NOW }, db));

    expect(
      expectFail(await setApplicationStatus(application.id, "withdrawn", { now: NOW }, db)).error
    ).toMatch(/only the applicant withdraws/i);
    expect(await queueFor(event.id)).toEqual({ [userId]: ["declined", null] });
  });

  it("hands the apply page an open event with nothing queued behind it", async () => {
    // What the form beside the submit button has to say (UC-12 7b) cannot be
    // read off `willWaitlist`: an approval event with every seat taken is still
    // open and still queues nobody, so the page has to be told the entry mode
    // separately or it promises a seat the manager has not given.
    const event = await approvalEvent();
    const seated = await pendingApplication(event.id);
    expectOk(await setApplicationStatus(seated.application.id, "accepted", { now: NOW }, db));

    const form = await loadApplicationForm(event.id, await makeUser(db), { now: NOW }, db);

    expect(entryMode(form?.event.config)).toBe("approval");
    expect(form?.state.open).toBe(true);
    expect(form?.state.open && form.state.willWaitlist).toBe(false);
  });

  it("lets the applicant withdraw while pending, promoting nobody", async () => {
    const event = await approvalEvent();
    const { userId } = await pendingApplication(event.id);

    const result = expectOk(await withdrawApplication(event.id, userId, db));

    expect(result.application.status).toBe("withdrawn");
    expect(result.promoted).toEqual([]);
  });
});

describe("setApplicationStatus", () => {
  it("declines a queued applicant without promoting anybody", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    const result = expectOk(
      await setApplicationStatus(queued?.id ?? "", "declined", { now: NOW }, db)
    );

    expect(result.promoted).toEqual([]);
    // Both seats still held: declining somebody who was only queueing frees
    // nothing.
    expect(result.seats.accepted).toBe(MIN_CAPACITY);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["accepted", null],
      [first]: ["declined", null],
      [second]: ["waitlisted", 1],
    });
  });

  // UC-14 5-6: "Manager declines another. System frees their seat, promotes the
  // next waitlisted, notifies both." Promoting used to be an option the screen
  // had to remember to pass, and an admin who closed the banner left the seat
  // empty with two people queueing for it. It is not an option any more.
  it("declining somebody who held a seat gives it to the front of the queue", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(
      await setApplicationStatus(holder?.id ?? "", "declined", { now: NOW }, db)
    );

    expect(result.promoted.map((row) => row.userId)).toEqual([first]);
    expect(result.seats.seatsLeft).toBe(0);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["declined", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
    });
  });

  // UC-14 5-6 by the other door: putting a seated applicant back on the queue
  // frees exactly the same seat (docs/diagrams/application-state.md,
  // "Accepted --> Waitlisted"), so it fills it the same way -- and the person
  // who gave it up goes to the back of the queue, not the front.
  it("queueing somebody who held a seat gives it to the front of the queue", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(
      await setApplicationStatus(holder?.id ?? "", "waitlisted", { now: NOW }, db)
    );

    expect(result.promoted.map((row) => row.userId)).toEqual([first]);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
      [seated]: ["waitlisted", 2],
    });
  });

  // The seat somebody is put back on the queue for is not a seat they may be
  // handed straight back. Without anybody else queueing there is a free seat
  // and a queue of exactly one -- them -- so a promotion computed over
  // everybody undoes the manager's decision inside the transaction that made
  // it, and the applicant ends the call accepted again.
  it("leaves the only seated applicant on the queue when a manager puts them there", async () => {
    const event = await openEvent({ capacity: MIN_CAPACITY });
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const result = expectOk(
      await setApplicationStatus(application.id, "waitlisted", { now: NOW }, db)
    );

    expect(result.promoted).toEqual([]);
    expect(await queueFor(event.id)).toEqual({ [userId]: ["waitlisted", 1] });
  });

  // Same rule, and the case that makes it load-bearing: an uncapped event has
  // no seat to run out of, so `promoteFromWaitlist` promotes the whole queue
  // there. Everybody except the person who just gave the seat up.
  it("does not hand an uncapped event's queue back the seat somebody just left", async () => {
    const event = await openEvent({ capacity: null });
    const seated = await makeUser(db);
    const other = await makeUser(db);
    const first = expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
    const second = expectOk(await applyToEvent(event.id, other, { now: hours(1) }, db));
    expectOk(await setApplicationStatus(second.id, "waitlisted", { now: NOW }, db));

    const result = expectOk(
      await setApplicationStatus(first.id, "waitlisted", { now: hours(2) }, db)
    );

    expect(result.promoted.map((row) => row.userId)).toEqual([other]);
    expect(await queueFor(event.id)).toEqual({
      [other]: ["accepted", null],
      [seated]: ["waitlisted", 1],
    });
  });

  // UC-14 3a: "Accepting goes over the cap - System asks the manager to confirm
  // going over; seat cap is not changed."
  it("refuses an accept that would go over the cap, and says what it would cost", async () => {
    const { event, first } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    const refusal = await setApplicationStatus(queued?.id ?? "", "accepted", { now: NOW }, db);

    expect(expectFail(refusal).error).toMatch(/over the cap/i);
    expect(refusal.ok === false && refusal.confirm).toEqual({
      kind: "over_capacity",
      capacity: MIN_CAPACITY,
      accepted: MIN_CAPACITY,
    });

    // The refusal is a question, not a rollback: nothing was written at all.
    expect((await rowsFor(event.id)).find((row) => row.userId === first)?.status).toBe(
      "waitlisted"
    );
  });

  // The confirmation is the server's, which is the whole reason it is not a
  // dialog: this call never went near the screen that asks.
  it("lets the confirmed second call through, and leaves the cap where it was", async () => {
    const { event, first } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    expectFail(await setApplicationStatus(queued?.id ?? "", "accepted", { now: NOW }, db));
    const result = expectOk(
      await setApplicationStatus(
        queued?.id ?? "",
        "accepted",
        { now: NOW, confirmOverCapacity: true },
        db
      )
    );

    expect(result.overCapacity).toBe(true);
    expect(result.seats.accepted).toBe(MIN_CAPACITY + 1);
    expect(result.seats.capacity).toBe(MIN_CAPACITY);
    expect(result.application.waitlistPosition).toBeNull();

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.capacity).toBe(MIN_CAPACITY);
  });

  // Re-affirming a status is not an accept. A manager saving a decision on
  // somebody already in must not be asked to confirm a seat they are sitting in.
  it("does not ask when the applicant already holds the seat", async () => {
    const { event, seated } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(
      await setApplicationStatus(holder?.id ?? "", "accepted", { now: NOW }, db)
    );
    expect(result.seats.accepted).toBe(MIN_CAPACITY);
    expect(result.overCapacity).toBe(false);
  });

  // ...and neither is an accept into a seat that is really there.
  it("does not ask when there is a spare seat", async () => {
    const event = await openEvent({ capacity: 2 });
    const seated = await makeUser(db);
    const other = await makeUser(db);
    expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
    const application = expectOk(await applyToEvent(event.id, other, { now: hours(1) }, db));
    expectOk(await setApplicationStatus(application.id, "waitlisted", { now: NOW }, db));

    const result = expectOk(
      await setApplicationStatus(application.id, "accepted", { now: hours(2) }, db)
    );
    expect(result.overCapacity).toBe(false);
    expect(result.seats.accepted).toBe(2);
  });

  it("records who decided, when, and any note", async () => {
    const event = await openEvent();
    const admin = await makeUser(db);
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const result = expectOk(
      await setApplicationStatus(
        application.id,
        "declined",
        { now: NOW, decidedBy: admin, note: "  Filling in for a mate  " },
        db
      )
    );

    expect(result.application.decidedBy).toBe(admin);
    expect(result.application.decidedAt).toEqual(NOW);
    expect(result.application.note).toBe("Filling in for a mate");
  });

  it("says so when the application has gone", async () => {
    const result = await setApplicationStatus(
      "00000000-0000-0000-0000-000000000000",
      "accepted",
      {},
      db
    );
    expect(expectFail(result).error).toMatch(/no longer exists/i);
  });
});

/* ------------------------------------------------------------------ */
/* Availability and confirmation                                      */
/* ------------------------------------------------------------------ */

describe("setAvailability", () => {
  it("writes a state per day and clears one with null", async () => {
    const event = await openEvent();
    const { days } = expectOk(
      await setEventDays(event.id, [{ label: "Fri" }, { label: "Sat" }], db)
    );
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const written = expectOk(
      await setAvailability(application.id, { [days[0].id]: "yes", [days[1].id]: "no" }, db)
    );
    expect(written.answers).toEqual({ [days[0].id]: "yes", [days[1].id]: "no" });
    expect([...written.changed].sort()).toEqual([days[0].id, days[1].id].sort());

    const cleared = expectOk(await setAvailability(application.id, { [days[1].id]: null }, db));
    expect(cleared.answers).toEqual({ [days[0].id]: "yes" });
    expect(cleared.changed).toEqual([days[1].id]);
  });

  it("reports nothing changed when the answers arrive exactly as they are stored", async () => {
    /*
     * Not a nicety: the admin action writes an audit line off `changed`, and
     * the Applicants tab posts an answer on every tap — including the tap that
     * picks the answer already showing. "Corrected an applicant's answers"
     * about a save that corrected nothing is a log entry that makes the real
     * ones harder to find, and an empty `byDay` used to produce one saying
     * "for 0 days".
     */
    const event = await openEvent();
    const { days } = expectOk(
      await setEventDays(event.id, [{ label: "Fri" }, { label: "Sat" }], db)
    );
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expectOk(await setAvailability(application.id, { [days[0].id]: "yes" }, db));

    const again = expectOk(await setAvailability(application.id, { [days[0].id]: "yes" }, db));
    expect(again.changed).toEqual([]);
    expect(again.answers).toEqual({ [days[0].id]: "yes" });

    const nothing = expectOk(await setAvailability(application.id, {}, db));
    expect(nothing.changed).toEqual([]);

    // Clearing a day that was never answered is not a change either.
    const blank = expectOk(await setAvailability(application.id, { [days[1].id]: null }, db));
    expect(blank.changed).toEqual([]);
  });

  it("overwrites an earlier answer for the same day", async () => {
    const event = await openEvent();
    const { days } = expectOk(await setEventDays(event.id, [{ label: "Fri" }], db));
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expectOk(await setAvailability(application.id, { [days[0].id]: "yes" }, db));
    const second = expectOk(await setAvailability(application.id, { [days[0].id]: "maybe" }, db));
    expect(second.answers).toEqual({ [days[0].id]: "maybe" });
    expect(second.changed).toEqual([days[0].id]);

    const rows = await db
      .select()
      .from(availability)
      .where(eq(availability.applicationId, application.id));
    expect(rows).toHaveLength(1);
  });

  it("refuses a day belonging to another event", async () => {
    const theirs = await makeEvent();
    const { days: theirDays } = expectOk(await setEventDays(theirs.id, [{ label: "Theirs" }], db));

    const mine = await openEvent();
    expectOk(await setEventDays(mine.id, [{ label: "Mine" }], db));
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(mine.id, userId, { now: NOW }, db));

    const result = await setAvailability(application.id, { [theirDays[0].id]: "yes" }, db);
    expect(expectFail(result).error).toMatch(/not part of this event/i);

    const rows = await db
      .select()
      .from(availability)
      .where(eq(availability.applicationId, application.id));
    expect(rows).toEqual([]);
  });
});

describe("setConfirmation", () => {
  it("records in, and keeps the seat", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const result = expectOk(await setConfirmation(application.id, "in", { now: NOW }, db));
    expect(result.state).toBe("in");
    expect(result.status).toBe("accepted");

    const [view] = await getApplicationsForEvent(event.id, db);
    expect(view.confirmation).toBe("in");
  });

  // UC-13 5a: "Applicant says they are not coming - System frees their seat,
  // promoting as in 3a." docs/diagrams/application-state.md draws it as one
  // edge with withdrawing, so this is the same departure by another name.
  it("frees the seat when somebody in it says they are not coming", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(await setConfirmation(holder?.id ?? "", "out", { now: NOW }, db));

    expect(result.state).toBe("out");
    expect(result.status).toBe("withdrawn");
    expect(result.promoted.map((row) => row.userId)).toEqual([first]);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["withdrawn", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
    });
  });

  it("keeps the answer on the row it freed, so the admin can see why", async () => {
    const event = await openEvent({ capacity: MIN_CAPACITY });
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expectOk(await setConfirmation(application.id, "out", { now: NOW }, db));

    const [view] = await getApplicationsForEvent(event.id, db);
    expect(view.status).toBe("withdrawn");
    expect(view.confirmation).toBe("out");
  });

  it("lets a waitlisted member say whether they are still interested", async () => {
    const { event, first } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);
    expect(expectOk(await setConfirmation(queued?.id ?? "", "in", { now: NOW }, db)).state).toBe("in");
  });

  // There is no seat to give up from the queue, the state diagram has no edge
  // for it, and one tap must not cost somebody a place they may still want.
  it("leaves a waitlisted member in the queue when they say they cannot make it", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    const result = expectOk(await setConfirmation(queued?.id ?? "", "out", { now: NOW }, db));

    expect(result.status).toBe("waitlisted");
    expect(result.promoted).toEqual([]);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["accepted", null],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });
  });

  it("refuses to confirm a withdrawn application", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expectOk(await withdrawApplication(event.id, userId, db));

    expect(expectFail(await setConfirmation(application.id, "in", { now: NOW }, db)).error).toMatch(
      /not active/i
    );
  });

  /*
   * UC-13 5b: "Applicant answers 'Not sure yet' - System records it and
   * changes nothing else: the seat is still theirs and nobody is promoted."
   *
   * The queued fixture, not a lone applicant, because the thing that must not
   * happen needs somebody for it to happen *to*. `out` from this exact seat
   * promotes `first` two tests above; the whole of R-199 is that `maybe` does
   * not, and against an empty waitlist both answers look identical.
   */
  it("keeps the seat and promotes nobody when somebody says they are not sure", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(await setConfirmation(holder?.id ?? "", "maybe", { now: NOW }, db));

    expect(result.state).toBe("maybe");
    expect(result.status).toBe("accepted");
    expect(result.promoted).toEqual([]);
    expect(await queueFor(event.id)).toEqual({
      [bystander]: ["accepted", null],
      [seated]: ["accepted", null],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });

    // And the admin can see it, which is the point of recording it at all.
    const views = await getApplicationsForEvent(event.id, db);
    expect(views.find((view) => view.userId === seated)?.confirmation).toBe("maybe");
  });

  /* --- the deadline (R-200, UC-13 7, 5c) -------------------------- */

  /** An event starting at `startsAt`, applied to by one member at `NOW`. */
  async function datedSeat(startsAt: Date | null) {
    const event = await datedEvent(startsAt);
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    return { event, userId, application };
  }

  const STARTS = new Date("2026-04-20T19:00:00.000Z");
  const DEADLINE = new Date("2026-04-18T19:00:00.000Z");
  const MINUTE = 60_000;

  it("reports when the answer closes, so the caller never computes it twice", async () => {
    const { application } = await datedSeat(STARTS);
    const result = expectOk(await setConfirmation(application.id, "in", { now: NOW }, db));
    expect(result.closesAt).toEqual(DEADLINE);
  });

  it("accepts an answer landing exactly on the deadline", async () => {
    const { application } = await datedSeat(STARTS);
    expect(expectOk(await setConfirmation(application.id, "in", { now: DEADLINE }, db)).state).toBe(
      "in"
    );
  });

  // UC-13 5c. The card stops offering the chips at the deadline, but the action
  // is a public POST, so the refusal has to be here or it is nowhere.
  it("refuses a minute after the deadline and leaves the last answer standing", async () => {
    const { event, application } = await datedSeat(STARTS);
    expectOk(await setConfirmation(application.id, "in", { now: new Date(DEADLINE.getTime() - MINUTE) }, db));

    const late = expectFail(
      await setConfirmation(application.id, "out", { now: new Date(DEADLINE.getTime() + MINUTE) }, db)
    );
    expect(late.error).toMatch(/closed two days before/i);
    // Nothing stored, and in particular the seat is still held: a refused
    // "I can't make it" must not half-happen.
    const [view] = await getApplicationsForEvent(event.id, db);
    expect(view.confirmation).toBe("in");
    expect(view.status).toBe("accepted");
  });

  // UC-13 7a, and `qa-undated-lan` in the local fixtures. An event nobody has
  // scheduled has no deadline, so reading its null start as "closed" would lock
  // its applicants out forever.
  it("still lets a member answer an event with no start date", async () => {
    const { application } = await datedSeat(null);

    const far = new Date("2099-01-01T00:00:00.000Z");
    expect(expectOk(await setConfirmation(application.id, "maybe", { now: far }, db)).state).toBe(
      "maybe"
    );
    expect(expectOk(await setConfirmation(application.id, "in", { now: far }, db)).closesAt).toBeNull();
  });

  // UC-13 extensions E3, and the reason locking the answer is acceptable at
  // all: somebody taken ill the day before still gives their seat up.
  it("leaves withdrawing open after the answer has closed", async () => {
    // Two seats is the smallest cap R-26 allows, so the seat the withdrawal
    // frees is the second one and `filler` is sitting in the first.
    const event = await datedEvent(STARTS, { capacity: MIN_CAPACITY });
    const filler = await makeUser(db);
    const seated = await makeUser(db);
    const queued = await makeUser(db);
    expectOk(await applyToEvent(event.id, filler, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, queued, { now: hours(1) }, db));

    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);
    expectFail(
      await setConfirmation(holder?.id ?? "", "out", { now: new Date(STARTS.getTime() - MINUTE) }, db)
    );

    const out = expectOk(await withdrawApplication(event.id, seated, db));
    expect(out.promoted.map((row) => row.userId)).toEqual([queued]);
    expect(await queueFor(event.id)).toEqual({
      [filler]: ["accepted", null],
      [seated]: ["withdrawn", null],
      [queued]: ["accepted", null],
    });
  });
});

/* ------------------------------------------------------------------ */
/* Reads                                                              */
/* ------------------------------------------------------------------ */

describe("reads for the pages", () => {
  it("lists events by status", async () => {
    const published = await openEvent({ title: "Listed and published" });
    const listed = await listEvents({ status: "published", now: NOW }, db);
    expect(listed.some((event) => event.id === published.id)).toBe(true);
    expect(listed.every((event) => event.status === "published")).toBe(true);
  });

  it("splits what is coming up from what has been and gone", async () => {
    // The dates are the days' (R-24), so this is what "soonest first" and the
    // archive split now read.
    const soon = await datedEvent(hours(48), { title: "Coming up" });
    const done = await datedEvent(hours(-48), { title: "Long gone" });

    const upcoming = await listEvents({ upcoming: true, now: NOW }, db);
    const past = await listEvents({ upcoming: false, now: NOW }, db);

    expect(upcoming.map((event) => event.id)).toContain(soon.id);
    expect(upcoming.map((event) => event.id)).not.toContain(done.id);
    expect(past.map((event) => event.id)).toContain(done.id);
  });

  it("counts the seats and works out whether applications are open", async () => {
    const event = await openEvent({ title: "Counted", capacity: 2 });
    const a = await makeUser(db);
    const b = await makeUser(db);
    const c = await makeUser(db);
    expectOk(await applyToEvent(event.id, a, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, b, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, c, { now: NOW }, db));

    const [summary] = (await listEvents({ now: NOW }, db)).filter((row) => row.id === event.id);
    expect(summary.seats).toMatchObject({ accepted: 2, waitlisted: 1, seatsLeft: 0, full: true });
    expect(summary.applicationsState.open).toBe(true);
    if (!summary.applicationsState.open) return;
    expect(summary.applicationsState.willWaitlist).toBe(true);
  });

  it("gets an event by slug, with its days, questions and choices", async () => {
    const event = await openEvent({ title: "By slug", gameId: rivalsId });
    expectOk(await setEventDays(event.id, [{ label: "Fri" }], db));
    expectOk(await addQuestions(event.id, [{ label: "Rank on the night", type: "rank" }]));

    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.days).toHaveLength(1);
    expect(detail?.questions).toHaveLength(1);
    expect(detail?.questions[0].choices).toHaveLength(RIVALS_RANK_LADDER.length);
    expect(detail?.rankLadder[0]).toBe(RIVALS_RANK_LADDER[0]);
    expect(detail?.game?.name).toBe("Marvel Rivals");
  });

  it("returns nothing for a slug nobody holds", async () => {
    expect(await getEventBySlug("no-such-event", { now: NOW }, db)).toBeNull();
  });

  it("lists applicants seated first, then the queue in its own order", async () => {
    const { event, bystander, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === second);
    expectOk(await setApplicationStatus(queued?.id ?? "", "declined", { now: NOW }, db));

    const applicants = await getApplicationsForEvent(event.id, db);
    // The two seats in submission order, then the queue, then the decided —
    // `bystander` holds the first seat (see `lastSeatEvent`).
    expect(applicants.map((row) => [row.userId, row.status])).toEqual([
      [bystander, "accepted"],
      [seated, "accepted"],
      [first, "waitlisted"],
      [second, "declined"],
    ]);
    expect(applicants[0].member.displayName).toBeTruthy();
  });

  it("hands the admin each applicant's rank and whether they can captain", async () => {
    const event = await openEvent({
      gameId: rivalsId,
      minRankToEnter: "Platinum III",
      minRankToCaptain: "Diamond II",
    });
    const strong = await makeUser(db);
    const weak = await makeUser(db);
    await setProfileValue(strong, rankFieldId, "Diamond I");
    await setProfileValue(weak, rankFieldId, "Platinum I");
    expectOk(await applyToEvent(event.id, strong, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, weak, { now: hours(1) }, db));

    const applicants = await getApplicationsForEvent(event.id, db);
    const byUser = new Map(applicants.map((row) => [row.userId, row]));
    expect(byUser.get(strong)?.rank).toBe("Diamond I");
    expect(byUser.get(strong)?.eligibility.canCaptain).toBe(true);
    expect(byUser.get(weak)?.eligibility.canCaptain).toBe(false);
    expect(byUser.get(weak)?.eligibility.captainReason).toContain("Diamond II");
  });

  it("returns nothing for an event that has gone", async () => {
    expect(
      await getApplicationsForEvent("00000000-0000-0000-0000-000000000000", db)
    ).toEqual([]);
  });

  it("lists a member's own applications with the event attached", async () => {
    const userId = await makeUser(db);
    const soon = await datedEvent(hours(24), { title: "Mine, soon" });
    const later = await datedEvent(hours(72), { title: "Mine, later" });
    expectOk(await applyToEvent(later.id, userId, { now: NOW }, db));
    expectOk(await applyToEvent(soon.id, userId, { now: NOW }, db));

    const mine = await getMyApplications(userId, { now: NOW }, db);
    expect(mine.map((row) => row.event.id)).toEqual([soon.id, later.id]);
    expect(mine[0].seats.accepted).toBe(1);
  });

  it("gives the member's profile back, with the gate already worked out", async () => {
    // UC-12 2. The profile section carries the saved answers; the event's own
    // questions carry theirs. The linked question is **not** in `questions` —
    // the profile detail behind it is what the member is shown (`ownQuestions`).
    const event = await openEvent({
      gameId: rivalsId,
      minRankToEnter: "Platinum III",
      signupClosesAt: hours(6),
    });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
        { label: "Anything else", type: "text" },
      ])
    );
    expectOk(await setEventDays(event.id, [{ label: "Fri" }], db));

    const userId = await makeUser(db);
    await setProfileValue(userId, rankFieldId, "Diamond III");
    await setProfileValue(userId, roleFieldId, "vanguard");

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.state.open).toBe(true);
    expect(form?.eligibility.canEnter).toBe(true);
    expect(form?.rank).toBe("Diamond III");
    expect(form?.application).toBeNull();
    expect(form?.canEditAnswers).toBe(false);

    expect(form?.questions.map((question) => question.id)).toEqual([questions[1].id]);
    expect(form?.questions[0].value).toBeNull();

    const role = detailIn(form, roleFieldId);
    expect(role?.value).toBe("vanguard");
    expect(role?.attention).toBeNull();
  });

  it("reads a linked answer out of the profile, not a copy on the application", async () => {
    /*
     * Task 10's title, tested: *profile stays the source*. The member applies
     * with one role, then changes it on their profile — and the application
     * reads the new one, because there was never a second copy to go stale.
     */
    const event = await openEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
      ])
    );

    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "vanguard");
    const application = expectOk(
      await applyToEvent(event.id, userId, { now: NOW, details: { [roleFieldId]: "duelist" } }, db)
    );

    // The answer the member gave on the form went to the profile, and nothing
    // was written under the question's id.
    expect(application.answers[questions[0].id]).toBe("duelist");
    expect(await storedAnswers(event.id, userId)).toEqual({});
    expect(await storedProfileValue(userId, roleFieldId)).toBe("duelist");

    // Changed on `/me/profile` afterwards, with no application write at all.
    await setProfileValue(userId, roleFieldId, "strategist");
    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.application?.answers[questions[0].id]).toBe("strategist");
    expect(detailIn(form, roleFieldId)?.value).toBe("strategist");
    expect(form?.canEditAnswers).toBe(true);
  });

  it("works for a signed-out visitor, with no answers and no gate opinion", async () => {
    const event = await openEvent({ gameId: rivalsId, minRankToEnter: "Platinum III" });
    const form = await loadApplicationForm(event.id, null, { now: NOW }, db);
    expect(form?.application).toBeNull();
    expect(form?.rank).toBeNull();
    expect(form?.eligibility.canEnter).toBe(false);
  });

  it("returns nothing for an event that is not there", async () => {
    expect(
      await loadApplicationForm("00000000-0000-0000-0000-000000000000", null, { now: NOW }, db)
    ).toBeNull();
  });

  it("explains a closed event to the page rather than just refusing", async () => {
    const event = await openEvent({ signupClosesAt: hours(-1) });
    const form = await loadApplicationForm(event.id, await makeUser(db), { now: NOW }, db);
    expect(form?.state.open).toBe(false);
    if (form?.state.open !== false) return;
    expect(form.state.reason).toBe("signups_closed");
  });
});

/* ------------------------------------------------------------------ */
/* Whole-flow sanity                                                  */
/* ------------------------------------------------------------------ */

describe("a whole event, end to end", () => {
  it("runs from draft to a seated roster with a queue behind it", async () => {
    const event = await makeEvent({
      title: "Spring Rivals Cup",
      gameId: rivalsId,
      capacity: 2,
      minRankToEnter: "Gold III",
      signupOpensAt: hours(-1),
      signupClosesAt: hours(6),
      days: [
        { label: "Saturday", startsAt: hours(24) },
        { label: "Sunday", startsAt: hours(48) },
      ],
    });

    expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          required: true,
          profileFieldId: roleFieldId,
        },
      ])
    );

    // Nobody can apply while it is still a draft.
    const early = await makeUser(db);
    expect(expectFail(await applyToEvent(event.id, early, { now: NOW }, db)).error).toMatch(
      /published/i
    );

    expectOk(await publishEvent(event.id, db));

    const members = await Promise.all([makeUser(db), makeUser(db), makeUser(db)]);
    for (const [index, userId] of members.entries()) {
      await setProfileValue(userId, rankFieldId, "Diamond III");
      await setProfileValue(userId, roleFieldId, ROLE_OPTIONS[index].value);
      expectOk(await applyToEvent(event.id, userId, { now: hours(index) }, db));
    }

    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.seats).toMatchObject({ accepted: 2, waitlisted: 1, seatsLeft: 0 });

    // The first seat-holder pulls out; the queue moves up on its own.
    expectOk(await withdrawApplication(event.id, members[0], db));
    expect(await queueFor(event.id)).toEqual({
      [members[0]]: ["withdrawn", null],
      [members[1]]: ["accepted", null],
      [members[2]]: ["accepted", null],
    });

    const after = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(after?.seats).toMatchObject({ accepted: 2, waitlisted: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 10c: each rule refused by name, and nothing saved            */
/* ------------------------------------------------------------------ */

/**
 * The four things a setup save is refused for, and the one thing every one of
 * them has in common: nothing is written.
 *
 * UC-08 10c names them in one line — "sign-ups close after the first day
 * starts, days overlap, cap below 2, or a choice question has no options" —
 * and the last of those is already `setEventQuestions`'s ("a pick-one or
 * pick-any question needs at least one option", tested above). These are the
 * other three, each asserted twice: the sentence names the problem, and the
 * row still holds what it held.
 */
describe("the setup rules (UC-08 10, 10c)", () => {
  /** An event with one dated day and a window that closes as it starts. */
  async function dayAndWindow(startsAt: Date): Promise<EventRow> {
    return makeEvent({
      title: `Rules ${titleCounter + 1}`,
      signupOpensAt: hours(-24),
      signupClosesAt: startsAt,
      days: [{ startsAt }],
    });
  }

  async function dayTimes(eventId: string): Promise<Array<number | null>> {
    const rows = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, eventId))
      .orderBy(asc(eventDays.dayIndex));
    return rows.map((row) => row.startsAt?.getTime() ?? null);
  }

  /* --- sign-ups close no later than the first day (R-25) ---------- */

  it("refuses a closing time past the first day's start, and saves nothing", async () => {
    const event = await dayAndWindow(hours(48));

    const refused = expectFail(
      await updateEvent(event.id, { signupClosesAt: hours(72) }, db)
    );
    expect(refused.error).toMatch(/close them no later than the start/i);

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.signupClosesAt).toEqual(hours(48));
  });

  // The same rule from the other direction: the pair is what has to make
  // sense, so whichever save broke it is the one refused. Writing the days and
  // leaving the window impossible would be the same mistake through the other
  // door.
  it("refuses a first day pulled back behind the closing time, and saves nothing", async () => {
    const event = await dayAndWindow(hours(48));

    const refused = expectFail(
      await setEventDays(event.id, [{ startsAt: hours(24) }], db)
    );
    expect(refused.error).toMatch(/close them no later than the start/i);
    expect(await dayTimes(event.id)).toEqual([hours(48).getTime()]);
  });

  it("allows a first day exactly on the closing time", async () => {
    const event = await dayAndWindow(hours(48));
    expectOk(await setEventDays(event.id, [{ startsAt: hours(48) }], db));
    expect(await dayTimes(event.id)).toEqual([hours(48).getTime()]);
  });

  /* --- days ordered and non-overlapping (R-24) -------------------- */

  it("refuses two days that start at the same moment, and saves nothing", async () => {
    const event = await dayAndWindow(hours(48));

    const refused = expectFail(
      await setEventDays(event.id, [{ startsAt: hours(48) }, { startsAt: hours(48) }], db)
    );
    expect(refused.error).toMatch(/at the same time as Day 1/i);
    // Still the one day it had: not the two it was asked for, and not one of
    // them written before the refusal landed.
    expect(await dayTimes(event.id)).toEqual([hours(48).getTime()]);
  });

  it("refuses days that run backwards, and saves nothing", async () => {
    const event = await dayAndWindow(hours(48));

    const refused = expectFail(
      await setEventDays(
        event.id,
        [{ startsAt: hours(48) }, { startsAt: hours(96), label: "Sunday" }, { startsAt: hours(72) }],
        db
      )
    );
    expect(refused.error).toMatch(/Day 3 starts before Sunday/i);
    expect(await dayTimes(event.id)).toEqual([hours(48).getTime()]);
  });

  it("keeps a day whose time is still to be agreed out of the comparison", async () => {
    const event = await dayAndWindow(hours(48));
    expectOk(
      await setEventDays(
        event.id,
        [{ startsAt: hours(48) }, { startsAt: null }, { startsAt: hours(72) }],
        db
      )
    );
    expect(await dayTimes(event.id)).toEqual([hours(48).getTime(), null, hours(72).getTime()]);
  });

  /* --- at least two seats (R-26) ---------------------------------- */

  it("refuses a cap below two on creation, and saves nothing", async () => {
    const refused = expectFail(
      await createEvent({ title: "Just me", capacity: 1 }, db)
    );
    expect(refused.error).toMatch(/at least 2 seats/);
    expect(await db.select().from(events).where(eq(events.title, "Just me"))).toHaveLength(0);
  });

  it("refuses a cap below two on an edit, and leaves the cap where it was", async () => {
    const event = await makeEvent({ title: "Cap edit", capacity: 8 });

    expect(expectFail(await updateEvent(event.id, { capacity: 1 }, db)).error).toMatch(
      /at least 2 seats/
    );

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row.capacity).toBe(8);
  });

  it("takes the minimum, and takes no cap at all", async () => {
    expect((await makeEvent({ title: "Pair", capacity: MIN_CAPACITY })).capacity).toBe(
      MIN_CAPACITY
    );
    // UC-08 E5: "no cap" is advice, not a refusal — an uncapped event is a
    // supported setup, and "at least two" must not quietly outlaw it.
    expect((await makeEvent({ title: "Uncapped", capacity: null })).capacity).toBeNull();
    const event = await makeEvent({ title: "Cap cleared", capacity: 4 });
    expect(expectOk(await updateEvent(event.id, { capacity: null }, db)).capacity).toBeNull();
  });

  /*
   * A cap of one was legal before R-26's minimum was enforced, so deployed
   * rows may hold one (which is why there is no database constraint — see
   * `MIN_CAPACITY`). Such an event still has to be publishable, cancellable
   * and completable: the rule is checked on the capacity a save is *writing*,
   * not on the one the row happens to carry.
   */
  it("leaves an event that already holds a one-seat cap alone until somebody writes one", async () => {
    const event = await makeEvent({ ...PUBLISHABLE, title: "Legacy single seat" });
    await db.update(events).set({ capacity: 1 }).where(eq(events.id, event.id));

    const published = expectOk(await updateEvent(event.id, { status: "published" }, db));
    expect(published.status).toBe("published");
    expect(published.capacity).toBe(1);

    const renamed = expectOk(await updateEvent(event.id, { title: "Legacy, renamed" }, db));
    expect(renamed.capacity).toBe(1);

    // The rest of the lifecycle, which is the whole of what "can still be
    // published, cancelled and completed" claims: running it, finishing it, and
    // the reopen that is the one write a finished event accepts (UC-09 6a).
    expect(expectOk(await updateEvent(event.id, { status: "live" }, db)).status).toBe("live");
    expect(expectOk(await updateEvent(event.id, { status: "complete" }, db)).status).toBe(
      "complete"
    );
    const reopened = expectOk(await updateEvent(event.id, { status: "live" }, db));
    expect(reopened.status).toBe("live");
    expect(reopened.capacity).toBe(1);

    /*
     * And the save the Basics panel sends: every field on that tab, as the
     * panel renders them. `saveBasicsAction` leaves the cap out when the
     * manager did not move it, precisely so this goes through — an
     * unconditional `capacity: 1` here refuses a rename until the manager
     * raises the cap, and raising it promotes somebody off the waitlist.
     */
    const basics = expectOk(
      await updateEvent(
        event.id,
        {
          title: "Legacy, described",
          slug: renamed.slug,
          type: renamed.type,
          description: "A typo fixed, nothing else.",
          bannerUrl: renamed.bannerUrl,
          gameId: renamed.gameId,
          config: renamed.config,
          signupOpensAt: renamed.signupOpensAt,
          signupClosesAt: renamed.signupClosesAt,
        },
        db
      )
    );
    expect(basics.description).toBe("A typo fixed, nothing else.");
    expect(basics.capacity).toBe(1);

    // Touch the cap, though, and the minimum applies.
    expect(expectFail(await updateEvent(event.id, { capacity: 1 }, db)).error).toMatch(
      /at least 2 seats/
    );
  });

  // `cancelled` is terminal, so it needs an event of its own rather than a
  // sixth step above.
  it("cancels an event holding a one-seat cap", async () => {
    const event = await makeEvent({ ...PUBLISHABLE, title: "Legacy, called off" });
    await db.update(events).set({ capacity: 1 }).where(eq(events.id, event.id));

    expectOk(await updateEvent(event.id, { status: "published" }, db));
    const cancelled = expectOk(await updateEvent(event.id, { status: "cancelled" }, db));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.capacity).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* R-24: an event's dates are its days'                               */
/* ------------------------------------------------------------------ */

/**
 * Start and end, derived on every read (Task 12).
 *
 * There is no `starts_at` to read any more, so these are the tests that the
 * answer every screen shows comes from the day list — and, more importantly,
 * that it *follows* the day list when a manager moves it (UC-08 4). The
 * columns are still on the row until the follow-up commit drops them, which is
 * why one of these writes a disagreeing value straight into the database and
 * checks that nobody believes it.
 */
describe("an event's dates come from its days (R-24, UC-11 2)", () => {
  it("starts at the first day and ends at the last", async () => {
    const event = await makeEvent({
      title: "Three nights",
      signupOpensAt: hours(-24),
      signupClosesAt: hours(24),
      days: [
        { startsAt: hours(24), label: "Friday" },
        { startsAt: hours(48), label: "Saturday" },
        { startsAt: hours(72), label: "Sunday" },
      ],
    });

    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.startsAt).toEqual(hours(24));
    expect(detail?.endsAt).toEqual(hours(72));
    // UC-11 2: the overview lists every day, so the page is given all of them.
    expect(detail?.days.map((day) => day.label)).toEqual(["Friday", "Saturday", "Sunday"]);
  });

  it("has no end when it runs for one evening", async () => {
    const event = await datedEvent(hours(24), { title: "One night" });
    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.startsAt).toEqual(hours(24));
    expect(detail?.endsAt).toBeNull();
  });

  it("moves when the days move", async () => {
    const event = await datedEvent(hours(24), { title: "Moved" });
    expectOk(
      await setEventDays(event.id, [{ startsAt: hours(96) }, { startsAt: hours(120) }], db)
    );

    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.startsAt).toEqual(hours(96));
    expect(detail?.endsAt).toEqual(hours(120));
  });

  /*
   * The two columns are dead and this is what "dead" has to mean: a value
   * sitting in them — left behind by a row written before the change, or by
   * the backfill in drizzle/0020 — must not reach a countdown, a listing order
   * or the answer deadline. Written straight to the database because nothing in
   * the library will put a value there any more.
   */
  it("ignores a stale value left in the old columns", async () => {
    const event = await datedEvent(hours(24), { title: "Stale column" });
    await db
      .update(events)
      .set({ startsAt: hours(-500), endsAt: hours(-400) })
      .where(eq(events.id, event.id));

    const detail = await getEventBySlug(event.slug, { now: NOW }, db);
    expect(detail?.startsAt).toEqual(hours(24));
    expect(detail?.endsAt).toBeNull();
    // And it is still listed as coming up, which reading the column would not
    // have been (R-40, R-41).
    const upcoming = await listEvents({ upcoming: true, now: NOW }, db);
    expect(upcoming.map((row) => row.id)).toContain(event.id);
  });

  // R-41, UC-10 4: "lists matching published events, soonest first" — ordered
  // by the first day now, with an event nobody has scheduled last, because it
  // is not coming up sooner than everything else.
  it("lists events soonest first, with the undated ones last", async () => {
    const title = `Order ${Date.now()}`;
    const late = await datedEvent(hours(200), { title: `${title} late` });
    const early = await datedEvent(hours(100), { title: `${title} early` });
    const undated = await datedEvent(null, { title: `${title} undated` });

    const listed = (await listEvents({ status: "published", now: NOW }, db))
      .filter((row) => row.title.startsWith(title))
      .map((row) => row.id);
    expect(listed).toEqual([early.id, late.id, undated.id]);
  });

  // Task 48, R-110 / UC-27 3: what `/admin/audit`'s filter reads instead of
  // `listEvents` — the same events in the same order, with none of the seat
  // counting a `<select>` would throw away.
  it("lists every event as nothing but an id and a title, in the same order", async () => {
    const title = `Options ${Date.now()}`;
    const late = await datedEvent(hours(200), { title: `${title} late` });
    const early = await datedEvent(hours(100), { title: `${title} early` });
    // Unpublished, and `PUBLISHABLE`'s day puts it after both of the above.
    const draft = await makeEvent({ ...PUBLISHABLE, title: `${title} draft` });

    const options = (await listEventOptions(db)).filter((row) =>
      row.title.startsWith(title)
    );

    // The draft is in it on purpose: a log is asked about events that never
    // ran, so nothing a public list leaves out may be unreachable here.
    expect(options.map((row) => row.id)).toEqual([early.id, late.id, draft.id]);
    expect(options[0]).toEqual({ id: early.id, title: `${title} early` });
  });

  // R-200, UC-13 7: the answer closes two days before the start, and the start
  // is the first day's — so moving the first day moves the deadline, with no
  // stored copy to disagree.
  it("closes the answer two days before the first day, wherever that day moves to", async () => {
    const event = await datedEvent(hours(100), { title: "Deadline follows" });
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const first = expectOk(await setConfirmation(application.id, "in", { now: NOW }, db));
    expect(first.closesAt).toEqual(hours(100 - 48));

    expectOk(await setEventDays(event.id, [{ startsAt: hours(200) }], db));
    const moved = expectOk(await setConfirmation(application.id, "in", { now: NOW }, db));
    expect(moved.closesAt).toEqual(hours(200 - 48));
  });

  // UC-13 7a: an event nobody has scheduled has no deadline at all — and now
  // that the start is the days' answer, "no start" is "no dated day".
  it("gives an event with no dated day no deadline", async () => {
    const event = await datedEvent(null, { title: "No deadline" });
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const far = new Date("2099-01-01T00:00:00.000Z");
    expect(expectOk(await setConfirmation(application.id, "in", { now: far }, db)).closesAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Changing answers while sign-ups are open (R-53 / UC-13 3, 4, 4a)   */
/* ------------------------------------------------------------------ */

/**
 * The half of Task 10 that is a rule rather than a screen.
 *
 * Two deadlines and one thing with no deadline at all, and the whole file turns
 * on keeping them apart:
 *
 *  - **answers** close when sign-ups do (UC-13 4a);
 *  - the **attendance answer** closes two days before the start (R-200,
 *    UC-13 7) — a different instant, tested in its own describe below;
 *  - **withdrawing** closes neither (R-54, UC-13 4a, UC-13 extensions E3).
 *
 * The acceptance criterion most likely to be got wrong is the third, because
 * the tidy-looking refactor is one guard for all of them, and it reads as a
 * simplification right up until somebody taken ill the day before an event
 * cannot give their seat up.
 */
describe("editing an application", () => {
  /** An open event with one question of its own and one linked detail. */
  async function editable(over: Partial<CreateEventInput> = {}) {
    const event = await openEvent({ gameId: rivalsId, ...over });
    const { questions } = expectOk(
      await addQuestions(event.id, [
        { label: "Anything else", type: "text" },
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          profileFieldId: roleFieldId,
        },
      ])
    );
    return { event, own: questions[0], linked: questions[1] };
  }

  it("saves a changed answer and a changed detail", async () => {
    // UC-13 3-4: "Applicant changes an answer while sign-ups are open. System
    // saves it." The detail lands on the profile, the event's own answer on the
    // application — one answer each, in the one place it belongs.
    const { event, own, linked } = await editable();
    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "vanguard");
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const edited = expectOk(
      await editApplicationAnswers(
        event.id,
        userId,
        { now: hours(1), answers: { [own.id]: "Bringing a spare keyboard" }, details: { [roleFieldId]: "duelist" } },
        db
      )
    );

    expect(edited.answers[own.id]).toBe("Bringing a spare keyboard");
    expect(edited.answers[linked.id]).toBe("duelist");
    expect(await storedProfileValue(userId, roleFieldId)).toBe("duelist");
    // Still exactly one copy: the linked answer is not on the application.
    expect(await storedAnswers(event.id, userId)).toEqual({
      [own.id]: "Bringing a spare keyboard",
    });
  });

  /** The legacy row Task 10 left behind: a stored copy under a linked id. */
  async function plantLegacyCopy(
    eventId: string,
    userId: string,
    answers: Record<string, unknown>
  ) {
    const row = (await rowsFor(eventId)).find((candidate) => candidate.userId === userId);
    await db
      .update(applications)
      .set({ answers: answers as never })
      .where(eq(applications.id, row?.id as string));
  }

  it("reads the profile's answer over a legacy copy, and the next write clears it", async () => {
    /*
     * The row an `applyToEvent` from before Task 10 left behind: an answer
     * stored under a *linked* question's id, beside the profile answer that is
     * now the only home for it. `decorate` drops it from the view rather than
     * merging it, because the profile is the source and a copy that disagrees
     * must not be what a manager reads — and the next write to the application
     * takes it out of the column, because `validateAnswers` is given
     * `ownQuestions` and replaces the whole map.
     *
     * Planted by hand because nothing can write one any more, which is exactly
     * why it needs a test: the behaviour was proved once by experiment and
     * nothing held it.
     */
    const { event, own, linked } = await editable();
    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "strategist");
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, answers: { [own.id]: "As submitted" } },
        db
      )
    );

    await plantLegacyCopy(event.id, userId, {
      [own.id]: "As submitted",
      [linked.id]: "vanguard",
    });
    expect(await storedAnswers(event.id, userId)).toEqual({
      [own.id]: "As submitted",
      [linked.id]: "vanguard",
    });

    // What the manager's list and the member's own page read: the profile.
    const [applicant] = await getApplicationsForEvent(event.id, db);
    expect(applicant.answers[linked.id]).toBe("strategist");
    expect((await getMyApplications(userId, { now: NOW }, db))[0].answers[linked.id]).toBe(
      "strategist"
    );

    // And the next write to the application takes the copy out of the column.
    expectOk(
      await editApplicationAnswers(
        event.id,
        userId,
        { now: hours(1), answers: { [own.id]: "As submitted" } },
        db
      )
    );
    expect(await storedAnswers(event.id, userId)).toEqual({ [own.id]: "As submitted" });
  });

  it("shows nothing under a linked question when only the legacy copy exists", async () => {
    /*
     * The case that tells a drop from a merge, and the reason the drop is not
     * merely tidier. With no profile answer there is nothing to compose, so a
     * merge would let the legacy copy through — and a manager would be reading
     * "vanguard" as the member's preferred role from a column the member can no
     * longer edit, while `/me/profile` shows them an unanswered question.
     *
     * The stale copy is also what `detailAttention` has to be able to see is
     * missing: a composed answer that came from nowhere would hide a required
     * detail the member still has to give.
     */
    const { event, own, linked } = await editable();
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    await plantLegacyCopy(event.id, userId, { [linked.id]: "vanguard" });

    const [applicant] = await getApplicationsForEvent(event.id, db);
    expect(applicant.answers[linked.id]).toBeUndefined();
    expect(applicant.answers).toEqual({});
    // The member's page agrees, and asks them for the detail instead.
    const [mine] = await getMyApplications(userId, { now: NOW }, db);
    expect(mine.answers[linked.id]).toBeUndefined();
    expect(mine.answers[own.id]).toBeUndefined();
  });

  it("refuses an edit once sign-ups have closed, and writes nothing", async () => {
    /*
     * UC-13 4a, enforced on the server. The form has gone from the page by
     * then, which proves nothing: a server action is a public POST endpoint, so
     * this is a direct call made after the deadline — the only kind that can
     * actually happen — and it has to be refused *and* leave the stored answer
     * and the profile exactly as they were.
     */
    const { event, own } = await editable({ signupClosesAt: hours(-1) });
    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "vanguard");
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: hours(-2), answers: { [own.id]: "As submitted" } },
        db
      )
    );

    const refused = await editApplicationAnswers(
      event.id,
      userId,
      { now: NOW, answers: { [own.id]: "Changed my mind" }, details: { [roleFieldId]: "duelist" } },
      db
    );

    expect(expectFail(refused).error).toMatch(/closed/i);
    // The refusal names the way out, because the way out is what makes closing
    // the answer acceptable (R-54).
    expect(expectFail(refused).error).toMatch(/withdraw/i);
    expect(await storedAnswers(event.id, userId)).toEqual({ [own.id]: "As submitted" });
    expect(await storedProfileValue(userId, roleFieldId)).toBe("vanguard");
  });

  it("still lets them withdraw after sign-ups have closed", async () => {
    /*
     * The criterion. R-54, UC-13 4a and UC-13 extensions E3 all say the same
     * thing: *withdrawing is still allowed*. Somebody taken ill the day before
     * can no longer change a word of their application and can still give up
     * the seat, which is the part everybody behind them is waiting for — so the
     * seat frees and the queue moves, on the same closed event that has just
     * refused an edit.
     */
    const { event } = await editable({ capacity: MIN_CAPACITY, signupClosesAt: hours(-1) });
    const seated = await makeUser(db);
    const alsoSeated = await makeUser(db);
    const queued = await makeUser(db);
    for (const [index, member] of [seated, alsoSeated, queued].entries()) {
      expectOk(await applyToEvent(event.id, member, { now: hours(-3 + index) }, db));
    }

    // Edits are shut on this event, for this member, at this instant.
    expect(
      expectFail(await editApplicationAnswers(event.id, seated, { now: NOW }, db)).error
    ).toMatch(/closed/i);

    const result = expectOk(await withdrawApplication(event.id, seated, db));
    expect(result.application.status).toBe("withdrawn");
    expect(result.promoted.map((row) => row.userId)).toEqual([queued]);
    expect(await queueFor(event.id)).toEqual({
      [seated]: ["withdrawn", null],
      [alsoSeated]: ["accepted", null],
      [queued]: ["accepted", null],
    });
  });

  it("lets an applicant edit a full event that has stopped taking applications", async () => {
    /*
     * `applicationsOpen` answers "would a *new* application be taken?", and for
     * a full event with the waitlist switched off (R-170, UC-12 E3) that is no.
     * The member doing the editing is not a new application, and sign-ups have
     * not closed — reusing that verdict here would lock everybody in a full
     * event out of fixing a typo for a reason that is nothing to do with them.
     */
    const { event, own } = await editable({
      capacity: MIN_CAPACITY,
      config: { waitlist: false },
    });
    const first = await makeUser(db);
    const second = await makeUser(db);
    expectOk(await applyToEvent(event.id, first, { now: NOW }, db));
    expectOk(await applyToEvent(event.id, second, { now: NOW }, db));

    const form = await loadApplicationForm(event.id, first, { now: NOW }, db);
    expect(form?.state.open).toBe(false);
    if (form?.state.open === false) expect(form.state.reason).toBe("full");
    expect(form?.canEditAnswers).toBe(true);

    expectOk(
      await editApplicationAnswers(
        event.id,
        first,
        { now: NOW, answers: { [own.id]: "Still in" } },
        db
      )
    );
    expect(await storedAnswers(event.id, first)).toEqual({ [own.id]: "Still in" });
  });

  it("refuses every change once the event is complete", async () => {
    // UC-13 3b. `lockRefusal` is the one rule for a finished event's record,
    // and it is the one thing that closes withdrawing too.
    const { event, own } = await editable();
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    // The drawn path: published → live → complete (diagrams/event-state.md).
    expectOk(await updateEvent(event.id, { status: "live" }, db));
    expectOk(await updateEvent(event.id, { status: "complete" }, db));

    expect(
      expectFail(
        await editApplicationAnswers(
          event.id,
          userId,
          { now: NOW, answers: { [own.id]: "Too late" } },
          db
        )
      ).error
    ).toMatch(/finished/i);
    expect(await storedAnswers(event.id, userId)).toEqual({});
  });

  it("refuses somebody with no open application", async () => {
    const { event, own } = await editable();
    const stranger = await makeUser(db);
    expect(
      expectFail(await editApplicationAnswers(event.id, stranger, { now: NOW }, db)).error
    ).toMatch(/not applied/i);

    const gone = await makeUser(db);
    expectOk(await applyToEvent(event.id, gone, { now: NOW }, db));
    expectOk(await withdrawApplication(event.id, gone, db));
    expect(
      expectFail(
        await editApplicationAnswers(
          event.id,
          gone,
          { now: NOW, answers: { [own.id]: "Sneaking back in" } },
          db
        )
      ).error
    ).toMatch(/not open/i);
  });

  it("leaves the seat, the queue place and the submission time alone", async () => {
    /*
     * Changing an answer is not a decision about a seat. `submittedAt` in
     * particular is the queue order (§14), so a write that touched it would
     * quietly send a waitlisted member to the back for fixing their rank.
     */
    const { event, own } = await editable({ capacity: MIN_CAPACITY });
    const [a, b] = [await makeUser(db), await makeUser(db)];
    const queued = await makeUser(db);
    expectOk(await applyToEvent(event.id, a, { now: hours(-3) }, db));
    expectOk(await applyToEvent(event.id, b, { now: hours(-2) }, db));
    expectOk(await applyToEvent(event.id, queued, { now: hours(-1) }, db));

    const before = (await rowsFor(event.id)).find((row) => row.userId === queued);
    expectOk(
      await editApplicationAnswers(
        event.id,
        queued,
        { now: NOW, answers: { [own.id]: "Happy to wait" } },
        db
      )
    );
    const after = (await rowsFor(event.id)).find((row) => row.userId === queued);

    expect(after?.status).toBe("waitlisted");
    expect(after?.waitlistPosition).toBe(before?.waitlistPosition);
    expect(after?.submittedAt.toISOString()).toBe(before?.submittedAt.toISOString());
  });

  it("stamps a detail the member only vouched for, without moving the value", async () => {
    // UC-12 3 / R-49: they changed nothing and said it is all still right.
    const { event } = await editable();
    const userId = await makeUser(db);
    await setProfileValue(userId, roleFieldId, "vanguard");
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const stampedAt = hours(5);
    expectOk(
      await editApplicationAnswers(
        event.id,
        userId,
        { now: stampedAt, confirmed: [roleFieldId] },
        db
      )
    );

    expect(await storedProfileValue(userId, roleFieldId)).toBe("vanguard");
    expect((await storedConfirmedAt(userId, roleFieldId))?.toISOString()).toBe(
      stampedAt.toISOString()
    );
  });

  it("refuses a detail that is not one this event asks about", async () => {
    // A detail belonging to another game. Refused rather than ignored, the
    // same judgement a question id from another event gets.
    const { event } = await editable();
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const [stray] = await db
      .insert(profileFields)
      .values({ gameId: null, key: `stray-${titleCounter}`, label: "Stray", type: "text" })
      .returning({ id: profileFields.id });
    await db.delete(profileFields).where(eq(profileFields.id, stray.id));

    const refused = await editApplicationAnswers(
      event.id,
      userId,
      { now: NOW, details: { [stray.id]: "anything" } },
      db
    );
    expect(expectFail(refused).errors?.[stray.id]).toMatch(/not one this event asks about/i);
  });
});

/* ------------------------------------------------------------------ */
/* Confirming a detail without changing it (R-49 / UC-12 3)           */
/* ------------------------------------------------------------------ */

/**
 * The stamp, on the path a member can actually reach.
 *
 * `commitDetails` is the only writer of a stamp-only `confirmed_at`: the apply
 * form offers the tap, `checkDetails` decides whether the ids are ones this
 * event asks about, and the write happens inside the transaction that accepts
 * the application. These four assertions were a describe block in
 * `profile.test.ts` over a `confirmProfileAnswers` nothing in `src/app` or
 * `src/components` called; they are the invariants rather than that function's
 * shape, so they moved here rather than going with it.
 *
 * Each one is a way the stamp can fail open, and two of them are worse than a
 * missing feature: a confirmation written against a question the site has
 * stopped asking (R-09, UC-03 5a) and a confirmation written onto somebody
 * else's row.
 */
describe("confirming a detail the member did not change", () => {
  /** A throwaway detail on the Rivals profile. Deleted by the test. */
  async function spareDetail(label = "Spare detail") {
    const [row] = await db
      .insert(profileFields)
      .values({
        gameId: rivalsId,
        key: `spare-${Math.random().toString(36).slice(2, 8)}`,
        label,
        type: "text",
        sort: 60,
      })
      .returning({ id: profileFields.id });
    return row.id;
  }

  it("stamps the answer without moving its value or `updated_at`", async () => {
    /*
     * R-49 in full: "my profile details shown back to me when I apply, so that
     * I only confirm they are still right". The confirmation has to leave a
     * trace, and it must not pretend the answer was re-entered — `updated_at`
     * is still when they actually typed it, which is the whole distinction the
     * column exists for (`confirmed_at > updated_at` is "given in March,
     * re-checked today").
     */
    const event = await openEvent({ gameId: rivalsId });
    const userId = await makeUser(db);
    const typedAt = new Date("2026-03-01T10:00:00Z");
    await db
      .insert(profileValues)
      .values({ userId, fieldId: roleFieldId, value: "strategist", updatedAt: typedAt });

    const stampedAt = hours(2);
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: stampedAt, confirmed: [roleFieldId] },
        db
      )
    );

    expect(await storedProfileValue(userId, roleFieldId)).toBe("strategist");
    expect((await storedUpdatedAt(userId, roleFieldId))?.toISOString()).toBe(
      typedAt.toISOString()
    );
    expect((await storedConfirmedAt(userId, roleFieldId))?.toISOString()).toBe(
      stampedAt.toISOString()
    );
  });

  it("creates nothing for a detail nobody has answered", async () => {
    // Confirming is a statement about an answer. There is no answer here, so
    // there is nothing to vouch for — and `value` is `not null`, so a row to
    // hold the stamp would have to invent one.
    const event = await openEvent({ gameId: rivalsId });
    const userId = await makeUser(db);

    expectOk(
      await applyToEvent(event.id, userId, { now: NOW, confirmed: [roleFieldId] }, db)
    );

    const rows = await db
      .select()
      .from(profileValues)
      .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, roleFieldId)));
    expect(rows).toEqual([]);
  });

  it("refuses to stamp a retired detail, and writes nothing", async () => {
    /*
     * UC-03 5a / R-09: retiring keeps the answers already given and stops the
     * question being asked. A page open since before the retirement posts the
     * id all the same, and it must not get a fresh confirmation written against
     * a question nobody is asking — `askedDetails` drops the retired detail and
     * `checkDetails` then refuses the id outright, which is a louder no than
     * skipping it quietly.
     */
    const event = await openEvent({ gameId: rivalsId });
    const retired = await spareDetail("Retired detail");
    const userId = await makeUser(db);
    await setProfileValue(userId, retired, "answered before it was retired");
    await db
      .update(profileFields)
      .set({ retiredAt: new Date("2026-03-20T00:00:00Z") })
      .where(eq(profileFields.id, retired));

    const refused = await applyToEvent(
      event.id,
      userId,
      { now: NOW, confirmed: [retired] },
      db
    );

    expect(expectFail(refused).errors?.[retired]).toMatch(/not one this event asks about/i);
    // The answer is kept and unstamped: R-09 keeps it, and nobody vouched for it.
    expect(await storedProfileValue(userId, retired)).toBe("answered before it was retired");
    expect(await storedConfirmedAt(userId, retired)).toBeNull();
    expect(await rowsFor(event.id)).toEqual([]);

    await db.delete(profileFields).where(eq(profileFields.id, retired));
  });

  it("stamps only the applicant's own answer", async () => {
    // Authorised on the row it writes: the `where` carries the member id as
    // well as the field ids, so one member's confirmation reaches one row —
    // never the answer somebody else gave to the same detail.
    const event = await openEvent({ gameId: rivalsId });
    const mine = await makeUser(db);
    const theirs = await makeUser(db);
    await setProfileValue(mine, roleFieldId, "duelist");
    await setProfileValue(theirs, roleFieldId, "vanguard");

    expectOk(
      await applyToEvent(event.id, mine, { now: hours(3), confirmed: [roleFieldId] }, db)
    );

    expect((await storedConfirmedAt(mine, roleFieldId))?.toISOString()).toBe(
      hours(3).toISOString()
    );
    expect(await storedConfirmedAt(theirs, roleFieldId)).toBeNull();
    expect(await storedProfileValue(theirs, roleFieldId)).toBe("vanguard");
  });
});

/* ------------------------------------------------------------------ */
/* Required profile details, and retirement (UC-12 2b, UC-03 5a)      */
/* ------------------------------------------------------------------ */

describe("the details an event insists on", () => {
  /** A required detail on the Rivals profile, cleaned up by the caller. */
  async function requiredDetail(label = "Discord handle") {
    const [row] = await db
      .insert(profileFields)
      .values({
        gameId: rivalsId,
        key: `needed-${Math.random().toString(36).slice(2, 8)}`,
        label,
        type: "text",
        required: true,
        sort: 50,
      })
      .returning({ id: profileFields.id });
    return row.id;
  }

  it("refuses the application when a required detail is missing, storing nothing", async () => {
    /*
     * UC-12 2b and the approved amendment to UC-04 4a: the profile saves
     * partially so a member can fill it in over time, and the *application* is
     * what will not go through without it. Nothing is stored — not the
     * application, and not the other details sent with it, because every
     * refusal happens before every write.
     */
    const event = await openEvent({ gameId: rivalsId });
    const needed = await requiredDetail();
    const userId = await makeUser(db);

    const refused = await applyToEvent(
      event.id,
      userId,
      { now: NOW, details: { [roleFieldId]: "duelist" } },
      db
    );
    expect(expectFail(refused).errors?.[needed]).toMatch(/required/i);
    expect(await rowsFor(event.id)).toEqual([]);
    expect(await storedProfileValue(userId, roleFieldId)).toBeNull();

    // Answered inline, as UC-12 2b asks — and now it goes through.
    expectOk(
      await applyToEvent(
        event.id,
        userId,
        { now: NOW, details: { [needed]: "beko#1", [roleFieldId]: "duelist" } },
        db
      )
    );
    expect(await storedProfileValue(userId, needed)).toBe("beko#1");

    await db.delete(profileFields).where(eq(profileFields.id, needed));
  });

  it("stops asking for a required detail the admin has retired", async () => {
    /*
     * R-09 / UC-03 5a, at the point it bites hardest. A required detail that
     * is retired but still enforced is an event nobody can apply to, asking
     * for something no form has a row for — so retirement is checked *before*
     * requiredness, and the answers already given stay where they are.
     */
    const event = await openEvent({ gameId: rivalsId });
    const needed = await requiredDetail("Retired question");
    const userId = await makeUser(db);

    expect(
      expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).errors?.[needed]
    ).toMatch(/required/i);

    await db
      .update(profileFields)
      .set({ retiredAt: new Date("2026-03-20T00:00:00Z") })
      .where(eq(profileFields.id, needed));

    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    // And it is not on the form either.
    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.profile.flatMap((section) => section.fields).map((field) => field.id)).not.toContain(
      needed
    );

    await db.delete(profileFields).where(eq(profileFields.id, needed));
  });

  it("lets a required linked question demand a detail the catalogue leaves optional", async () => {
    // A manager marking a linked question required is them saying they will not
    // read an application without it. The demand lands on the detail, which is
    // where the member can answer it.
    const event = await openEvent({ gameId: rivalsId });
    expectOk(
      await addQuestions(event.id, [
        {
          label: "Preferred role",
          type: "select",
          options: ROLE_OPTIONS,
          required: true,
          profileFieldId: roleFieldId,
        },
      ])
    );
    const userId = await makeUser(db);

    expect(
      expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).errors?.[roleFieldId]
    ).toMatch(/required/i);

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(detailIn(form, roleFieldId)?.required).toBe(true);
    expect(detailIn(form, roleFieldId)?.attention).toBe("missing");
  });
});

/* ------------------------------------------------------------------ */
/* The dashboard's to-dos (R-60 / UC-13 2)                            */
/* ------------------------------------------------------------------ */

describe("what an open application still needs", () => {
  it("raises a question that has changed since the member answered it", async () => {
    /*
     * UC-13 2's "unanswered changed questions". The admin reorders the ladder
     * out from under a stored rank (R-09 keeps the answer), so the answer is
     * still there and can no longer be read against the question — which is a
     * thing only the member can put right, and the only way they find out.
     */
    const event = await openEvent({ gameId: rivalsId });
    const userId = await makeUser(db);
    await setProfileValue(userId, rankFieldId, "Diamond III");
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expect(
      (await getMyApplications(userId, { now: NOW }, db))[0].outstanding
    ).toEqual([]);

    await db
      .update(profileFields)
      .set({ type: "number" })
      .where(eq(profileFields.id, rankFieldId));

    const mine = await getMyApplications(userId, { now: NOW }, db);
    expect(mine[0].outstanding).toEqual([
      { id: rankFieldId, label: "Rank", why: "stale", where: "profile" },
    ]);

    await db
      .update(profileFields)
      .set({ type: "rank" })
      .where(eq(profileFields.id, rankFieldId));
  });

  it("raises nothing at all for a retired question", async () => {
    /*
     * R-09 / UC-03 5a. A to-do pointing at a question no form shows is a job
     * with nowhere to do it — and a *required* retired question would nag for
     * ever. Both the missing case and the changed case, because retirement has
     * to win over each of them.
     */
    const event = await openEvent({ gameId: rivalsId });
    const [needed] = await db
      .insert(profileFields)
      .values({
        gameId: rivalsId,
        key: `retire-${Math.random().toString(36).slice(2, 8)}`,
        label: "Soon retired",
        type: "select",
        options: ROLE_OPTIONS,
        required: true,
        sort: 60,
      })
      .returning({ id: profileFields.id });

    const userId = await makeUser(db);
    await setProfileValue(userId, needed.id, "duelist");
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    // Make the stored answer unreadable *and* leave the question required.
    await db
      .update(profileFields)
      .set({ type: "number" })
      .where(eq(profileFields.id, needed.id));
    expect(
      (await getMyApplications(userId, { now: NOW }, db))[0].outstanding.map((row) => row.id)
    ).toEqual([needed.id]);

    await db
      .update(profileFields)
      .set({ retiredAt: new Date("2026-03-20T00:00:00Z") })
      .where(eq(profileFields.id, needed.id));

    expect((await getMyApplications(userId, { now: NOW }, db))[0].outstanding).toEqual([]);

    await db.delete(profileFields).where(eq(profileFields.id, needed.id));
  });

  it("raises an unanswered required question of the event's own", async () => {
    // The other half of UC-13 2: the event's own question, whose answer lives
    // on the application. `setEventQuestions` dropped the old answer when the
    // manager retyped it (`clearOrphanedAnswers`), which is exactly what "the
    // question changed since you answered it" looks like from here.
    const event = await openEvent({ gameId: rivalsId });
    const { questions } = expectOk(
      await addQuestions(event.id, [{ label: "Which role tonight", type: "text" }])
    );
    const userId = await makeUser(db);
    expectOk(
      await applyToEvent(event.id, userId, { now: NOW, answers: { [questions[0].id]: "Duelist" } }, db)
    );
    expect((await getMyApplications(userId, { now: NOW }, db))[0].outstanding).toEqual([]);

    expectOk(
      await addQuestions(event.id, [
        {
          id: questions[0].id,
          label: "Which role tonight",
          type: "select",
          options: ROLE_OPTIONS,
          required: true,
        },
      ])
    );

    expect((await getMyApplications(userId, { now: NOW }, db))[0].outstanding).toEqual([
      { id: questions[0].id, label: "Which role tonight", why: "missing", where: "event" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* answersEditable (R-53 / UC-13 4a)                                  */
/* ------------------------------------------------------------------ */

describe("answersEditable", () => {
  /*
   * The pure half, so the one closed reason that still counts as open is
   * pinned without standing a database up — and so the list of reasons that do
   * *not* is spelled out rather than implied by whichever one a test happened
   * to reach.
   */
  const shut = (reason: ClosedReason): ApplicationsState => ({
    open: false,
    reason,
    message: reason,
    opensAt: null,
    closesAt: null,
  });

  it("is open while applications are", () => {
    expect(
      answersEditable({
        open: true,
        willWaitlist: false,
        seatsLeft: 3,
        closesAt: null,
        message: "",
      })
    ).toBe(true);
  });

  it("is open on a full event, which is not a closed sign-up window", () => {
    expect(answersEditable(shut("full"))).toBe(true);
  });

  it("is shut for every reason that really is the window closing", () => {
    for (const reason of [
      "signups_closed",
      "event_started",
      "finished",
      "cancelled",
      "too_early",
      "not_published",
    ] as const) {
      expect(answersEditable(shut(reason))).toBe(false);
    }
  });
});
