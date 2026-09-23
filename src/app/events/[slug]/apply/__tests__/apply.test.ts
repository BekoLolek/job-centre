import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, auditLog } from "@/db";
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

const { applyToEventAction } = await import("../actions");
const { createEvent, publishEvent } = await import("@/lib/events");

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
    const event = await openEvent(1);
    const seated = await makeUser(db, { displayName: "Early Eli" });
    const queued = await makeUser(db, { displayName: "Late Lena" });

    await applyAs(seated, event);
    sent.decided.mockClear();
    const result = await applyAs(queued, event);

    expect(result.ok && result.data.status).toBe("waitlisted");
    expect(result.ok && result.data.waitlistPosition).toBe(1);
    expect(sent.decided).toHaveBeenCalledWith(event.id, queued, "waitlisted");

    const audit = await auditFor(event.id);
    expect(audit).toHaveLength(2);
    expect(audit[1].summary).toMatch(/Late Lena applied to .* and joined the queue at number 1\./);
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
