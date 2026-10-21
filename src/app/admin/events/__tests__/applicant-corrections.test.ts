import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, auditLog, events, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type EventResult,
  applyToEvent,
  createEvent,
  getApplicationsForEvent,
  getEventById,
  getMyApplications,
  publishEvent,
  setApplicationNote,
  setAvailability,
} from "@/lib/events";

/*
 * UC-14's three extension flows (R-119, R-120).
 *
 * > **E1.** Manager writes a note on an application — System stores it,
 * > visible to managers only.
 * >
 * > **E2.** Manager changes which days an applicant can attend — System saves
 * > it and **audits who changed it**.
 * >
 * > **E3.** Either on a complete event — System refuses (UC-09 6b).
 *
 * Two things were wrong.
 *
 *  - **E2 was not audited.** `setApplicantAvailabilityAction` was the one
 *    manager write on this screen with no line in the log — and the one most
 *    in need of one, because what it overwrites is something the *member* said.
 *    R-120's whole reason is "so that a message on Discord can be recorded",
 *    and UC-14's outcome is that every decision here is in the log. "Why does
 *    it say I can make Sunday" has to have an answer.
 *  - **E1's "managers only" held by habit.** `MyApplicationView` spread the
 *    whole application row, `note` included, so the manager's private remark
 *    travelled to every member-facing read and was kept off the screen by each
 *    page choosing to build an explicit DTO. One `{...row}` in a future page
 *    and it is on the applicant's own dashboard.
 *
 * The actions run for real against an in-memory Postgres; only the session
 * cookie, the page cache and `after()` are replaced, exactly as
 * `host-scope.test.ts` does it.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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

const { saveApplicationNoteAction, setApplicantAvailabilityAction } = await import("../actions");

let harness: TestDatabase;
let db: Database;
let admin: string;

const WINDOW = {
  signupOpensAt: new Date("2000-01-01T00:00:00Z"),
  signupClosesAt: new Date("2100-01-01T00:00:00Z"),
};

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

function expectFail<T>(result: EventResult<T>): { error: string } {
  if (result.ok) throw new Error("Expected a refusal, got success");
  return result;
}

let counter = 0;

/** A published two-day event with one applicant holding a seat. */
async function eventWithApplicant(): Promise<{
  eventId: string;
  applicationId: string;
  memberId: string;
  dayIds: string[];
}> {
  counter += 1;
  const created = expectOk(
    await createEvent(
      {
        title: `Corrections ${counter}`,
        capacity: 8,
        ...WINDOW,
        days: [
          { startsAt: new Date("2100-01-02T18:00:00Z"), label: "Saturday" },
          { startsAt: new Date("2100-01-03T18:00:00Z"), label: "Sunday" },
        ],
      },
      db
    )
  );
  expectOk(await publishEvent(created.id, db));

  const memberId = await makeUser(db, { displayName: `Applicant ${counter}` });
  const application = expectOk(await applyToEvent(created.id, memberId, {}, db));

  const event = await getEventById(created.id, {}, db);
  if (!event) throw new Error("event vanished");

  return {
    eventId: created.id,
    applicationId: application.id,
    memberId,
    dayIds: event.days.map((day) => day.id),
  };
}

/** The log lines for one application, newest first. */
async function auditFor(applicationId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subject, applicationId), eq(auditLog.action, action)));
}

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;

  admin = await makeUser(db, { displayName: "Ada Admin" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  state.userId = admin;
});

afterAll(async () => {
  await harness.close();
});

/* ------------------------------------------------------------------ */
/* UC-14 E1 — a manager's note                                        */
/* ------------------------------------------------------------------ */

describe("UC-14 E1: a note on an application", () => {
  it("stores it, and the manager's own read gives it back", async () => {
    const { eventId, applicationId } = await eventWithApplicant();

    const saved = await saveApplicationNoteAction(applicationId, "Might be late");
    expect(saved.ok).toBe(true);

    const applicants = await getApplicationsForEvent(eventId, db);
    expect(applicants.find((row) => row.id === applicationId)?.note).toBe("Might be late");
  });

  it("does not move their place in the queue", async () => {
    // The reason this is its own write rather than a status change with the
    // status left alone: `decideApplicationAction` renumbers the queue.
    const { eventId, applicationId } = await eventWithApplicant();
    const before = (await getApplicationsForEvent(eventId, db)).find(
      (row) => row.id === applicationId
    );

    await saveApplicationNoteAction(applicationId, "Noted");

    const after = (await getApplicationsForEvent(eventId, db)).find(
      (row) => row.id === applicationId
    );
    expect(after?.status).toBe(before?.status);
    expect(after?.waitlistPosition).toBe(before?.waitlistPosition ?? null);
  });

  it("keeps it away from the applicant's own read of their application", async () => {
    // "Visible to managers only." Asserted against the member-facing read
    // rather than against the page, so it stays true if a page is rewritten.
    const { eventId, applicationId, memberId } = await eventWithApplicant();
    await saveApplicationNoteAction(applicationId, "Keeps turning up drunk");

    const mine = await getMyApplications(memberId, {}, db);
    const row = mine.find((entry) => entry.id === applicationId);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("Keeps turning up drunk");
    expect("note" in (row as object)).toBe(false);
  });

  it("clears back to nothing rather than to an empty string", async () => {
    const { eventId, applicationId } = await eventWithApplicant();
    await saveApplicationNoteAction(applicationId, "Temporary");

    await saveApplicationNoteAction(applicationId, "   ");

    const applicants = await getApplicationsForEvent(eventId, db);
    expect(applicants.find((row) => row.id === applicationId)?.note).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-14 E2 — correcting which days they can make                     */
/* ------------------------------------------------------------------ */

describe("UC-14 E2: correcting an applicant's days", () => {
  it("saves it", async () => {
    const { eventId, applicationId, dayIds } = await eventWithApplicant();

    const saved = await setApplicantAvailabilityAction(
      applicationId,
      { [dayIds[1]]: "yes" },
      eventId
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.data[dayIds[1]]).toBe("yes");

    const applicants = await getApplicationsForEvent(eventId, db);
    expect(applicants.find((row) => row.id === applicationId)?.availability).toEqual({
      [dayIds[1]]: "yes",
    });
  });

  it("audits who changed it", async () => {
    // E2's second clause, which had no implementation at all.
    const { eventId, applicationId, dayIds } = await eventWithApplicant();

    await setApplicantAvailabilityAction(applicationId, { [dayIds[0]]: "yes" }, eventId);

    const lines = await auditFor(applicationId, "application.availability");
    expect(lines).toHaveLength(1);
    expect(lines[0].actorUserId).toBe(admin);
    expect(lines[0].actorName).toBe("Ada Admin");
    expect(lines[0].eventId).toBe(eventId);
    expect(lines[0].summary).toMatch(/one day/i);
  });

  it("audits every correction, not only the first", async () => {
    const { eventId, applicationId, dayIds } = await eventWithApplicant();

    await setApplicantAvailabilityAction(applicationId, { [dayIds[0]]: "yes" }, eventId);
    await setApplicantAvailabilityAction(
      applicationId,
      { [dayIds[0]]: "no", [dayIds[1]]: "maybe" },
      eventId
    );

    const lines = await auditFor(applicationId, "application.availability");
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => /2 days/i.test(line.summary))).toBe(true);
  });

  it("logs nothing for a correction that corrected nothing", async () => {
    /*
     * The audit used to fire on every `ok`. The drawer posts an answer on
     * every tap, including the tap that picks the answer already showing, and
     * an empty `byDay` is a legal request — so the log collected lines saying
     * "Corrected an applicant's answers for 0 days." A log of changes that
     * were not changes costs the entries that are real.
     */
    const { eventId, applicationId, dayIds } = await eventWithApplicant();
    await setApplicantAvailabilityAction(applicationId, { [dayIds[0]]: "yes" }, eventId);
    expect(await auditFor(applicationId, "application.availability")).toHaveLength(1);

    // The same answer again, and then a save naming no days at all.
    const same = await setApplicantAvailabilityAction(
      applicationId,
      { [dayIds[0]]: "yes" },
      eventId
    );
    expect(same.ok).toBe(true);
    await setApplicantAvailabilityAction(applicationId, {}, eventId);

    expect(await auditFor(applicationId, "application.availability")).toHaveLength(1);
  });

  it("refuses a day that belongs to another event, and logs nothing", async () => {
    const mine = await eventWithApplicant();
    const theirs = await eventWithApplicant();

    const refused = await setApplicantAvailabilityAction(
      mine.applicationId,
      { [theirs.dayIds[0]]: "yes" },
      mine.eventId
    );
    expect(refused.ok).toBe(false);

    expect(await auditFor(mine.applicationId, "application.availability")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* UC-14 E3 — either, on a complete event                             */
/* ------------------------------------------------------------------ */

describe("UC-14 E3: once the event is complete", () => {
  it("refuses the note", async () => {
    const { eventId, applicationId } = await eventWithApplicant();
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    expect(expectFail(await setApplicationNote(applicationId, "too late", db)).error).toMatch(
      /complete|archived|finished|over/i
    );
  });

  it("refuses the day correction", async () => {
    const { eventId, applicationId, dayIds } = await eventWithApplicant();
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    expect(
      expectFail(await setAvailability(applicationId, { [dayIds[0]]: "yes" }, db)).error
    ).toMatch(/complete|archived|finished|over/i);
  });

  it("stores neither, and logs neither", async () => {
    const { eventId, applicationId, dayIds } = await eventWithApplicant();
    await saveApplicationNoteAction(applicationId, "before it finished");
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    await setApplicationNote(applicationId, "after it finished", db);
    await setApplicantAvailabilityAction(applicationId, { [dayIds[0]]: "yes" }, eventId);

    const applicants = await getApplicationsForEvent(eventId, db);
    const row = applicants.find((entry) => entry.id === applicationId);
    expect(row?.note).toBe("before it finished");
    expect(row?.availability).toEqual({});
    expect(await auditFor(applicationId, "application.availability")).toHaveLength(0);
  });
});
