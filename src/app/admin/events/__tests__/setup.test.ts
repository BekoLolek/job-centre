import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { type Database, auditLog, eventDays, events } from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";

/*
 * UC-08 9-10, 10b and 10c through the four actions the Setup step calls, for
 * real against an in-memory Postgres.
 *
 * Mocked exactly as `status.test.ts` does it — the session, the page cache and
 * `after()` — plus spies on the two notification triggers, because *whether
 * they fire* is the whole of what is under test here: UC-08 10b notifies
 * applicants of a published event when something changed, and nothing else
 * does.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const sent = vi.hoisted(() => ({
  updated: vi.fn(),
  questions: vi.fn(),
}));

vi.mock("@/lib/notify-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify-events")>()),
  notifyEventUpdated: sent.updated,
  notifyQuestionsChanged: sent.questions,
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

const {
  saveBasicsAction,
  saveEntryRulesAction,
  saveEventDaysAction,
  saveEventQuestionsAction,
} = await import("../actions");

let handle: TestDatabase;
let db: Database;
let hostId: string;
let counter = 0;

const NOW = new Date("2026-07-01T12:00:00.000Z");
const days = (count: number) => new Date(NOW.getTime() + count * 86_400_000);
const iso = (at: Date) => at.toISOString();

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  hostId = await makeUser(db, { displayName: "Setting-up Sam" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = hostId;
  sent.updated.mockClear();
  sent.questions.mockClear();
});

/** An event in the given status, hosted by the signed-in manager, with one day. */
async function eventIn(status: "draft" | "published"): Promise<string> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({
      slug: `setup-${counter}`,
      title: `Setup ${counter}`,
      status,
      signupOpensAt: days(1),
      signupClosesAt: days(10),
      capacity: 8,
    })
    .returning({ id: events.id });
  await db.insert(eventDays).values({ eventId: event.id, dayIndex: 0, startsAt: days(10) });
  await makeHost(db, event.id, hostId);
  return event.id;
}

/** The fields the Basics panel posts, as it holds them for this event. */
async function basicsOf(eventId: string) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  return {
    title: event.title,
    slug: event.slug,
    type: event.type,
    description: event.description,
    bannerUrl: event.bannerUrl,
    gameId: event.gameId,
    capacity: event.capacity,
    entryMode: "first_come" as const,
    waitlist: true,
    signupOpensAt: event.signupOpensAt ? iso(event.signupOpensAt) : null,
    signupClosesAt: event.signupClosesAt ? iso(event.signupClosesAt) : null,
  };
}

async function auditFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

async function dayTimes(eventId: string): Promise<Array<number | null>> {
  const rows = await db
    .select()
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId))
    .orderBy(asc(eventDays.dayIndex));
  return rows.map((row) => row.startsAt?.getTime() ?? null);
}

/* ------------------------------------------------------------------ */
/* Basics                                                             */
/* ------------------------------------------------------------------ */

describe("saving the basics", () => {
  // UC-08 10: "System validates and saves all of it", and the outcome line —
  // "the change is in the audit log".
  it("logs what changed, and tells the applicants of a published event", async () => {
    const eventId = await eventIn("published");

    const result = await saveBasicsAction(eventId, {
      ...(await basicsOf(eventId)),
      title: "Renamed night",
      capacity: 12,
    });
    expect(result.ok).toBe(true);

    const log = await auditFor(eventId, "event.basics");
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(hostId);
    expect(log[0].summary).toMatch(/Changed title, capacity on "Renamed night"\./);
    expect(log[0].detail).toMatchObject({ changed: ["title", "capacity"] });

    // UC-08 10b: it is published, so its applicants are told.
    expect(sent.updated).toHaveBeenCalledWith(eventId);
  });

  /*
   * UC-08 10b again, from the side that is easy to get wrong. The audit line
   * is a record of what was done and a save is something that was done; the
   * notification is news, and a save that moved nothing is not news. Sending
   * it anyway is how a member ends up switching the kind off (R-104).
   */
  it("logs a save that changed nothing, and tells nobody", async () => {
    const eventId = await eventIn("published");
    const fields = await basicsOf(eventId);

    expect((await saveBasicsAction(eventId, fields)).ok).toBe(true);

    const log = await auditFor(eventId, "event.basics");
    expect(log).toHaveLength(1);
    expect(log[0].summary).toMatch(/with nothing changed/);
    expect(log[0].detail).toMatchObject({ changed: [] });
    expect(sent.updated).not.toHaveBeenCalled();
  });

  // The acceptance criterion: "Unpublished saves notify nobody." A draft is
  // visible to its managers alone, so nobody can have applied and there is
  // nobody whose plans just moved.
  it("tells nobody while the event is still a draft", async () => {
    const eventId = await eventIn("draft");

    const result = await saveBasicsAction(eventId, {
      ...(await basicsOf(eventId)),
      title: "Still a draft",
    });

    expect(result.ok).toBe(true);
    expect(await auditFor(eventId, "event.basics")).toHaveLength(1);
    expect(sent.updated).not.toHaveBeenCalled();
  });

  /*
   * R-26 bites the cap a save *writes*, and the panel renders the cap the event
   * holds — so an event carrying a one-seat cap from before the minimum existed
   * (legal then, which is why there is no database constraint; see
   * `MIN_CAPACITY`) sends `1` back with every save of this panel. Refusing it
   * would mean a typo in the description cannot be fixed until the manager
   * raises the cap, and raising it promotes the next person off the waitlist —
   * a "you're in" nobody sent. So an unchanged cap is not a cap being written.
   */
  it("saves the basics of a legacy one-seat event, cap and all (R-26)", async () => {
    const eventId = await eventIn("published");
    await db.update(events).set({ capacity: 1 }).where(eq(events.id, eventId));

    const result = await saveBasicsAction(eventId, {
      ...(await basicsOf(eventId)),
      description: "A typo fixed, nothing else.",
    });

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.description).toBe("A typo fixed, nothing else.");
    // Not quietly promoted to the minimum either: the cap is the manager's.
    expect(row.capacity).toBe(1);
    // Only the description moved, so that is all the applicants are told about.
    expect((await auditFor(eventId, "event.basics"))[0].detail).toMatchObject({
      changed: ["description"],
    });
  });

  // The other half of that rule: leaving an *unchanged* cap out of the patch
  // must not turn into never checking a cap. A manager who types one seat is
  // still refused, and nothing is saved.
  it("still refuses a cap the manager actually types below the minimum", async () => {
    const eventId = await eventIn("published");

    const result = await saveBasicsAction(eventId, {
      ...(await basicsOf(eventId)),
      title: "Renamed and shrunk",
      capacity: 1,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/at least 2 seats/);
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.capacity).toBe(8);
    expect(row.title).not.toBe("Renamed and shrunk");
    expect(await auditFor(eventId, "event.basics")).toEqual([]);
  });

  /*
   * UC-08 10c: "System names the problem; nothing saved." Nothing logged and
   * nothing sent either — an audit line for a save that did not happen is a
   * record of something that did not happen.
   */
  it("logs and tells nothing when the save is refused", async () => {
    const eventId = await eventIn("published");

    const result = await saveBasicsAction(eventId, {
      ...(await basicsOf(eventId)),
      // The first day starts on day 10, so this closes sign-ups after it.
      signupClosesAt: iso(days(20)),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/close them no later than the start/i);
    expect(await auditFor(eventId, "event.basics")).toEqual([]);
    expect(sent.updated).not.toHaveBeenCalled();

    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.signupClosesAt).toEqual(days(10));
  });
});

/* ------------------------------------------------------------------ */
/* The days — which are the event's dates (R-24)                      */
/* ------------------------------------------------------------------ */

describe("saving the days", () => {
  it("logs the new day list and tells the applicants the dates moved", async () => {
    const eventId = await eventIn("published");

    const result = await saveEventDaysAction(eventId, [
      { startsAt: iso(days(11)), label: "Saturday" },
      { startsAt: iso(days(12)), label: "Sunday" },
    ]);

    expect(result.ok).toBe(true);
    const log = await auditFor(eventId, "event.days");
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatchObject({ days: 2, changed: true });
    // R-98: the days *are* the dates now, so a day that moved is the change an
    // applicant is counting on being told about.
    expect(sent.updated).toHaveBeenCalledWith(eventId);
    expect(await dayTimes(eventId)).toEqual([days(11).getTime(), days(12).getTime()]);
  });

  it("logs a day list saved back unchanged, and tells nobody", async () => {
    const eventId = await eventIn("published");
    const written = await saveEventDaysAction(eventId, [
      { startsAt: iso(days(11)), label: "Saturday" },
    ]);
    if (!written.ok) throw new Error(written.error);
    sent.updated.mockClear();

    // The ids come back so the screen can adopt them; saving them back is the
    // second press of Save, and it changes nothing.
    const again = await saveEventDaysAction(eventId, written.data.days);

    expect(again.ok).toBe(true);
    const log = await auditFor(eventId, "event.days");
    expect(log).toHaveLength(2);
    expect(log[1].summary).toMatch(/with nothing changed/);
    expect(sent.updated).not.toHaveBeenCalled();
  });

  it("tells nobody while the event is still a draft", async () => {
    const eventId = await eventIn("draft");

    const result = await saveEventDaysAction(eventId, [
      { startsAt: iso(days(11)), label: null },
    ]);

    expect(result.ok).toBe(true);
    expect(sent.updated).not.toHaveBeenCalled();
  });

  // UC-08 10c through the action: the refusal is the library's, and the action
  // adds neither a log line nor a notification to it.
  it("logs and tells nothing when the day list is refused", async () => {
    const eventId = await eventIn("published");

    const result = await saveEventDaysAction(eventId, [
      { startsAt: iso(days(12)), label: null },
      { startsAt: iso(days(11)), label: null },
    ]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Day 2 starts before Day 1/i);
    expect(await auditFor(eventId, "event.days")).toEqual([]);
    expect(sent.updated).not.toHaveBeenCalled();
    expect(await dayTimes(eventId)).toEqual([days(10).getTime()]);
  });
});

/* ------------------------------------------------------------------ */
/* The questions                                                      */
/* ------------------------------------------------------------------ */

describe("saving the questions", () => {
  const question = (label: string) => ({
    label,
    type: "text",
    options: [] as string[],
    required: false,
    profileFieldId: null,
  });

  // R-99, UC-08 10b: told to people who already answered, because their
  // answers may no longer say what they meant.
  it("logs the new form and tells the applicants it changed", async () => {
    const eventId = await eventIn("published");

    const result = await saveEventQuestionsAction(eventId, [question("Your handle")]);

    expect(result.ok).toBe(true);
    const log = await auditFor(eventId, "event.questions");
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatchObject({ questions: 1, changed: true });
    expect(sent.questions).toHaveBeenCalledWith(eventId, hostId);
  });

  it("logs a form saved back unchanged, and tells nobody", async () => {
    const eventId = await eventIn("published");
    const written = await saveEventQuestionsAction(eventId, [question("Your handle")]);
    if (!written.ok) throw new Error(written.error);
    sent.questions.mockClear();

    const again = await saveEventQuestionsAction(eventId, written.data.questions);

    expect(again.ok).toBe(true);
    const log = await auditFor(eventId, "event.questions");
    expect(log).toHaveLength(2);
    expect(log[1].summary).toMatch(/with nothing changed/);
    expect(sent.questions).not.toHaveBeenCalled();
  });

  it("tells nobody while the event is still a draft", async () => {
    const eventId = await eventIn("draft");

    const result = await saveEventQuestionsAction(eventId, [question("Your handle")]);

    expect(result.ok).toBe(true);
    expect(await auditFor(eventId, "event.questions")).toHaveLength(1);
    expect(sent.questions).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* The entry rules                                                    */
/* ------------------------------------------------------------------ */

describe("saving the entry rules", () => {
  // UC-08 7 and 10: the other half of the Setup step, audited like the rest of
  // it. Who tightened the rank gate on an event people had already applied to
  // is exactly what the log is for.
  it("logs the thresholds it set", async () => {
    const eventId = await eventIn("published");

    const result = await saveEntryRulesAction(eventId, {
      minRankToEnter: null,
      minRankToCaptain: null,
    });

    expect(result.ok).toBe(true);
    const log = await auditFor(eventId, "event.entryRules");
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(hostId);
    // Nothing moved — both were already empty — so nobody is told.
    expect(log[0].summary).toMatch(/with nothing changed/);
    expect(sent.updated).not.toHaveBeenCalled();
  });
});
