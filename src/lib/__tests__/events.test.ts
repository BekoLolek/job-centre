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
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type CreateEventInput,
  type EventQuestionInput,
  type EventResult,
  applyToEvent,
  createEvent,
  getApplicationsForEvent,
  getEventBySlug,
  getMyApplications,
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
  const event = await makeEvent(over);
  return expectOk(await publishEvent(event.id, db));
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

  it("refuses an event that ends before it starts", async () => {
    const result = await createEvent(
      { title: "Time travel", startsAt: hours(5), endsAt: hours(1) },
      db
    );
    expect(expectFail(result).error).toMatch(/end before it starts/i);
  });

  it("refuses signups that open after the event has already begun", async () => {
    const result = await createEvent(
      { title: "Too late", signupOpensAt: hours(5), startsAt: hours(1) },
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
    const event = await makeEvent();
    expect(expectOk(await publishEvent(event.id, db)).status).toBe("published");
    expect(expectOk(await publishEvent(event.id, db)).status).toBe("published");
  });

  it("refuses a status jump that skips being published", async () => {
    const event = await makeEvent();
    expect(expectFail(await updateEvent(event.id, { status: "live" }, db)).error).toMatch(
      /cannot go from draft to live/i
    );
  });

  it("walks a real event through its lifecycle", async () => {
    const event = await makeEvent();
    expectOk(await publishEvent(event.id, db));
    expect(expectOk(await updateEvent(event.id, { status: "live" }, db)).status).toBe("live");
    expect(expectOk(await updateEvent(event.id, { status: "complete" }, db)).status).toBe(
      "complete"
    );
  });

  it("keeps validating once the event exists", async () => {
    const event = await makeEvent({ gameId: rivalsId });
    expect(
      expectFail(await updateEvent(event.id, { minRankToEnter: "Vibranium I" }, db)).error
    ).toMatch(/not one of/i);
  });

  it("will not hand one event another's slug", async () => {
    const first = await makeEvent({ title: "Slug holder" });
    const second = await makeEvent({ title: "Slug wanter" });
    const updated = expectOk(await updateEvent(second.id, { slug: first.slug }, db));
    expect(updated.slug).not.toBe(first.slug);
    expect(updated.slug).toBe(`${first.slug}-2`);
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
    const event = await openEvent({ startsAt: hours(-1) });
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
    const event = await openEvent({ capacity: 1 });
    const first = await makeUser(db);
    const second = await makeUser(db);
    expectOk(await applyToEvent(event.id, first, { now: NOW }, db));

    const queued = expectOk(await applyToEvent(event.id, second, { now: NOW }, db));
    expect(queued.status).toBe("waitlisted");
    expect(queued.waitlistPosition).toBe(1);
  });

  it("refuses outright when a full event has switched its waitlist off", async () => {
    const event = await openEvent({ capacity: 1, config: { waitlist: false } });
    const first = await makeUser(db);
    const second = await makeUser(db);
    expectOk(await applyToEvent(event.id, first, { now: NOW }, db));

    expect(expectFail(await applyToEvent(event.id, second, { now: NOW }, db)).error).toMatch(
      /is full/i
    );
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

  it("prefills a linked question from the profile when the payload leaves it out", async () => {
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

  it("lets the form override what the profile says", async () => {
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
        { now: NOW, answers: { [questions[0].id]: "vanguard" } },
        db
      )
    );
    expect(application.answers[questions[0].id]).toBe("vanguard");
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

/** An event with one seat, one member in it and two more queued behind. */
async function queuedEvent(): Promise<{
  event: EventRow;
  seated: string;
  first: string;
  second: string;
}> {
  const event = await openEvent({ capacity: 1 });
  const seated = await makeUser(db);
  const first = await makeUser(db);
  const second = await makeUser(db);

  expectOk(await applyToEvent(event.id, seated, { now: NOW }, db));
  expectOk(await applyToEvent(event.id, first, { now: hours(1) }, db));
  expectOk(await applyToEvent(event.id, second, { now: hours(2) }, db));

  return { event, seated, first, second };
}

describe("the waitlist", () => {
  it("seats the first arrivals and queues the rest in order", async () => {
    const { event, seated, first, second } = await queuedEvent();
    expect(await queueFor(event.id)).toEqual({
      [seated]: ["accepted", null],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });
  });

  it("promotes the earliest waitlister when the seat frees, and closes the gap", async () => {
    const { event, seated, first, second } = await queuedEvent();

    const result = expectOk(await withdrawApplication(event.id, seated, db));
    expect(result.application.status).toBe("withdrawn");
    expect(result.promoted.map((row) => row.userId)).toEqual([first]);

    expect(await queueFor(event.id)).toEqual({
      [seated]: ["withdrawn", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
    });
  });

  it("renumbers from 1 when somebody leaves the middle of the queue", async () => {
    const event = await openEvent({ capacity: 1 });
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
    const event = await openEvent({ capacity: 1 });
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

describe("setApplicationStatus", () => {
  it("declines a queued applicant without promoting anybody", async () => {
    const { event, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    const result = expectOk(
      await setApplicationStatus(queued?.id ?? "", "declined", { now: NOW }, db)
    );

    expect(result.promoted).toEqual([]);
    expect(result.seats.accepted).toBe(1);
    expect(await queueFor(event.id)).toEqual({
      [seated]: ["accepted", null],
      [first]: ["declined", null],
      [second]: ["waitlisted", 1],
    });
  });

  it("declining somebody who held a seat still promotes nobody on its own", async () => {
    const { event, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(
      await setApplicationStatus(holder?.id ?? "", "declined", { now: NOW }, db)
    );

    // The seat is free and the admin can see it, but who fills it is their call.
    expect(result.promoted).toEqual([]);
    expect(result.seats.seatsLeft).toBe(1);
    expect(await queueFor(event.id)).toEqual({
      [seated]: ["declined", null],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });
  });

  it("promotes when the admin asks it to", async () => {
    const { event, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    const result = expectOk(
      await setApplicationStatus(holder?.id ?? "", "declined", { now: NOW, promote: true }, db)
    );

    expect(result.promoted.map((row) => row.userId)).toEqual([first]);
    expect(await queueFor(event.id)).toEqual({
      [seated]: ["declined", null],
      [first]: ["accepted", null],
      [second]: ["waitlisted", 1],
    });
  });

  it("lets an admin accept past the capacity, and says that is what happened", async () => {
    const { event, first } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);

    const result = expectOk(
      await setApplicationStatus(queued?.id ?? "", "accepted", { now: NOW }, db)
    );

    expect(result.overCapacity).toBe(true);
    expect(result.seats.accepted).toBe(2);
    expect(result.application.waitlistPosition).toBeNull();
  });

  it("puts somebody back on the queue at the end", async () => {
    const { event, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const holder = rows.find((row) => row.userId === seated);

    expectOk(await setApplicationStatus(holder?.id ?? "", "waitlisted", { now: NOW }, db));

    expect(await queueFor(event.id)).toEqual({
      [seated]: ["waitlisted", 3],
      [first]: ["waitlisted", 1],
      [second]: ["waitlisted", 2],
    });
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
    expect(written).toEqual({ [days[0].id]: "yes", [days[1].id]: "no" });

    const cleared = expectOk(await setAvailability(application.id, { [days[1].id]: null }, db));
    expect(cleared).toEqual({ [days[0].id]: "yes" });
  });

  it("overwrites an earlier answer for the same day", async () => {
    const event = await openEvent();
    const { days } = expectOk(await setEventDays(event.id, [{ label: "Fri" }], db));
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expectOk(await setAvailability(application.id, { [days[0].id]: "yes" }, db));
    const second = expectOk(await setAvailability(application.id, { [days[0].id]: "maybe" }, db));
    expect(second).toEqual({ [days[0].id]: "maybe" });

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
  it("records in, and lets it be changed to out", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expect(expectOk(await setConfirmation(application.id, "in", db)).state).toBe("in");
    expect(expectOk(await setConfirmation(application.id, "out", db)).state).toBe("out");

    const [view] = await getApplicationsForEvent(event.id, db);
    expect(view.confirmation).toBe("out");
  });

  it("lets a waitlisted member say whether they are still interested", async () => {
    const { event, first } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === first);
    expect(expectOk(await setConfirmation(queued?.id ?? "", "in", db)).state).toBe("in");
  });

  it("refuses to confirm a withdrawn application", async () => {
    const event = await openEvent();
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expectOk(await withdrawApplication(event.id, userId, db));

    expect(expectFail(await setConfirmation(application.id, "in", db)).error).toMatch(
      /not active/i
    );
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
    const soon = await openEvent({ title: "Coming up", startsAt: hours(48) });
    const done = await openEvent({ title: "Long gone", startsAt: hours(-48) });

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
    const { event, seated, first, second } = await queuedEvent();
    const rows = await rowsFor(event.id);
    const queued = rows.find((row) => row.userId === second);
    expectOk(await setApplicationStatus(queued?.id ?? "", "declined", { now: NOW }, db));

    const applicants = await getApplicationsForEvent(event.id, db);
    expect(applicants.map((row) => [row.userId, row.status])).toEqual([
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
    const soon = await openEvent({ title: "Mine, soon", startsAt: hours(24) });
    const later = await openEvent({ title: "Mine, later", startsAt: hours(72) });
    expectOk(await applyToEvent(later.id, userId, { now: NOW }, db));
    expectOk(await applyToEvent(soon.id, userId, { now: NOW }, db));

    const mine = await getMyApplications(userId, { now: NOW }, db);
    expect(mine.map((row) => row.event.id)).toEqual([soon.id, later.id]);
    expect(mine[0].seats.accepted).toBe(1);
  });

  it("gives the member's form back prefilled, with the gate already worked out", async () => {
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

    const prefilled = form?.questions.find((question) => question.id === questions[0].id);
    expect(prefilled?.value).toBe("vanguard");
    expect(prefilled?.prefilled).toBe(true);

    const empty = form?.questions.find((question) => question.id === questions[1].id);
    expect(empty?.value).toBeNull();
    expect(empty?.prefilled).toBe(false);
  });

  it("shows an existing application's own answers rather than the profile's", async () => {
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
    expectOk(
      await applyToEvent(event.id, userId, { now: NOW, answers: { [questions[0].id]: "duelist" } }, db)
    );

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.questions[0].value).toBe("duelist");
    expect(form?.questions[0].prefilled).toBe(false);
    expect(form?.application?.status).toBe("accepted");
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
      startsAt: hours(24),
      days: [{ label: "Saturday" }, { label: "Sunday" }],
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
