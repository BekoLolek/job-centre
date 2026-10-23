import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, type EventConfig, auditLog, teamMembers, teams } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 81 at the action level — R-220 / UC-42 6.
 *
 * Set up exactly as `random-teams-actions.test.ts`: the actions run for real
 * against an in-memory Postgres with only what cannot run outside a Next
 * request replaced — the session cookie, the page cache and `after()`.
 *
 * Two things exist only in this layer and so are proved only here.
 *
 * **That the button's action reaches Task 78's shuffle.** `randomiseTeamsAction`
 * is where the real `Math.random` is handed in, and `shuffled` in
 * `random-teams.ts` is the only thing in the application that reads it. So
 * the global is replaced with a thrower for one call: the action dies on it,
 * and nothing is written. A second shuffle beside Task 78's would either not
 * die or not be reached.
 *
 * **That the action sizes from the Format panel.** The library test proves
 * `assignRandomTeams` does; this proves the action no longer hands a size in
 * over the top of it — the same twelve people make three teams once the
 * panel says "3 teams", with nothing sent beside the request.
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

const { randomiseTeamsAction, setTeamCountAction } = await import("../draft-actions");
const { saveEventShapeAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const { getTeams, teamsFillOf } = await import("@/lib/draft");
const { getEventById } = await import("@/lib/events");

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

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

type Fixture = { eventId: string; members: string[]; host: string };

/** A published event with `people` accepted applicants and a host reading it. */
async function hostedEvent(people: number): Promise<Fixture> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Three ways ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, { displayName: `Way ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  return { eventId: event.id, members, host };
}

async function storedTeams(eventId: string) {
  return db.select().from(teams).where(eq(teams.eventId, eventId));
}

async function rosterRows(eventId: string) {
  return db.select().from(teamMembers).where(eq(teamMembers.eventId, eventId));
}

/** The fill exactly as the page computes it. */
async function fillOf(eventId: string) {
  const event = await getEventById(eventId);
  return teamsFillOf(await getTeams(eventId), (event?.config ?? {}) as EventConfig);
}

const THREE_TEAMS = { teamEvent: true, draft: true, mode: "teams", value: 3 } as const;

/* ------------------------------------------------------------------ */
/* The action reaches Task 78's shuffle                               */
/* ------------------------------------------------------------------ */

describe("the random route through the action", () => {
  it("dies on a Math.random that throws, with nothing written", async () => {
    const fixture = await hostedEvent(12);
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("the shuffle asked for a number");
    });

    await expect(randomiseTeamsAction(fixture.eventId, false)).rejects.toThrow(
      "the shuffle asked for a number"
    );

    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
    expect(await rosterRows(fixture.eventId)).toHaveLength(0);
    // The marker went with the rollback too.
    expect((await getEventById(fixture.eventId))?.config).not.toHaveProperty("randomFill");
  });

  it("sizes from the Format panel with nothing sent beside the request", async () => {
    const fixture = await hostedEvent(12);
    unwrap(await saveEventShapeAction(fixture.eventId, THREE_TEAMS));

    const result = unwrap(await randomiseTeamsAction(fixture.eventId, false));

    expect(result.teams).toHaveLength(3);
    expect(result.rosters).toHaveLength(12);
    const [line] = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, fixture.eventId), eq(auditLog.action, "team.random")));
    expect(line.summary).toContain("3 random teams");
    expect(line.summary).toContain("sized by 3 teams");
  });
});

/* ------------------------------------------------------------------ */
/* The three routes agree about the teams, and the page can say which */
/* ------------------------------------------------------------------ */

describe("the three routes through the actions", () => {
  it("fills the same teams by hand and at random, and the fill says which", async () => {
    const fixture = await hostedEvent(12);
    unwrap(await saveEventShapeAction(fixture.eventId, THREE_TEAMS));

    // By hand: the count the panel says, then empty rosters.
    unwrap(await setTeamCountAction(fixture.eventId, 3));
    expect(await fillOf(fixture.eventId)).toEqual({ route: "empty" });

    // At random, over them: the same three teams' worth, now dealt.
    const shuffled = unwrap(await randomiseTeamsAction(fixture.eventId, true));
    expect(shuffled.discarded).toBe(3);
    expect(shuffled.teams).toHaveLength(3);
    expect(await fillOf(fixture.eventId)).toMatchObject({
      route: "random",
      dealt: 12,
      byHandSince: 0,
    });
  });

  it("refuses a count the panel contradicts through the action too, with nothing written", async () => {
    const fixture = await hostedEvent(12);
    unwrap(await saveEventShapeAction(fixture.eventId, THREE_TEAMS));

    const result = await setTeamCountAction(fixture.eventId, 4);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBe(
      "Setup → Format says this event has 3 teams, so it cannot be set to 4 here. Change it there, or make it 3."
    );
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });
});
