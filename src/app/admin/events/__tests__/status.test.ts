import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, type EventStatus, auditLog, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { addHost } from "@/lib/hosting";

/*
 * UC-09 through the status control, for real against an in-memory Postgres.
 * Mocked as `host-scope.test.ts` does: the session, the page cache and
 * `after()`. The notification and announcement triggers are spied on, because
 * whether a refused move fires them is part of what is under test.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const sent = vi.hoisted(() => ({
  cancelled: vi.fn(),
  published: vi.fn(),
  announced: vi.fn(),
}));

vi.mock("@/lib/notify-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify-events")>()),
  notifyEventCancelled: sent.cancelled,
  notifyEventPublished: sent.published,
}));

vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  announceEventPublished: sent.announced,
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

const { setEventStatusAction } = await import("../actions");

let handle: TestDatabase;
let db: Database;
let hostId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  hostId = await makeUser(db, { displayName: "Reopening Rita" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = hostId;
  sent.cancelled.mockClear();
  sent.published.mockClear();
  sent.announced.mockClear();
});

/** An event in the given status, hosted by the signed-in manager. */
async function eventIn(status: EventStatus): Promise<string> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({ slug: `status-${counter}`, title: `Status ${counter}`, status })
    .returning({ id: events.id });
  await addHost(event.id, hostId, null, db);
  return event.id;
}

describe("the status control", () => {
  it("reopens a completed event to running and records who reopened it", async () => {
    // UC-09 6a.
    const eventId = await eventIn("complete");

    const result = await setEventStatusAction(eventId, "complete", "live");

    expect(result).toEqual({ ok: true, data: { status: "live" } });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "event.reopened")));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(hostId);
    expect(rows[0].summary).toContain("Reopening Rita");
  });

  it("lets only one of two managers move a published event at the same time", async () => {
    // One presses Cancel and the other Mark running, both from the same page.
    const eventId = await eventIn("published");

    const [cancel, run] = await Promise.all([
      setEventStatusAction(eventId, "published", "cancelled"),
      setEventStatusAction(eventId, "published", "live"),
    ]);

    expect([cancel.ok, run.ok].filter(Boolean)).toHaveLength(1);
    const winner: EventStatus = cancel.ok ? "cancelled" : "live";
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.status).toBe(winner);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "event.status")));
    expect(audits.map((audit) => audit.detail)).toEqual([{ status: winner }]);
    expect(sent.cancelled).toHaveBeenCalledTimes(winner === "cancelled" ? 1 : 0);
  });

  it("refuses a second Cancel from a stale page, with no new audit line or notice", async () => {
    const eventId = await eventIn("published");
    expect((await setEventStatusAction(eventId, "published", "cancelled")).ok).toBe(true);
    sent.cancelled.mockClear();

    const again = await setEventStatusAction(eventId, "published", "cancelled");

    expect(again).toEqual({ ok: false, error: "The event changed meanwhile - reload." });
    const audits = await db.select().from(auditLog).where(eq(auditLog.eventId, eventId));
    expect(audits).toHaveLength(1);
    expect(sent.cancelled).not.toHaveBeenCalled();
  });

  it("refuses a move to the status the event already has, with no side effects", async () => {
    const eventId = await eventIn("cancelled");

    const result = await setEventStatusAction(eventId, "cancelled", "cancelled");

    expect(result.ok).toBe(false);
    expect(await db.select().from(auditLog).where(eq(auditLog.eventId, eventId))).toEqual([]);
    expect(sent.cancelled).not.toHaveBeenCalled();
  });

  it("refuses a call with no `from`, writing and sending nothing", async () => {
    // Server actions are public endpoints; the arguments are whatever was sent.
    const eventId = await eventIn("published");

    const result = await setEventStatusAction(
      eventId,
      undefined as unknown as EventStatus,
      "cancelled"
    );

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.status).toBe("published");
    expect(await db.select().from(auditLog).where(eq(auditLog.eventId, eventId))).toEqual([]);
    expect(sent.cancelled).not.toHaveBeenCalled();
  });

  it("refuses a `from` that is not a status, writing and sending nothing", async () => {
    const eventId = await eventIn("published");

    const result = await setEventStatusAction(
      eventId,
      "archived" as unknown as EventStatus,
      "cancelled"
    );

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.status).toBe("published");
    expect(await db.select().from(auditLog).where(eq(auditLog.eventId, eventId))).toEqual([]);
    expect(sent.cancelled).not.toHaveBeenCalled();
  });

  it("refuses to publish an event missing its setup, and lists what is missing", async () => {
    // UC-09 2a.
    const eventId = await eventIn("draft");

    const result = await setEventStatusAction(eventId, "draft", "published");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/at least one day with a start time/);
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row.status).toBe("draft");
  });
});
