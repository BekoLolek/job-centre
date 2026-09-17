import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, applications, auditLog, events, matchGames, matches, teams } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { generateMatches, matchIdsFor, setStages } from "@/lib/format";
import { addHost } from "@/lib/hosting";

/*
 * The actions run for real against an in-memory Postgres. Only what cannot run
 * outside a Next request is replaced: the session cookie, the page cache, and
 * `after()` — which drops the deferred announcements and notifications, since
 * outside a request they would run detached and race this file's database close.
 * `@/db`'s `db` is pointed at this file's database the same way the real module
 * does it — a proxy that binds to the live handle on first use.
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
  clearMatchAction,
  generateStageAction,
  recordGamesAction,
  reflipMatchAction,
  setWinnerOverrideAction,
} = await import("../format-actions");
const { decideApplicationAction } = await import("../actions");

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

let counter = 0;

/**
 * An event with eight teams and two stages, both generated.
 *
 * The match tests play the first stage; the generate test regenerates only the
 * second, so it neither replaces the rows the others hold ids for nor is refused
 * by the results they record.
 */
async function boardEvent(): Promise<{ eventId: string; finalsId: string; ids: Record<string, string> }> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({ slug: `host-scope-${counter}`, title: `Host scope ${counter}` })
    .returning({ id: events.id });
  for (let i = 1; i <= 8; i += 1) {
    await db.insert(teams).values({ eventId: event.id, name: `Team ${counter}-${i}`, seed: i, sort: i });
  }
  const created = await setStages(
    event.id,
    [
      { kind: "double_elim", name: "Playoffs" },
      { kind: "single_elim", name: "Finals" },
    ],
    db
  );
  if (!created.ok) throw new Error(created.error);
  for (const stage of created.data) {
    const generated = await generateMatches(stage.id, db);
    if (!generated.ok) throw new Error(generated.error);
  }
  return { eventId: event.id, finalsId: created.data[1].id, ids: await matchIdsFor(event.id, db) };
}

async function auditRowsFor(subject: string) {
  return db.select().from(auditLog).where(eq(auditLog.subject, subject));
}

let a: Awaited<ReturnType<typeof boardEvent>>;
let b: Awaited<ReturnType<typeof boardEvent>>;
let hostOfA: string;

beforeAll(async () => {
  a = await boardEvent();
  b = await boardEvent();
  hostOfA = await makeUser(db);
  await addHost(a.eventId, hostOfA, null, db);
});

beforeEach(() => {
  state.userId = hostOfA;
});

/* ------------------------------------------------------------------ */
/* Reads and audit lines follow the child, not the browser            */
/* ------------------------------------------------------------------ */

describe("a host acting on their own event's match or stage", () => {
  // UC-21 5a / R-86: the guard already checks the child's event. Everything
  // after it — the board handed back, the audit line — must use that same
  // verified event, or a host of A reads B's unpublished format by sending B's
  // id. The actions no longer take an event id at all, so these pin that what
  // comes back and what is logged is derived from the child's own event.

  it("generating a stage returns its own event's board and logs against it", async () => {
    const result = await generateStageAction(a.finalsId);

    expect(result.ok && result.data.view?.eventId).toBe(a.eventId);
    expect((await auditRowsFor(a.finalsId)).map((row) => row.eventId)).toEqual([a.eventId]);
  });

  it("recording games returns its own event's board and logs against it", async () => {
    const matchId = a.ids.ubqf1;

    const result = await recordGamesAction(matchId, {
      games: [{ index: 0, scoreA: 1, scoreB: 0, played: true }],
    });

    expect(result.ok && result.data.view?.eventId).toBe(a.eventId);
    expect((await auditRowsFor(matchId)).map((row) => row.eventId)).toEqual([a.eventId]);
  });

  it("overriding a winner returns its own event's board and logs against it", async () => {
    const matchId = a.ids.ubqf2;
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));

    const result = await setWinnerOverrideAction(matchId, match.teamAId);

    expect(result.ok && result.data.view?.eventId).toBe(a.eventId);
    expect((await auditRowsFor(matchId)).map((row) => row.eventId)).toEqual([a.eventId]);
  });

  it("re-flipping a coin returns its own event's board and logs against it", async () => {
    const matchId = a.ids.ubqf3;

    const result = await reflipMatchAction(matchId, "b");

    expect(result.ok && result.data.view?.eventId).toBe(a.eventId);
    expect((await auditRowsFor(matchId)).map((row) => row.eventId)).toEqual([a.eventId]);
  });

  it("clearing a match returns its own event's board and logs against it", async () => {
    const matchId = a.ids.ubqf4;

    const result = await clearMatchAction(matchId, 1);

    expect(result.ok && result.data.view?.eventId).toBe(a.eventId);
    expect((await auditRowsFor(matchId)).map((row) => row.eventId)).toEqual([a.eventId]);
  });
});

describe("a host acting on another event's match", () => {
  // The other half of 5a: a foreign child is refused before anything is written.

  it("is refused, and nothing is recorded or logged", async () => {
    const matchId = b.ids.ubqf1;

    const attempt = recordGamesAction(matchId, {
      games: [{ index: 0, scoreA: 1, scoreB: 0, played: true }],
    });

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await db.select().from(matchGames).where(eq(matchGames.matchId, matchId))).toSatisfy(
      (games: Array<{ played: boolean }>) => games.every((game) => !game.played)
    );
    expect(await auditRowsFor(matchId)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Application decisions                                              */
/* ------------------------------------------------------------------ */

describe("a host deciding an application to their own event", () => {
  // The decision's audit line is what an event's log page filters on, so it
  // must carry the application's own event — the option the screen used to
  // send is gone, so the only place it can come from is the verified scope.

  it("logs the decision against the application's event", async () => {
    const applicant = await makeUser(db);
    const [application] = await db
      .insert(applications)
      .values({ eventId: a.eventId, userId: applicant, status: "waitlisted" })
      .returning({ id: applications.id });

    const result = await decideApplicationAction(application.id, "accepted", {});

    expect(result.ok).toBe(true);
    expect((await auditRowsFor(application.id)).map((row) => row.eventId)).toEqual([a.eventId]);
  });
});
