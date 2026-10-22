import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, applications } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * **The promoted member is told, on both paths a member can free a seat by**
 * (R-55, R-100 / UC-13 3a, 5a).
 *
 * UC-13 3a and 5a both end in the same sentence — "the first waitlisted
 * applicant is moved into it *and notified*" — and the promotion half of that
 * is held hard: `events.test.ts` compares the whole queue after a withdrawal
 * and after an "I can't make it". The notification half was held by nothing at
 * all. `tellThePromoted` in `../actions.ts` is the only thing that sends it,
 * `src/lib/events.ts` deliberately notifies nobody (`promoted` comes back "so
 * the caller can notify them"), and every file that imports the action module
 * mocks the whole of it away — `answers-lock.test.ts`, `attendance-lock.test.ts`
 * and `day-names.test.ts` all do, because they only want markup.
 *
 * So deleting either call left the suite green while a withdrawal or a "can't
 * make it" promoted the next person off the waitlist and never told them: they
 * would find out by opening the site, which is the thing R-100 exists to stop.
 *
 * This file is the manager-side test's mirror. `decisions.test.ts` asserts
 * `expect(sent.decided).toHaveBeenCalledWith(eventId, first.userId, "accepted")`
 * for the decline path; these are the two member-driven paths, through the real
 * actions, against an in-memory Postgres.
 *
 * ## What each test asserts, and why it is more than the one call
 *
 * The spy alone would be satisfied by a `tellThePromoted` that notified
 * everybody in sight, so each test also pins **who** and **how many**: the
 * promoted member once, the member who gave the seat up not at all (they are
 * the one who did it — the action's docblock says so), and the second person
 * in the queue not at all either, because they were not promoted.
 *
 * Mocked exactly as `decisions.test.ts` mocks: the session, the page cache,
 * `after()`, and the one notification function, which is the side effect under
 * test.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const sent = vi.hoisted(() => ({ decided: vi.fn() }));

vi.mock("@/lib/notify-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify-events")>()),
  notifyApplicationDecided: sent.decided,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const { setMyConfirmationAction, withdrawFromEventAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const { MIN_CAPACITY } = await import("@/lib/events-policy");

let handle: TestDatabase;
let db: Database;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  sent.decided.mockClear();
});

type Seat = { applicationId: string; userId: string };

/**
 * A published first-come event with every seat taken and two people queueing.
 *
 * `MIN_CAPACITY` seats, which is the fewest R-26 allows, so `bystander` holds
 * the other one: what these tests are about is the seat `seated` holds and the
 * queue behind it. Two in the queue rather than one, so "the *first* waitlisted
 * applicant" is a claim with something to be wrong about.
 */
async function oneSeatAndAQueue(): Promise<{
  eventId: string;
  slug: string;
  bystander: Seat;
  seated: Seat;
  first: Seat;
  second: Seat;
}> {
  counter += 1;
  const event = await createEvent(
    { ...PUBLISHABLE, title: `Freed seat ${counter}`, capacity: MIN_CAPACITY },
    db
  );
  if (!event.ok) throw new Error(event.error);
  const published = await publishEvent(event.data.id, db);
  if (!published.ok) throw new Error(published.error);

  // Applied in order, an hour apart, because the queue order *is* `submittedAt`
  // and "the first waitlisted" has to be a fact rather than a coincidence of
  // insertion speed.
  const join = async (name: string, at: number): Promise<Seat> => {
    const userId = await makeUser(db, { displayName: `${name} ${counter}` });
    const application = await applyToEvent(
      event.data.id,
      userId,
      { now: new Date(Date.UTC(2026, 3, 1, at)) },
      db
    );
    if (!application.ok) throw new Error(application.error);
    return { applicationId: application.data.id, userId };
  };

  const fixture = {
    eventId: event.data.id,
    slug: event.data.slug,
    bystander: await join("Bystander", 9),
    seated: await join("Seated", 10),
    first: await join("First", 11),
    second: await join("Second", 12),
  };

  // The fixture is the premise of every assertion below, so it is checked
  // rather than assumed: a capacity change that quietly seated all four would
  // leave nobody to promote and every "was told" assertion vacuous.
  expect(await statusOf(fixture.seated.applicationId)).toBe("accepted");
  expect(await statusOf(fixture.first.applicationId)).toBe("waitlisted");
  expect(await statusOf(fixture.second.applicationId)).toBe("waitlisted");

  return fixture;
}

async function statusOf(applicationId: string): Promise<string> {
  const [row] = await db.select().from(applications).where(eq(applications.id, applicationId));
  return row.status;
}

/** Who was told they are in, in the order they were told. */
function toldTheyAreIn(): string[] {
  return sent.decided.mock.calls
    .filter((call) => call[2] === "accepted")
    .map((call) => call[1] as string);
}

describe("a member withdrawing (R-55, R-100 / UC-13 3a)", () => {
  it("tells the person their seat let in", async () => {
    const fixture = await oneSeatAndAQueue();
    state.userId = fixture.seated.userId;

    const result = await withdrawFromEventAction(fixture.eventId, fixture.slug);

    expect(result).toEqual({ ok: true, data: { promoted: 1 } });
    expect(await statusOf(fixture.first.applicationId)).toBe("accepted");
    expect(sent.decided).toHaveBeenCalledWith(fixture.eventId, fixture.first.userId, "accepted");
  });

  it("tells that one person, and nobody else", async () => {
    /*
     * The assertion the single `toHaveBeenCalledWith` above cannot make. A
     * `tellThePromoted` that looped over every application, or over the whole
     * waitlist, would satisfy it — and would tell somebody still in the queue
     * that they are in, which is worse news to get wrongly than none at all.
     * The member who gave the seat up is not told either: they did it.
     */
    const fixture = await oneSeatAndAQueue();
    state.userId = fixture.seated.userId;

    await withdrawFromEventAction(fixture.eventId, fixture.slug);

    expect(toldTheyAreIn()).toEqual([fixture.first.userId]);
    expect(sent.decided).toHaveBeenCalledTimes(1);
    expect(await statusOf(fixture.second.applicationId)).toBe("waitlisted");
  });
});

describe('a member answering "I can\'t make it" (R-55, R-100 / UC-13 5a)', () => {
  it("tells the person their freed seat let in", async () => {
    const fixture = await oneSeatAndAQueue();
    state.userId = fixture.seated.userId;

    const result = await setMyConfirmationAction(fixture.seated.applicationId, "out");

    expect(result.ok && result.data).toEqual({
      state: "out",
      status: "withdrawn",
      promoted: 1,
    });
    expect(await statusOf(fixture.first.applicationId)).toBe("accepted");
    expect(sent.decided).toHaveBeenCalledWith(fixture.eventId, fixture.first.userId, "accepted");
  });

  it("tells that one person, and nobody else", async () => {
    const fixture = await oneSeatAndAQueue();
    state.userId = fixture.seated.userId;

    await setMyConfirmationAction(fixture.seated.applicationId, "out");

    expect(toldTheyAreIn()).toEqual([fixture.first.userId]);
    expect(sent.decided).toHaveBeenCalledTimes(1);
    expect(await statusOf(fixture.second.applicationId)).toBe("waitlisted");
  });

  it('tells nobody for "Not sure yet", because nobody moved (R-199 / UC-13 5b)', async () => {
    /*
     * The other half of the same call, and the one that says the notification
     * follows the promotion rather than the button. "Not sure yet" keeps the
     * seat and promotes nobody, so a `tellThePromoted` reading anything other
     * than `promoted` — the applicant, say, or the whole waitlist — would send
     * a "you're in" to somebody who is not.
     */
    const fixture = await oneSeatAndAQueue();
    state.userId = fixture.seated.userId;

    const result = await setMyConfirmationAction(fixture.seated.applicationId, "maybe");

    expect(result.ok && result.data.promoted).toBe(0);
    expect(await statusOf(fixture.seated.applicationId)).toBe("accepted");
    expect(await statusOf(fixture.first.applicationId)).toBe("waitlisted");
    expect(sent.decided).not.toHaveBeenCalled();
  });
});
