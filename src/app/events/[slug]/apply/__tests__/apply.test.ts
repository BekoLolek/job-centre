import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, applications, auditLog } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * UC-12 6-8 through the action the apply form calls, against an in-memory
 * Postgres.
 *
 * Where the application *lands* is `src/lib/events.ts`'s business and is tested
 * exhaustively there. What is under test here is the pair of side effects that
 * can only happen at this layer, and only after the write has stuck: UC-12 8's
 * "System shows 'You're in' and notifies" (R-100), and the audit line, which
 * needs the session to know who applied.
 *
 * Mocked exactly as `src/app/admin/events/__tests__/decisions.test.ts` does it
 * -- the session, the page cache, `after()` -- plus a spy on the notification,
 * because *whether* it fires is half of what is being asserted: an approval
 * event's application has not been decided by anybody, so nobody is told
 * anything yet (R-27).
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

const { applyToEventAction, editApplicationAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent, setEventQuestions } = await import(
  "@/lib/events"
);

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

/** A published event with `capacity` seats, hosted by nobody in particular. */
async function openEvent(
  capacity: number | null,
  config?: { entryMode: "approval" }
): Promise<{ id: string; slug: string }> {
  counter += 1;
  const event = await createEvent(
    { ...PUBLISHABLE, title: `Apply night ${counter}`, capacity, config },
    db
  );
  if (!event.ok) throw new Error(event.error);
  const published = await publishEvent(event.data.id, db);
  if (!published.ok) throw new Error(published.error);
  return { id: event.data.id, slug: published.data.slug };
}

async function applyAs(
  userId: string,
  event: { id: string; slug: string }
) {
  state.userId = userId;
  return applyToEventAction({
    eventId: event.id,
    slug: event.slug,
    answers: {},
    availability: {},
  });
}

async function auditFor(eventId: string) {
  return db.select().from(auditLog).where(eq(auditLog.eventId, eventId));
}

describe("applying", () => {
  it("tells the member they are in, and writes a line naming them", async () => {
    // UC-12 7-8.
    const event = await openEvent(2);
    const userId = await makeUser(db, { displayName: "Keen Kate" });

    const result = await applyAs(userId, event);

    expect(result.ok && result.data.status).toBe("accepted");
    expect(sent.decided).toHaveBeenCalledWith(event.id, userId, "accepted");

    const audit = await auditFor(event.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(userId);
    expect(audit[0].summary).toMatch(/Keen Kate applied to .* and took a seat\./);
  });

  it("tells a queued applicant where they are, and says so in the log", async () => {
    // UC-12 7a: seats full, so they are stored waitlisted with their position.
    // Two seats, because that is the smallest cap R-26 allows, so filling them
    // takes two people and the third is the one who queues.
    const event = await openEvent(2);
    const seated = await makeUser(db, { displayName: "Early Eli" });
    const alsoSeated = await makeUser(db, { displayName: "Prompt Pia" });
    const queued = await makeUser(db, { displayName: "Late Lena" });

    await applyAs(seated, event);
    await applyAs(alsoSeated, event);
    sent.decided.mockClear();
    const result = await applyAs(queued, event);

    expect(result.ok && result.data.status).toBe("waitlisted");
    expect(result.ok && result.data.waitlistPosition).toBe(1);
    expect(sent.decided).toHaveBeenCalledWith(event.id, queued, "waitlisted");

    const audit = await auditFor(event.id);
    expect(audit).toHaveLength(3);
    expect(audit[2].summary).toMatch(/Late Lena applied to .* and joined the queue at number 1\./);
  });

  it("logs an approval event's application but tells nobody yet", async () => {
    /*
     * R-27 / UC-12 7b: it arrives pending, which is not one of the three
     * answers a decision notification can word -- nobody has decided anything.
     * The log still gets its line: somebody applied, and that happened.
     */
    const event = await openEvent(4, { entryMode: "approval" });
    const userId = await makeUser(db, { displayName: "Patient Pat" });

    const result = await applyAs(userId, event);

    expect(result.ok && result.data.status).toBe("pending");
    expect(sent.decided).not.toHaveBeenCalled();

    const audit = await auditFor(event.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toMatch(/Patient Pat applied to .* and is awaiting review\./);
  });

  it("logs nothing and tells nobody when the write was refused", async () => {
    // UC-12 7d: a double submit stores one application, and the second call is
    // a refusal -- so there is nothing to log and nobody to tell about it.
    const event = await openEvent(2);
    const userId = await makeUser(db, { displayName: "Twice Tam" });

    await applyAs(userId, event);
    sent.decided.mockClear();
    const again = await applyAs(userId, event);

    expect(again.ok).toBe(false);
    expect(sent.decided).not.toHaveBeenCalled();
    expect(await auditFor(event.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Changing an answer afterwards (R-53 / UC-13 3, 4, 4a)              */
/* ------------------------------------------------------------------ */

/**
 * The action behind the edit form.
 *
 * Where the answers *land* is `src/lib/events.ts`'s business and is tested
 * there. What is under test here is the pair of facts that only exist at this
 * layer: a member fixing their own answer is **not** a decision about a seat,
 * so nobody is notified and nothing is written to the log — and the deadline is
 * enforced below this layer, so calling the action directly after sign-ups
 * close is refused rather than quietly honoured.
 *
 * That second one is the whole reason the check is not in this file. A server
 * action is a public POST endpoint, reachable long after the page stopped
 * rendering the form, and this test is that call.
 */
describe("editing an application", () => {
  /** An open event with one question of its own, and `userId` already in it. */
  async function applied(options: { closesAt?: Date } = {}) {
    counter += 1;
    const created = await createEvent(
      {
        ...PUBLISHABLE,
        title: `Edit night ${counter}`,
        capacity: 4,
        ...(options.closesAt ? { signupClosesAt: options.closesAt } : {}),
      },
      db
    );
    if (!created.ok) throw new Error(created.error);
    const published = await publishEvent(created.data.id, db);
    if (!published.ok) throw new Error(published.error);

    const questions = await setEventQuestions(
      created.data.id,
      [{ label: "Anything else", type: "text" }],
      db
    );
    if (!questions.ok) throw new Error(questions.error);

    const userId = await makeUser(db, { displayName: "Second Thoughts Sam" });
    const landed = await applyToEvent(
      created.data.id,
      userId,
      { now: new Date("2026-01-01T00:00:00Z"), answers: { [questions.data.questions[0].id]: "As submitted" } },
      db
    );
    if (!landed.ok) throw new Error(landed.error);

    return {
      event: { id: created.data.id, slug: published.data.slug },
      questionId: questions.data.questions[0].id,
      userId,
    };
  }

  async function storedAnswers(eventId: string, userId: string) {
    const [row] = await db
      .select({ answers: applications.answers })
      .from(applications)
      .where(and(eq(applications.eventId, eventId), eq(applications.userId, userId)));
    return row?.answers ?? null;
  }

  it("saves the change, tells nobody and logs nothing", async () => {
    // UC-13 4: "System saves it." No seat moved, so there is no decision to
    // announce (R-100 is about where an application *landed*) and nothing a
    // manager needs in the audit log.
    const { event, questionId, userId } = await applied();
    state.userId = userId;
    sent.decided.mockClear();
    const before = await auditFor(event.id);

    const result = await editApplicationAction({
      eventId: event.id,
      slug: event.slug,
      answers: { [questionId]: "Bringing a spare keyboard" },
      availability: {},
    });

    expect(result.ok).toBe(true);
    expect(await storedAnswers(event.id, userId)).toEqual({
      [questionId]: "Bringing a spare keyboard",
    });
    expect(sent.decided).not.toHaveBeenCalled();
    expect(await auditFor(event.id)).toHaveLength(before.length);
  });

  it("refuses the same call once sign-ups have closed, and writes nothing", async () => {
    /*
     * UC-13 4a. The page has already stopped offering the form by now; this is
     * the direct POST that does not care. The refusal has to come from the
     * server, and it has to leave the stored answer alone.
     */
    const { event, questionId, userId } = await applied({
      closesAt: new Date("2026-02-01T00:00:00Z"),
    });
    state.userId = userId;

    const result = await editApplicationAction({
      eventId: event.id,
      slug: event.slug,
      answers: { [questionId]: "Changed my mind" },
      availability: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/closed/i);
    expect(await storedAnswers(event.id, userId)).toEqual({ [questionId]: "As submitted" });
  });

  it("edits the caller's own application and nobody else's", async () => {
    // There is no application id in the signature, so there is nothing to
    // point at somebody else's row: the session decides whose is found.
    const { event, questionId, userId } = await applied();
    const other = await makeUser(db, { displayName: "Bystander Bo" });
    const landed = await applyToEvent(
      event.id,
      other,
      { now: new Date("2026-01-01T00:00:00Z"), answers: { [questionId]: "Theirs" } },
      db
    );
    if (!landed.ok) throw new Error(landed.error);

    state.userId = userId;
    const result = await editApplicationAction({
      eventId: event.id,
      slug: event.slug,
      answers: { [questionId]: "Mine" },
      availability: {},
    });

    expect(result.ok).toBe(true);
    expect(await storedAnswers(event.id, userId)).toEqual({ [questionId]: "Mine" });
    expect(await storedAnswers(event.id, other)).toEqual({ [questionId]: "Theirs" });
  });
});
