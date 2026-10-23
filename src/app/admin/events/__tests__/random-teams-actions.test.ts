import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Database,
  type EventConfig,
  auditLog,
  events,
  matches,
  stages,
  teamMembers,
  teams,
} from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 78 at the action level — R-215, R-216 / UC-41.
 *
 * Set up exactly as `teams-by-hand.test.ts`: the actions run for real against
 * an in-memory Postgres with only what cannot run outside a Next request
 * replaced — the session cookie and the page cache.
 *
 * Three things only exist in this layer and so are proved only here.
 *
 * **That the format round-trips through `events.config` with no migration**,
 * and — the part that is easy to get wrong rather than merely true — that it
 * survives a schedule save and the schedule survives it. `updateEvent` merges
 * a config patch *one level deep*, so a key nested inside `config.format`
 * would be erased the next time the Schedule tab wrote its four fields. The
 * two tests at the bottom of the first block are what hold that.
 *
 * **That the shuffle reads the stored format** rather than a size sent beside
 * the request, so twelve players make two teams at 6v6 and four at 3v3.
 *
 * **That both actions are guarded.** A server action is a public endpoint;
 * render-time gating is not a security boundary.
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

const { randomiseTeamsAction, saveNightFormatAction, setTeamCountAction } = await import(
  "../draft-actions"
);
const { saveScheduleSettingsAction } = await import("../format-actions");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const { teamFormatFrom } = await import("@/lib/events-policy");
const { generateMatches, scheduleSettingsFrom, setStages } = await import("@/lib/format");
const { awardLot, openLot, placeBid, setDraftPool, voidLot } = await import("@/lib/draft");

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

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

type Fixture = { eventId: string; members: string[]; host: string };

/** A published event with `people` accepted applicants and a host. */
async function hostedEvent(people: number): Promise<Fixture> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Random ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, { displayName: `Rand ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;

  return { eventId: event.id, members, host };
}

/** The raw config column, as stored. */
async function storedConfig(eventId: string): Promise<EventConfig> {
  const [row] = await db
    .select({ config: events.config })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.config ?? {};
}

async function auditFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

async function storedTeams(eventId: string) {
  return db.select().from(teams).where(eq(teams.eventId, eventId));
}

/* ------------------------------------------------------------------ */
/* The format, on events.config, with no migration (R-215 / UC-41 1)  */
/* ------------------------------------------------------------------ */

describe("storing the night's format", () => {
  it("saves 3v3 and reads it back, with the comp it implies", async () => {
    const fixture = await hostedEvent(4);

    const saved = unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));

    expect(saved.teamFormat).toEqual({ format: "3v3", teamSize: 3, comp: "1-1-1" });
    // Read back off the row, not off the return value.
    expect(teamFormatFrom(await storedConfig(fixture.eventId))).toEqual({
      format: "3v3",
      teamSize: 3,
      comp: "1-1-1",
    });
  });

  it("lands on events.config as a plain key — which is why no migration was needed", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));

    // No column, no enum, no table: a key in the json the event already
    // carried. `events.config` is typed with an index signature for exactly
    // this.
    expect(await storedConfig(fixture.eventId)).toMatchObject({ teamFormat: "3v3" });
  });

  it("defaults to 6v6 for an event stored before the format existed", async () => {
    const fixture = await hostedEvent(4);
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("teamFormat");
    expect(teamFormatFrom(await storedConfig(fixture.eventId)).format).toBe("6v6");
  });

  it("reads an unrecognised stored value as 6v6 rather than as nothing", async () => {
    const fixture = await hostedEvent(4);
    await db
      .update(events)
      .set({ config: { teamFormat: "11v11" } })
      .where(eq(events.id, fixture.eventId));
    expect(teamFormatFrom(await storedConfig(fixture.eventId)).format).toBe("6v6");
  });

  it("refuses anything that is not one of the two formats", async () => {
    const fixture = await hostedEvent(4);
    expect(refusal(await saveNightFormatAction(fixture.eventId, "5v5"))).toContain("6v6");
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("teamFormat");
  });

  it("survives a schedule save, and leaves the schedule settings alone", async () => {
    /*
     * The merge hazard, pinned. `updateEvent` writes
     * `{ ...current.config, ...patch.config }` — one level deep — and
     * `saveScheduleSettingsAction` replaces the whole `config.format` object
     * every time it runs. A `teamFormat` nested in there would vanish here,
     * silently, the first time anybody opened the Schedule tab.
     */
    const fixture = await hostedEvent(4);
    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));

    unwrap(
      await saveScheduleSettingsAction(fixture.eventId, {
        timing: scheduleSettingsFrom(null).timing,
        concurrentLobbies: 3,
        days: 2,
        blockDays: null,
      })
    );

    expect(teamFormatFrom(await storedConfig(fixture.eventId)).format).toBe("3v3");
    expect(scheduleSettingsFrom(await storedConfig(fixture.eventId))).toMatchObject({
      concurrentLobbies: 3,
      days: 2,
    });
  });

  it("does not disturb the schedule settings when the format is saved after them", async () => {
    const fixture = await hostedEvent(4);
    unwrap(
      await saveScheduleSettingsAction(fixture.eventId, {
        timing: scheduleSettingsFrom(null).timing,
        concurrentLobbies: 4,
        days: 3,
        blockDays: [1, 2],
      })
    );

    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));

    expect(scheduleSettingsFrom(await storedConfig(fixture.eventId))).toMatchObject({
      concurrentLobbies: 4,
      days: 3,
      blockDays: [1, 2],
    });
    expect(teamFormatFrom(await storedConfig(fixture.eventId)).format).toBe("3v3");
  });

  it("records who set it, and logs nothing when it did not change", async () => {
    const fixture = await hostedEvent(4);

    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));
    const first = await auditFor(fixture.eventId, "event.format");
    expect(first).toHaveLength(1);
    expect(first[0].summary).toContain("3v3");
    expect(first[0].summary).toContain("1-1-1");
    expect(first[0].actorUserId).toBe(fixture.host);

    // Saving the figure already stored should not leave a line claiming it
    // changed — the rule `team.count` already follows.
    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));
    expect(await auditFor(fixture.eventId, "event.format")).toHaveLength(1);
  });

  it("is refused for somebody who does not manage the event", async () => {
    const fixture = await hostedEvent(4);
    state.userId = await makeUser(db, { displayName: "Stranger" });

    await expect(saveNightFormatAction(fixture.eventId, "3v3")).rejects.toThrow();
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("teamFormat");

    state.userId = fixture.host;
  });
});

/* ------------------------------------------------------------------ */
/* The shuffle reads the stored format (R-216 / UC-41 6)              */
/* ------------------------------------------------------------------ */

describe("shuffling through the action", () => {
  it("makes two teams of six at 6v6", async () => {
    const fixture = await hostedEvent(12);

    const result = unwrap(await randomiseTeamsAction(fixture.eventId, false));

    expect(result.teams).toHaveLength(2);
    expect(result.rosters).toHaveLength(12);
    expect(result.short).toEqual([]);
  });

  it("makes four teams of three once 3v3 is stored — the same twelve people", async () => {
    /*
     * The acceptance criterion that the format is the admin's choice and not a
     * head count: the head count is identical to the test above and the answer
     * is different, because the stored format changed.
     */
    const fixture = await hostedEvent(12);
    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));

    const result = unwrap(await randomiseTeamsAction(fixture.eventId, false));

    expect(result.teams).toHaveLength(4);
    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.eventId, fixture.eventId));
    expect(rows).toHaveLength(12);
  });

  it("reports which teams are short before the admin reads a roster (UC-41 4a)", async () => {
    const fixture = await hostedEvent(16);

    const result = unwrap(await randomiseTeamsAction(fixture.eventId, false));

    expect(result.teams).toHaveLength(3);
    expect(result.short).toEqual([2, 3]);
  });

  it("records the shuffle, naming the format and the teams", async () => {
    const fixture = await hostedEvent(12);
    unwrap(await randomiseTeamsAction(fixture.eventId, false));

    const rows = await auditFor(fixture.eventId, "team.random");
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain("6v6");
    expect(rows[0].summary).toContain("2 random teams");
    expect(rows[0].actorUserId).toBe(fixture.host);
  });

  it("refuses to replace teams that exist unless told to, and writes nothing", async () => {
    const fixture = await hostedEvent(12);
    unwrap(await randomiseTeamsAction(fixture.eventId, false));
    const before = await storedTeams(fixture.eventId);

    const error = refusal(await randomiseTeamsAction(fixture.eventId, false));
    expect(error).toContain("2 teams");

    const after = await storedTeams(fixture.eventId);
    expect(after.map((team) => team.id).sort()).toEqual(
      before.map((team) => team.id).sort()
    );
  });

  it("replaces them when the confirmation says so (UC-41 3a, 5a)", async () => {
    const fixture = await hostedEvent(12);
    const first = unwrap(await randomiseTeamsAction(fixture.eventId, false));

    const second = unwrap(await randomiseTeamsAction(fixture.eventId, true));

    expect(second.discarded).toBe(2);
    expect(second.teams).toHaveLength(2);
    // Fresh rows, not the old ones reused.
    expect(second.teams.map((team) => team.id)).not.toEqual(
      first.teams.map((team) => team.id)
    );
    expect(await storedTeams(fixture.eventId)).toHaveLength(2);
  });

  it("refuses too few players, naming both numbers, and writes nothing", async () => {
    const fixture = await hostedEvent(4);

    const error = refusal(await randomiseTeamsAction(fixture.eventId, false));

    expect(error).toContain("4");
    expect(error).toContain("6");
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });

  it("is refused for somebody who does not manage the event", async () => {
    const fixture = await hostedEvent(12);
    state.userId = await makeUser(db, { displayName: "Stranger too" });

    await expect(randomiseTeamsAction(fixture.eventId, true)).rejects.toThrow();
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);

    state.userId = fixture.host;
  });
});

/* ------------------------------------------------------------------ */
/* The release rolls back with the refusal (decision 004)             */
/* ------------------------------------------------------------------ */

describe("releasing the matches is part of the transaction", () => {
  /** Two teams, a round robin generated over them, in one match. */
  async function withMatches(fixture: Fixture): Promise<string[]> {
    unwrap(await setTeamCountAction(fixture.eventId, 2));
    const written = unwrap(
      await setStages(fixture.eventId, [{ kind: "round_robin", config: { bestOf: 1 } }], db)
    );
    unwrap(await generateMatches(written[0].id, db));

    const rows = await db
      .select()
      .from(matches)
      .innerJoin(stages, eq(matches.stageId, stages.id))
      .where(eq(stages.eventId, fixture.eventId));
    return rows.map((row) => row.matches.id);
  }

  /** The team ids each generated match names, so a release is visible. */
  async function named(eventId: string): Promise<Array<string | null>> {
    const rows = await db
      .select({ a: matches.teamAId, b: matches.teamBId })
      .from(matches)
      .innerJoin(stages, eq(matches.stageId, stages.id))
      .where(eq(stages.eventId, eventId));
    return rows.flatMap((row) => [row.a, row.b]);
  }

  it("leaves the matches naming their teams when the shuffle is refused", async () => {
    /*
     * The reachable `docs/decisions/004` exposure in this feature, and the one
     * that made the hook necessary.
     *
     * `matches.team_a_id` has no `on delete` action, so the team references
     * have to be released before any team can be deleted. Run *before*
     * `assignRandomTeams` — the obvious shape, and the one
     * `setTeamCountAction` uses — that release is a write with no transaction
     * around it, so a shuffle the library then refuses leaves the matches
     * stripped of their teams and the admin told nothing changed.
     *
     * Here the refusal arrives from `setTeams` *after* the release has
     * written: the lot below is voided, so the awarded-lot gate passes, but
     * `removeTeamsIn` will not delete a team that a lot names as a winner at
     * any status. The assertion is that the match still names both teams.
     */
    const fixture = await hostedEvent(12);
    await withMatches(fixture);
    const before = await named(fixture.eventId);
    expect(before.filter(Boolean)).toHaveLength(2);

    const written = await storedTeams(fixture.eventId);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[5] }, db));
    unwrap(await placeBid(lot.id, written[0].id, 10, {}, db));
    unwrap(await awardLot(lot.id, written[0].id, {}, db));
    unwrap(await voidLot(lot.id, {}, db));

    const error = refusal(await randomiseTeamsAction(fixture.eventId, true));
    expect(error).toContain("has already drafted players");

    // Rolled back with the refusal: the release is undone, so the match still
    // names the two teams it was generated over.
    expect(await named(fixture.eventId)).toEqual(before);
    expect(await storedTeams(fixture.eventId)).toHaveLength(2);
  });

  it("releases them when the shuffle goes through, and the sync rebuilds", async () => {
    // The control: the hook really does write on the path that succeeds, so
    // the test above is about ordering rather than about a hook that never
    // runs.
    const fixture = await hostedEvent(12);
    await withMatches(fixture);
    expect((await named(fixture.eventId)).filter(Boolean)).toHaveLength(2);

    const result = unwrap(await randomiseTeamsAction(fixture.eventId, true));

    expect(result.teams).toHaveLength(2);
    // `followTeams` regenerates the round robin over the teams that now exist,
    // so the matches name the *new* teams rather than the discarded ones.
    const after = (await named(fixture.eventId)).filter(Boolean) as string[];
    const live = new Set(result.teams.map((team) => team.id));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((teamId) => live.has(teamId))).toBe(true);
  });
});
