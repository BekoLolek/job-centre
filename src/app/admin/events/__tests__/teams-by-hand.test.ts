import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, teamMembers, teams } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 18 at the action level — UC-15 1, 2, 5, 6.
 *
 * The actions run for real against an in-memory Postgres, with only what cannot
 * run outside a Next request replaced: the session cookie, the page cache and
 * `after()`. `@/db`'s `db` is pointed at this file's database the same way
 * `host-scope.test.ts` does it, a proxy that binds to the live handle on first
 * use.
 *
 * What is proved here rather than in `src/lib/__tests__/draft.test.ts` is the
 * half that only exists in this layer: which event the write is authorised on,
 * and which event its audit line is tagged with. The rules themselves are the
 * library's and are tested there.
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
  placeOnRosterAction,
  previewTeamCountAction,
  removeFromRosterAction,
  setTeamCountAction,
} = await import("../draft-actions");
const { applyToEvent, createEvent, publishEvent, setApplicationStatus } = await import(
  "@/lib/events"
);
const { getTeams, setCaptains } = await import("@/lib/draft");

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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

type Fixture = {
  eventId: string;
  /** Accepted applicants, in application order. */
  members: string[];
  /** Their display names, by user id — what an audit line should say. */
  names: Map<string, string>;
  /** The member whose application was left waitlisted. */
  waitlisted: string;
  /** The person who may manage this event — its host, not an admin. */
  host: string;
};

/** A published event with four accepted applicants, one waitlisted, and a host. */
async function hostedEvent(): Promise<Fixture> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `By hand ${counter}` }, db)
  );
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  const names = new Map<string, string>();
  for (let index = 0; index < 4; index += 1) {
    const displayName = `Hand ${counter}-${index}`;
    const userId = await makeUser(db, { displayName });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
    names.set(userId, displayName);
  }

  const waitlisted = await makeUser(db, { displayName: `Queued ${counter}` });
  const application = unwrap(await applyToEvent(event.id, waitlisted, {}, db));
  unwrap(await setApplicationStatus(application.id, "waitlisted", {}, db));

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);

  return { eventId: event.id, members, names, waitlisted, host };
}

/** Two counted teams, captained by the first two applicants. */
async function withTeams(fixture: Fixture): Promise<{ a: string; b: string }> {
  const written = unwrap(await setTeamCountAction(fixture.eventId, 2));
  const [a, b] = written.teams;
  unwrap(
    await setCaptains(
      fixture.eventId,
      [
        { teamId: a.id, userId: fixture.members[0] },
        { teamId: b.id, userId: fixture.members[1] },
      ],
      db
    )
  );
  return { a: a.id, b: b.id };
}

async function auditFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

async function rosterOf(eventId: string, userId: string) {
  return db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* The count (UC-15 1, 2)                                             */
/* ------------------------------------------------------------------ */

describe("setting the team count", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await hostedEvent();
  });

  beforeEach(() => {
    state.userId = fixture.host;
  });

  it("creates the teams and hands back their ids (UC-15 1, 2)", async () => {
    const result = unwrap(await setTeamCountAction(fixture.eventId, 3));

    expect(result.added).toBe(3);
    expect(result.teams.map((team) => team.name)).toEqual(["Team 1", "Team 2", "Team 3"]);
    // Ids, not just names: the tab adopts these, and without them its next
    // save would delete the rows it just created.
    expect(result.teams.every((team) => team.id.length > 0)).toBe(true);
  });

  it("logs the change against the event", async () => {
    const before = (await auditFor(fixture.eventId, "team.count")).length;

    unwrap(await setTeamCountAction(fixture.eventId, 4));

    const rows = await auditFor(fixture.eventId, "team.count");
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1].summary).toBe("Set the event to 4 teams, adding 1.");
  });

  it("logs nothing when the count is already what was asked for", async () => {
    const before = (await auditFor(fixture.eventId, "team.count")).length;

    const result = unwrap(await setTeamCountAction(fixture.eventId, 4));

    expect(result).toMatchObject({ added: 0, removed: 0 });
    expect(await auditFor(fixture.eventId, "team.count")).toHaveLength(before);
  });

  it("refuses a count outside two to eight without logging anything", async () => {
    const before = (await auditFor(fixture.eventId, "team.count")).length;

    const result = await setTeamCountAction(fixture.eventId, 9);

    expect(result).toEqual({ ok: false, error: "An event needs between 2 and 8 teams." });
    expect(await auditFor(fixture.eventId, "team.count")).toHaveLength(before);
    expect(await getTeams(fixture.eventId, db)).toHaveLength(4);
  });

  it("says what lowering it would clear, before anything is written (UC-15 E1)", async () => {
    const own = await hostedEvent();
    state.userId = own.host;
    await withTeams(own);
    const third = unwrap(await setTeamCountAction(own.eventId, 3)).teams[2];
    unwrap(await placeOnRosterAction(third.id, own.members[2]));

    const preview = await previewTeamCountAction(own.eventId, 2);

    // Lowering to two would drop the third team and the one person on it.
    expect(preview.removed.map((team) => team.id)).toEqual([third.id]);
    expect(preview.clearedMembers).toBe(1);
    expect(preview.anyBlocked).toBe(false);
    // Read-only — the preview is asked *before* the write, so the team and the
    // roster it describes are both still there.
    expect(await getTeams(own.eventId, db)).toHaveLength(3);
    expect(await rosterOf(own.eventId, own.members[2])).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Rosters by hand (UC-15 5, 6)                                       */
/* ------------------------------------------------------------------ */

describe("placing a player on a roster", () => {
  let fixture: Fixture;
  let a: string;
  let b: string;

  beforeAll(async () => {
    fixture = await hostedEvent();
    state.userId = fixture.host;
    ({ a, b } = await withTeams(fixture));
  });

  beforeEach(() => {
    state.userId = fixture.host;
  });

  it("places an accepted player and logs it against the team's event (UC-15 5, 6)", async () => {
    const result = unwrap(await placeOnRosterAction(a, fixture.members[2]));

    expect(result.rosters.filter((row) => row.teamId === a)).toHaveLength(2);
    // The event the line is filed under is the *team's*, which is the only id
    // the action was given — it never takes one from the browser.
    const rows = await auditFor(fixture.eventId, "team.roster");
    expect(rows).toHaveLength(1);
    // Names, not ids — and the team's *current* name, which is the captain's
    // (UC-15 4), read back rather than guessed at so the line cannot pass by
    // matching a word that happens to be nearby.
    const named = (await getTeams(fixture.eventId, db)).find((team) => team.id === a);
    expect(rows[0].summary).toBe(
      `Put ${fixture.names.get(fixture.members[2])} on ${named?.name} by hand.`
    );
  });

  it("moves them, and the line says where from and where to", async () => {
    unwrap(await placeOnRosterAction(b, fixture.members[2]));

    const rows = await auditFor(fixture.eventId, "team.roster");
    const all = await getTeams(fixture.eventId, db);
    const nameOf = (id: string) => all.find((team) => team.id === id)?.name;
    expect(rows[rows.length - 1].summary).toBe(
      `Moved ${fixture.names.get(fixture.members[2])} from ${nameOf(a)} to ${nameOf(b)} by hand.`
    );
    expect(await rosterOf(fixture.eventId, fixture.members[2])).toHaveLength(1);
  });

  it("logs nothing when they are already on that team", async () => {
    const before = (await auditFor(fixture.eventId, "team.roster")).length;

    const result = unwrap(await placeOnRosterAction(b, fixture.members[2]));

    expect(result.rosters.filter((row) => row.userId === fixture.members[2])).toHaveLength(1);
    expect(await auditFor(fixture.eventId, "team.roster")).toHaveLength(before);
  });

  it("refuses a waitlisted applicant and writes nothing (R-61)", async () => {
    const result = await placeOnRosterAction(a, fixture.waitlisted);

    expect(result).toEqual({
      ok: false,
      error:
        "Only an accepted applicant can be put on a roster. Accept them on the Applicants tab first.",
    });
    expect(await rosterOf(fixture.eventId, fixture.waitlisted)).toEqual([]);
  });

  it("takes a player off a roster and logs that too", async () => {
    unwrap(await placeOnRosterAction(a, fixture.members[3]));
    const before = (await auditFor(fixture.eventId, "team.roster")).length;

    unwrap(await removeFromRosterAction(a, fixture.members[3]));

    expect(await rosterOf(fixture.eventId, fixture.members[3])).toEqual([]);
    const rows = await auditFor(fixture.eventId, "team.roster");
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1].summary).toBe(
      `Took ${fixture.names.get(fixture.members[3])} off a roster by hand.`
    );
  });
});

/* ------------------------------------------------------------------ */
/* The event comes from the team, never from the request              */
/* ------------------------------------------------------------------ */

describe("a host naming a team from somebody else's event", () => {
  /*
   * UC-21 5a / R-86, and the rule `event-scope.ts` states: authorise on the
   * row you are about to write, never on an id beside it.
   *
   * These two actions are keyed on a team, so there is no event argument to
   * send at all — `requireManagerOfChild` reads the team's own event, and a
   * host of A acting on a team of B is redirected before anything is read or
   * written. The assertion is on B's rows, because the failure this prevents is
   * silent: the guard passes on A, and the write lands on B.
   */
  let mine: Fixture;
  let theirs: Fixture;
  let theirTeam: string;

  beforeAll(async () => {
    mine = await hostedEvent();
    theirs = await hostedEvent();
    state.userId = theirs.host;
    theirTeam = (await withTeams(theirs)).a;
    state.userId = mine.host;
    await withTeams(mine);
  });

  beforeEach(() => {
    state.userId = mine.host;
  });

  it("is refused when placing, and nothing is written or logged", async () => {
    const attempt = placeOnRosterAction(theirTeam, theirs.members[2]);

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await rosterOf(theirs.eventId, theirs.members[2])).toEqual([]);
    expect(await auditFor(theirs.eventId, "team.roster")).toEqual([]);
  });

  it("is refused when removing, and their captain stays on their roster", async () => {
    const attempt = removeFromRosterAction(theirTeam, theirs.members[0]);

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    const rows = await rosterOf(theirs.eventId, theirs.members[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamId: theirTeam, isCaptain: true });
  });

  it("is refused for a team that does not exist at all", async () => {
    // A child that cannot be resolved redirects rather than 404s: telling
    // somebody which ids are real is a small leak.
    const attempt = placeOnRosterAction(
      "00000000-0000-0000-0000-000000000000",
      mine.members[2]
    );

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

/* ------------------------------------------------------------------ */
/* Nothing above wrote outside its own event                          */
/* ------------------------------------------------------------------ */

describe("the whole file's writes", () => {
  it("left every team_members row inside its own team's event", async () => {
    // The composite key makes this impossible at the storage level, so it is
    // cheap to assert and it would catch a resolver that handed the wrong
    // event id to a write that did not re-read the team.
    const rows = await db.select().from(teamMembers);
    const byTeam = new Map(
      (await db.select().from(teams)).map((team) => [team.id, team.eventId])
    );
    expect(rows.filter((row) => byTeam.get(row.teamId) !== row.eventId)).toEqual([]);
  });
});
