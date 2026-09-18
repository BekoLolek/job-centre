import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, applications, auditLog } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { addHost } from "@/lib/hosting";

/*
 * UC-14 3-6 on an approval event (R-27), through the action the Applicants tab
 * calls, against an in-memory Postgres.
 *
 * Mocked exactly as `status.test.ts` does it — the session, the page cache and
 * `after()` — plus spies on the two side effects, because *which* of them fires
 * for an application that arrived pending is part of what is under test: the
 * applicant is told, and the server is not, since nothing was announced while
 * nobody had decided.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const sent = vi.hoisted(() => ({ decided: vi.fn(), announced: vi.fn() }));

vi.mock("@/lib/notify-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify-events")>()),
  notifyApplicationDecided: sent.decided,
}));

vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  announceApplicationDecision: sent.announced,
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

const { decideApplicationAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");

let handle: TestDatabase;
let db: Database;
let hostId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  hostId = await makeUser(db, { displayName: "Deciding Dana" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = hostId;
  sent.decided.mockClear();
  sent.announced.mockClear();
});

/** A published approval event with one application awaiting review (UC-12 7b). */
async function awaitingReview(): Promise<{
  eventId: string;
  applicationId: string;
  applicantId: string;
}> {
  counter += 1;
  const event = await createEvent(
    {
      ...PUBLISHABLE,
      title: `Approval night ${counter}`,
      capacity: 4,
      config: { entryMode: "approval" },
    },
    db
  );
  if (!event.ok) throw new Error(event.error);
  const published = await publishEvent(event.data.id, db);
  if (!published.ok) throw new Error(published.error);
  await addHost(event.data.id, hostId, null, db);

  const applicantId = await makeUser(db, { displayName: `Hopeful ${counter}` });
  const application = await applyToEvent(event.data.id, applicantId, {}, db);
  if (!application.ok) throw new Error(application.error);
  if (application.data.status !== "pending") {
    throw new Error(`Expected a pending application, got ${application.data.status}.`);
  }

  return { eventId: event.data.id, applicationId: application.data.id, applicantId };
}

async function statusOf(applicationId: string): Promise<string> {
  const [row] = await db.select().from(applications).where(eq(applications.id, applicationId));
  return row.status;
}

async function auditFor(applicationId: string) {
  return db.select().from(auditLog).where(eq(auditLog.subject, applicationId));
}

describe("a manager deciding an application that is awaiting review", () => {
  it("accepts them into a seat, logs it and tells them", async () => {
    // UC-14 3-4.
    const { eventId, applicationId, applicantId } = await awaitingReview();

    const result = await decideApplicationAction(applicationId, "accepted", {});

    expect(result.ok && result.data.status).toBe("accepted");
    expect(await statusOf(applicationId)).toBe("accepted");
    const audit = await auditFor(applicationId);
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toMatch(/^Accepted Hopeful/);
    expect(sent.decided).toHaveBeenCalledWith(eventId, applicantId, "accepted");
  });

  it("queues them at the back of the waitlist instead, and tells them", async () => {
    const { eventId, applicationId, applicantId } = await awaitingReview();

    const result = await decideApplicationAction(applicationId, "waitlisted", {});

    expect(result.ok && result.data.status).toBe("waitlisted");
    const [row] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId));
    expect(row.waitlistPosition).toBe(1);
    expect(sent.decided).toHaveBeenCalledWith(eventId, applicantId, "waitlisted");
  });

  it("declines them, and tells them that too", async () => {
    // UC-14 5-6.
    const { eventId, applicationId, applicantId } = await awaitingReview();

    const result = await decideApplicationAction(applicationId, "declined", {});

    expect(result.ok && result.data.status).toBe("declined");
    expect((await auditFor(applicationId))[0].summary).toMatch(/^Declined Hopeful/);
    expect(sent.decided).toHaveBeenCalledWith(eventId, applicantId, "declined");
  });

  it("refuses to move one back to awaiting review, telling nobody", async () => {
    // docs/diagrams/application-state.md has no edge into pending.
    const { applicationId } = await awaitingReview();

    const result = await decideApplicationAction(
      applicationId,
      "pending" as unknown as "accepted",
      {}
    );

    expect(result.ok).toBe(false);
    expect(await statusOf(applicationId)).toBe("pending");
    expect(await auditFor(applicationId)).toEqual([]);
    expect(sent.decided).not.toHaveBeenCalled();
    expect(sent.announced).not.toHaveBeenCalled();
  });
});
