import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, auditLog, championships, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { addHost } from "@/lib/hosting";

/*
 * UC-32 through the event editor's Championship section. Mocked as
 * `host-scope.test.ts` does: the session, `@/db`'s handle and the page cache.
 *
 * What is under test here is the half only this layer knows — that the person
 * pressing the button is the one who manages *that event*, and what the log
 * says afterwards. Which events may count, and for how much, is
 * `src/lib/__tests__/championship-events.test.ts`'s.
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

const {
  addEventToChampionshipAction,
  removeEventFromChampionshipAction,
  saveEventChampionshipAction,
} = await import("../actions");
const { championshipOfEvent } = await import("@/lib/championships");

let handle: TestDatabase;
let db: Database;
let hostId: string;
let strangerId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  hostId = await makeUser(db, { displayName: "Hosting Hattie" });
  strangerId = await makeUser(db, { displayName: "Passing Pete" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = hostId;
});

/** A season nothing else in this file has used. */
async function aSeason(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(championships)
    .values({ slug: `counts-${counter}`, name: `Counts season ${counter}`, status: "published" })
    .returning({ id: championships.id });
  return row.id;
}

/** An event hosted by the signed-in manager, unless `hosted` says otherwise. */
async function anEvent(title = "Rivals night", hosted = true): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `counts-event-${counter}`, title })
    .returning({ id: events.id });
  if (hosted) await addHost(row.id, hostId, null, db);
  return row.id;
}

function auditFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

describe("a host putting their own event into a season", () => {
  it("counts it and logs who did it", async () => {
    // UC-32 1-2: the actor is an admin *or the host of that event*.
    const seasonId = await aSeason();
    const eventId = await anEvent("Rivals night");

    const result = await addEventToChampionshipAction(eventId, seasonId);

    expect(result).toEqual({ ok: true, data: null });
    expect((await championshipOfEvent(eventId, db))?.season.id).toBe(seasonId);
    const lines = await auditFor(eventId, "championship.event.added");
    expect(lines).toHaveLength(1);
    expect(lines[0].actorUserId).toBe(hostId);
    expect(lines[0].summary).toContain("Rivals night");
  });

  it("sets the weight and says so in the log", async () => {
    // UC-32 3.
    const seasonId = await aSeason();
    const eventId = await anEvent("Whole-day tournament");
    expect((await addEventToChampionshipAction(eventId, seasonId)).ok).toBe(true);

    const result = await saveEventChampionshipAction(eventId, { weight: 2 });

    expect(result.ok).toBe(true);
    expect((await championshipOfEvent(eventId, db))?.weight).toBe(2);
    expect((await auditFor(eventId, "championship.event.changed"))[0].summary).toContain(
      "weight 2"
    );
  });

  it("takes it out again and logs that too", async () => {
    // UC-32 4a.
    const seasonId = await aSeason();
    const eventId = await anEvent();
    expect((await addEventToChampionshipAction(eventId, seasonId)).ok).toBe(true);

    const result = await removeEventFromChampionshipAction(eventId);

    expect(result.ok).toBe(true);
    expect(await championshipOfEvent(eventId, db)).toBeNull();
    expect(await auditFor(eventId, "championship.event.removed")).toHaveLength(1);
  });

  it("logs nothing when the weight is refused", async () => {
    // UC-32 3b. A refusal must leave no trace of a change that never happened.
    const seasonId = await aSeason();
    const eventId = await anEvent();
    expect((await addEventToChampionshipAction(eventId, seasonId)).ok).toBe(true);

    const result = await saveEventChampionshipAction(eventId, { weight: 0 });

    expect(result.ok).toBe(false);
    expect(await auditFor(eventId, "championship.event.changed")).toEqual([]);
  });

  it("logs nothing when the event already counts towards another season", async () => {
    // UC-32 1a.
    const first = await aSeason();
    const second = await aSeason();
    const eventId = await anEvent();
    expect((await addEventToChampionshipAction(eventId, first)).ok).toBe(true);

    const result = await addEventToChampionshipAction(eventId, second);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/already counts towards "Counts season \d+"/);
    expect(await auditFor(eventId, "championship.event.added")).toHaveLength(1);
  });
});

describe("somebody who does not manage the event", () => {
  it("is redirected, and nothing is written or logged", async () => {
    const seasonId = await aSeason();
    const eventId = await anEvent("Somebody else's night", false);
    state.userId = strangerId;

    const attempt = addEventToChampionshipAction(eventId, seasonId);

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await championshipOfEvent(eventId, db)).toBeNull();
    expect(await auditFor(eventId, "championship.event.added")).toEqual([]);
  });
});

describe("a season that has been closed", () => {
  it("refuses the write with the message UC-35 2b asks for, and logs nothing", async () => {
    const seasonId = await aSeason();
    const eventId = await anEvent();
    expect((await addEventToChampionshipAction(eventId, seasonId)).ok).toBe(true);
    await db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.id, seasonId));

    const result = await saveEventChampionshipAction(eventId, { weight: 3 });

    expect(result).toEqual({
      ok: false,
      error: "This championship is finished - reopen it to change it",
    });
    expect(await auditFor(eventId, "championship.event.changed")).toEqual([]);
  });
});
