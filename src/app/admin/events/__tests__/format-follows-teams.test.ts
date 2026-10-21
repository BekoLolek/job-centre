import { asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, matchGames, matches, stages } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * **Task 21's acceptance criterion, at the layer it is about.**
 *
 * "Changing the teams with the Format tab never opened leaves the matches
 * current" (R-73 / UC-18 8, 9). That sentence is a statement about server
 * actions, not about a screen: the only way to prove it is to change the teams
 * through the action the Teams tab calls, import nothing from the Format tab at
 * all, and then look at the rows.
 *
 * The actions run for real against an in-memory Postgres, with only what cannot
 * run outside a Next request replaced: the session cookie, the page cache and
 * `after()`. `@/db`'s `db` is pointed at this file's database the same way
 * `teams-by-hand.test.ts` and `host-scope.test.ts` do it.
 *
 * The rules themselves — what counts as touched, what a rebuild clears — are
 * the library's and are tested in `src/lib/__tests__/format-sync.test.ts`. What
 * is proved here is the wiring: which actions fire the sync, what they log, and
 * which event a rebuild is authorised against.
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

const { placeOnRosterAction, previewTeamCountAction, setTeamCountAction } = await import(
  "../draft-actions"
);
const { previewStagesAction, rebuildStageAction, saveStagesAction } = await import(
  "../format-actions"
);
const { applyToEvent, createEvent, publishEvent, setApplicationStatus } = await import(
  "@/lib/events"
);
const { getTeams } = await import("@/lib/draft");
const { generateMatches, recordGames, setStages } = await import("@/lib/format");

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

beforeEach(() => {
  state.userId = null;
});

let counter = 0;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

type Fixture = { eventId: string; host: string; accepted: string[] };

/** A published event with six accepted applicants and a host who may manage it. */
async function hostedEvent(): Promise<Fixture> {
  counter += 1;
  const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Follows ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));

  const accepted: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const userId = await makeUser(db, { displayName: `Player ${counter}-${index}` });
    const application = unwrap(await applyToEvent(event.id, userId, {}, db));
    unwrap(await setApplicationStatus(application.id, "accepted", {}, db));
    accepted.push(userId);
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);

  return { eventId: event.id, host, accepted };
}

async function rowsIn(eventId: string) {
  return db
    .select()
    .from(matches)
    .where(eq(matches.eventId, eventId))
    .orderBy(asc(matches.slot));
}

async function stageOf(eventId: string) {
  const [row] = await db.select().from(stages).where(eq(stages.eventId, eventId));
  return row;
}

async function lastLine(eventId: string, action: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.eventId, eventId))
    .orderBy(desc(auditLog.at), desc(auditLog.id));
  return row?.action === action ? row : null;
}

/**
 * An event with four teams and a generated round robin over them.
 *
 * The teams are set through the action, because that is the path under test.
 * The stage is set up through the library, because the Format tab is exactly
 * what must not be involved.
 */
async function withRoundRobin(): Promise<Fixture & { stageId: string }> {
  const fixture = await hostedEvent();
  state.userId = fixture.host;
  unwrap(await setTeamCountAction(fixture.eventId, 4));

  const written = unwrap(
    await setStages(fixture.eventId, [{ kind: "round_robin", config: { bestOf: 1 } }], db)
  );
  unwrap(await generateMatches(written[0].id, db));
  return { ...fixture, stageId: written[0].id };
}

/* ------------------------------------------------------------------ */
/* The acceptance criterion                                           */
/* ------------------------------------------------------------------ */

describe("changing the teams leaves the matches current (UC-18 9)", () => {
  it("rebuilds inside the action the Teams tab calls, with no Format tab in sight", async () => {
    const { eventId, stageId } = await withRoundRobin();
    expect(await rowsIn(eventId)).toHaveLength(6);

    const result = unwrap(await setTeamCountAction(eventId, 6));

    // The action itself reports what it did, so the tab can say so.
    expect(result.added).toBe(2);
    expect(result.sync?.rebuilt).toBe(1);
    expect(result.sync?.stages[0].state).toBe("rebuilt");

    // And the rows are the six-team shape. This is the assertion the whole
    // task is for: nothing on the Format tab ran.
    const rows = await rowsIn(eventId);
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.stageId === stageId)).toBe(true);
    // Every pairing of six teams, each naming two real teams.
    expect(rows.every((row) => row.teamAId && row.teamBId)).toBe(true);
  });

  it("follows the teams downwards too, and says so in the log", async () => {
    const { eventId } = await withRoundRobin();
    unwrap(await setTeamCountAction(eventId, 6));
    expect(await rowsIn(eventId)).toHaveLength(15);

    unwrap(await setTeamCountAction(eventId, 3));
    expect(await rowsIn(eventId)).toHaveLength(3);

    const line = await lastLine(eventId, "format.generated");
    expect(line?.summary).toContain("Rebuilt");
    expect(line?.detail).toMatchObject({ rebuilt: 1, outOfDate: 0, created: 3 });
  });

  it("marks the stage out of date instead when a result has been recorded (UC-18 9a)", async () => {
    const { eventId, stageId } = await withRoundRobin();
    const opener = (await rowsIn(eventId)).find((row) => row.slot === "rr-1-2");
    unwrap(await recordGames(opener!.id, [{ index: 0, scoreA: 1, scoreB: 0, played: true }], {}, db));

    const result = unwrap(await setTeamCountAction(eventId, 6));

    expect(result.added).toBe(2);
    expect(result.sync?.rebuilt).toBe(0);
    expect(result.sync?.outOfDate).toBe(1);

    // The teams did change. The matches did not, and the result is still there.
    expect(await getTeams(eventId).then((rows) => rows.length)).toBe(6);
    expect(await rowsIn(eventId)).toHaveLength(6);
    expect((await stageOf(eventId)).outOfDateSince).not.toBeNull();
    const games = await db
      .select()
      .from(matchGames)
      .where(eq(matchGames.matchId, opener!.id));
    expect(games.filter((game) => game.played)).toHaveLength(1);
    expect(stageId).toBe((await stageOf(eventId)).id);

    const line = await lastLine(eventId, "format.generated");
    expect(line?.summary).toContain("out of date");
    expect(line?.detail).toMatchObject({ outOfDate: 1, rebuilt: 0 });
  });

  it("logs nothing when the teams did not actually move", async () => {
    const { eventId } = await withRoundRobin();
    const before = await db.select().from(auditLog).where(eq(auditLog.eventId, eventId));

    // The figure that is already stored. Nothing moved, so nothing is logged —
    // not by the team write, and not by the sync behind it.
    const result = unwrap(await setTeamCountAction(eventId, 4));
    expect(result.sync?.stages[0].state).toBe("current");

    const after = await db.select().from(auditLog).where(eq(auditLog.eventId, eventId));
    expect(after).toHaveLength(before.length);
  });

  it("fires from a hand placement as well (Task 18's path)", async () => {
    const { eventId, accepted } = await withRoundRobin();
    const teamRows = await getTeams(eventId);

    const result = unwrap(await placeOnRosterAction(teamRows[0].id, accepted[0]));
    expect(result.rosters.some((row) => row.userId === accepted[0])).toBe(true);
    // A placement cannot change the shape, so the honest answer is "current" —
    // what matters is that the path reports one at all.
    expect(result.sync?.stages[0].state).toBe("current");
  });
});

/* ------------------------------------------------------------------ */
/* Saving the format                                                  */
/* ------------------------------------------------------------------ */

describe("saveStagesAction (UC-18 5)", () => {
  it("rebuilds the stage it just changed, in the same action", async () => {
    const { eventId, stageId } = await withRoundRobin();
    expect((await rowsIn(eventId)).every((row) => row.bestOf === 1)).toBe(true);

    const saved = unwrap(
      await saveStagesAction(eventId, [
        {
          id: stageId,
          name: "Stage",
          kind: "round_robin",
          config: { bestOf: 3, bestOfByBracket: {} },
        },
      ])
    );

    expect(saved.sync?.rebuilt).toBe(1);
    expect((await rowsIn(eventId)).every((row) => row.bestOf === 3)).toBe(true);
  });

  it("reports the named range when the kind cannot take the team count (UC-18 2a)", async () => {
    const { eventId } = await withRoundRobin();

    const saved = unwrap(
      await saveStagesAction(eventId, [
        { name: "Groups", kind: "group_playoff", config: { groups: 3 } },
      ])
    );

    const refused = saved.sync?.stages.find((stage) => stage.state === "refused");
    expect(refused?.reason).toContain("needs between 6 and 8 teams");
    // Nothing generated for it.
    const fresh = saved.stages.find((stage) => stage.name === "Groups");
    const rows = await db.select().from(matches).where(eq(matches.stageId, fresh!.id));
    expect(rows).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* "Rebuild anyway"                                                   */
/* ------------------------------------------------------------------ */

describe("rebuildStageAction (UC-18 9a)", () => {
  it("clears what the preview listed and logs every result that went", async () => {
    const { eventId, stageId } = await withRoundRobin();
    const opener = (await rowsIn(eventId)).find((row) => row.slot === "rr-1-2");
    unwrap(await recordGames(opener!.id, [{ index: 0, scoreA: 1, scoreB: 0, played: true }], {}, db));
    unwrap(await setTeamCountAction(eventId, 6));

    const [clearing] = await previewStagesAction(eventId);
    expect(clearing.results).toHaveLength(1);
    const scoreline = clearing.results[0].line;

    const rebuilt = unwrap(await rebuildStageAction(stageId, clearing.confirm));
    expect(rebuilt.created).toBe(15);
    expect(await rowsIn(eventId)).toHaveLength(15);
    expect((await stageOf(eventId)).outOfDateSince).toBeNull();

    // The log names the series that was destroyed, because afterwards there is
    // nowhere else to find out.
    const line = await lastLine(eventId, "format.generated");
    expect(line?.summary).toContain(scoreline);
    expect(line?.detail).toMatchObject({ created: 15, playedGames: 1 });
  });

  it("refuses a token from somebody else's view of the stage", async () => {
    const { eventId, stageId } = await withRoundRobin();
    const [clearing] = await previewStagesAction(eventId);

    // A result lands after the preview was taken.
    const opener = (await rowsIn(eventId)).find((row) => row.slot === "rr-1-2");
    unwrap(await recordGames(opener!.id, [{ index: 0, scoreA: 1, scoreB: 0, played: true }], {}, db));

    const result = await rebuildStageAction(stageId, clearing.confirm);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed since you were shown");
    expect(await rowsIn(eventId)).toHaveLength(6);
  });

  it("is authorised on the stage's own event, not on an id sent beside it", async () => {
    /*
     * `event-scope.ts`'s hole, for the most destructive action on the site: a
     * host of one event must not be able to clear another event's results by
     * naming a foreign stage. There is no `eventId` argument at all, so the
     * only thing the guard can read it from is the stage.
     */
    const mine = await withRoundRobin();
    const theirs = await withRoundRobin();

    // The token is a real one, taken by the host who is entitled to it — so
    // the only thing standing between the other host and those rows is the
    // guard, not an unguessable string.
    state.userId = theirs.host;
    const [clearing] = await previewStagesAction(theirs.eventId);

    state.userId = mine.host;
    await expect(rebuildStageAction(theirs.stageId, clearing.confirm)).rejects.toThrow();
    expect(await rowsIn(theirs.eventId)).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* R-161 / UC-15 E1 — what a lower team count clears                  */
/* ------------------------------------------------------------------ */

describe("previewTeamCountAction lists the generated matches too (UC-15 E1)", () => {
  it("names them before anything is written", async () => {
    const { eventId } = await withRoundRobin();

    const impact = await previewTeamCountAction(eventId, 3);

    // One team goes, and it is in three of the six table games.
    expect(impact.removed).toHaveLength(1);
    expect(impact.matches.matches).toBe(3);
    expect(impact.matches.withResults).toBe(0);
    expect(impact.matches.stages[0].matches).toBe(3);
    expect(impact.anyBlocked).toBe(false);

    // Read-only: nothing has gone.
    expect(await rowsIn(eventId)).toHaveLength(6);
  });

  it("says the removal is blocked when one of those matches has a result", async () => {
    const { eventId } = await withRoundRobin();
    // Team 3 v Team 4 — Team 4 is the one a count of 3 would remove.
    const played = (await rowsIn(eventId)).find((row) => row.slot === "rr-3-4");
    unwrap(await recordGames(played!.id, [{ index: 0, scoreA: 1, scoreB: 0, played: true }], {}, db));

    const impact = await previewTeamCountAction(eventId, 3);
    expect(impact.matches.withResults).toBe(1);
    expect(impact.anyBlocked).toBe(true);

    // And the write agrees with the dialog, in a sentence rather than a
    // foreign-key error.
    const result = await setTeamCountAction(eventId, 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("who that result belongs to");
    expect(await getTeams(eventId).then((rows) => rows.length)).toBe(4);
  });
});
