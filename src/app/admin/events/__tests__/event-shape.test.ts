import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, type EventConfig, auditLog, events, teams } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 79's write, and Task 80's "hiding is not permission" — R-217, R-218,
 * R-219 / UC-42 1-5b.
 *
 * Set up exactly as `random-teams-actions.test.ts`: the actions run for real
 * against an in-memory Postgres with only what cannot run outside a Next
 * request replaced — the session cookie, the page cache and `after()`.
 *
 * Four things exist only at this layer and so are proved only here.
 *
 * **That the shape round-trips through `events.config` with no migration**, and
 * the part that is easy to get wrong rather than merely true: that it survives
 * a schedule save and the schedule survives it. `updateEvent` merges a config
 * patch one level deep and `saveScheduleSettingsAction` rewrites the whole of
 * `config.format` on every save, so a shape nested in there would vanish the
 * first time anybody opened the Schedule tab. Task 78 paid for that lesson once.
 *
 * **That the derived figure is nowhere in the row.** The stored object is
 * compared key for key, not merely read back, because "6 per team" and "3
 * teams" cannot drift only while exactly one of them exists.
 *
 * **The two refusals**, in full sentences rather than phrases of them: Task
 * 78's escape was a refusal assertion that a *different* refusal satisfied.
 *
 * **That the actions guard themselves whatever the editor draws** (UC-42 5b).
 * A hidden tab is still reachable by URL and by anybody who kept the page open,
 * and Next's own guidance is blunt about it: "Render-time gating (only
 * rendering a form on an authenticated page) is not a security boundary."
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

const { saveEventShapeAction } = await import("../actions");
const { saveDraftConfigAction, saveNightFormatAction, setTeamCountAction } = await import(
  "../draft-actions"
);
const { saveScheduleSettingsAction } = await import("../format-actions");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const {
  DRAFT_AWARDED_REFUSAL,
  eventShapeFrom,
  sizingConsequence,
  teamFormatFrom,
  teamsInTheWayRefusal,
} = await import("@/lib/events-policy");
const { scheduleSettingsFrom } = await import("@/lib/format");
const { awardLot, openLot, placeBid, setDraftPool } = await import("@/lib/draft");
const { visibleTabs } = await import("@/components/admin/events/tabs");

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
    await createEvent({ ...PUBLISHABLE, title: `Shape ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, { displayName: `Shaped ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  return { eventId: event.id, members, host };
}

async function storedConfig(eventId: string): Promise<EventConfig> {
  const [row] = await db.select({ config: events.config }).from(events).where(eq(events.id, eventId));
  return row.config;
}

const TEAMS = { teamEvent: true, draft: true, mode: "perTeam", value: 6 } as const;

/* --------------------------------------------------------------------- */
/* It persists, with no migration (UC-42 1-3)                            */
/* --------------------------------------------------------------------- */

describe("storing the shape", () => {
  it("round-trips the three decisions", async () => {
    const fixture = await hostedEvent(4);
    const saved = unwrap(
      await saveEventShapeAction(fixture.eventId, {
        teamEvent: true,
        draft: false,
        mode: "teams",
        value: 3,
      })
    );

    expect(saved.shape).toEqual({
      teamEvent: true,
      draft: false,
      sizing: { mode: "teams", value: 3 },
    });
    expect(eventShapeFrom(await storedConfig(fixture.eventId))).toEqual(saved.shape);
  });

  it("writes one top-level key on events.config and no column", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await saveEventShapeAction(fixture.eventId, TEAMS));

    const config = await storedConfig(fixture.eventId);
    expect(config).toHaveProperty("eventShape");
    // A sibling of `config.format`, never inside it — see `eventShapeFrom`.
    expect(config.format).toBeUndefined();
  });

  it("stores the figure the admin set and nothing derived from it", async () => {
    const fixture = await hostedEvent(18);
    unwrap(await saveEventShapeAction(fixture.eventId, TEAMS));

    const stored = (await storedConfig(fixture.eventId)).eventShape as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["draft", "sizing", "teamEvent"]);
    expect(Object.keys(stored.sizing as Record<string, unknown>).sort()).toEqual([
      "mode",
      "value",
    ]);

    // And the derived figure is a real one — it just lives in a function.
    expect(sizingConsequence({ mode: "perTeam", value: 6 }, 18).teams).toBe(3);
  });

  it("survives the Schedule tab, and the schedule survives it", async () => {
    /*
     * The pair Task 78's `Left over` note was written about.
     * `saveScheduleSettingsAction` replaces the whole `config.format` object
     * every time it runs, so a shape nested in there would vanish here.
     */
    const fixture = await hostedEvent(4);
    unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, draft: false }));

    unwrap(
      await saveScheduleSettingsAction(fixture.eventId, {
        timing: scheduleSettingsFrom(null).timing,
        concurrentLobbies: 3,
        days: 2,
        blockDays: null,
      })
    );
    expect(eventShapeFrom(await storedConfig(fixture.eventId)).draft).toBe(false);

    // And the other way round: the shape save must not take the schedule out.
    unwrap(await saveEventShapeAction(fixture.eventId, TEAMS));
    const settings = scheduleSettingsFrom(await storedConfig(fixture.eventId));
    expect(settings.concurrentLobbies).toBe(3);
    expect(settings.days).toBe(2);
  });

  it("leaves the night's format alone, and is left alone by it", async () => {
    // `teamFormat` is the neighbouring top-level key Task 78 put there. The
    // one-level merge keeps both, and neither save may take the other's with
    // it — which is the whole reason neither is nested inside `config.format`.
    const fixture = await hostedEvent(4);
    unwrap(await saveNightFormatAction(fixture.eventId, "3v3"));
    unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, mode: "teams", value: 3 }));

    expect(teamFormatFrom(await storedConfig(fixture.eventId)).format).toBe("3v3");
    expect(eventShapeFrom(await storedConfig(fixture.eventId)).sizing).toEqual({
      mode: "teams",
      value: 3,
    });

    unwrap(await saveNightFormatAction(fixture.eventId, "6v6"));
    expect(eventShapeFrom(await storedConfig(fixture.eventId)).sizing.value).toBe(3);
  });

  it("logs the change once, and says nothing when nothing moved", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, draft: false }));
    unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, draft: false }));

    const lines = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, fixture.eventId), eq(auditLog.action, "event.shape")));

    expect(lines.length).toBe(1);
    expect(lines[0].summary).toContain("teams without a draft");
    expect(lines[0].summary).toContain("6 per team");
  });
});

/* --------------------------------------------------------------------- */
/* What it refuses                                                       */
/* --------------------------------------------------------------------- */

describe("what the save refuses", () => {
  it("refuses a mode it does not recognise", async () => {
    const fixture = await hostedEvent(4);
    expect(refusal(await saveEventShapeAction(fixture.eventId, { ...TEAMS, mode: "sideways" }))).toBe(
      "Teams are sized either by a number of teams or by players per team."
    );
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("eventShape");
  });

  it("refuses a figure out of range, with nothing written", async () => {
    const fixture = await hostedEvent(4);
    expect(
      refusal(await saveEventShapeAction(fixture.eventId, { ...TEAMS, mode: "teams", value: 99 }))
    ).toBe("An event has between 2 and 8 teams.");
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("eventShape");
  });

  it("refuses turning teams off while teams exist, naming how many (UC-42 2a)", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await setTeamCountAction(fixture.eventId, 4));

    const said = refusal(
      await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false })
    );
    expect(said).toBe(teamsInTheWayRefusal(4));
    expect(said).toContain("4 teams");

    // Nothing written: neither the shape nor the teams.
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("eventShape");
    expect(
      (await db.select({ id: teams.id }).from(teams).where(eq(teams.eventId, fixture.eventId)))
        .length
    ).toBe(4);
  });

  it("discards them once the admin says so, and the tabs go with them", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await setTeamCountAction(fixture.eventId, 4));

    const saved = unwrap(
      await saveEventShapeAction(fixture.eventId, {
        ...TEAMS,
        teamEvent: false,
        discardTeams: true,
      })
    );

    expect(saved.teamsDiscarded).toBe(4);
    expect(
      (await db.select({ id: teams.id }).from(teams).where(eq(teams.eventId, fixture.eventId)))
        .length
    ).toBe(0);

    const shown = visibleTabs(eventShapeFrom(await storedConfig(fixture.eventId)));
    expect(shown).not.toContain("draft");
    expect(shown).not.toContain("teams");
    expect(shown).not.toContain("captains");
    expect(shown).not.toContain("format");
    expect(shown).toContain("schedule");
    expect(shown).toContain("results");
  });

  it("names the discard in the log", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await setTeamCountAction(fixture.eventId, 3));
    unwrap(
      await saveEventShapeAction(fixture.eventId, {
        ...TEAMS,
        teamEvent: false,
        discardTeams: true,
      })
    );

    const [line] = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, fixture.eventId), eq(auditLog.action, "event.shape")));
    expect(line.summary).toContain("no teams, discarding 3 teams");
  });

  it("takes no teams away when there are none to take", async () => {
    const fixture = await hostedEvent(4);
    const saved = unwrap(
      await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false })
    );
    expect(saved.teamsDiscarded).toBe(0);
    expect(eventShapeFrom(await storedConfig(fixture.eventId)).teamEvent).toBe(false);
  });

  it("refuses the draft switch-off outright once a lot is awarded (UC-42 3a)", async () => {
    const fixture = await awardedDraft();

    const said = refusal(
      await saveEventShapeAction(fixture.eventId, { ...TEAMS, draft: false })
    );
    expect(said).toBe(DRAFT_AWARDED_REFUSAL);
    // Not the sentence `removeTeamsIn` uses about lots — Task 78's escape.
    expect(said).not.toContain("Void those lots first");

    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("eventShape");
  });

  it("refuses going solo for the same reason, with nothing discarded", async () => {
    // A solo event has no Draft tab at all, so it is the same loss by another
    // route — and `discardTeams` must not buy its way past it.
    const fixture = await awardedDraft();

    expect(
      refusal(
        await saveEventShapeAction(fixture.eventId, {
          ...TEAMS,
          teamEvent: false,
          discardTeams: true,
        })
      )
    ).toBe(DRAFT_AWARDED_REFUSAL);

    expect(
      (await db.select({ id: teams.id }).from(teams).where(eq(teams.eventId, fixture.eventId)))
        .length
    ).toBe(2);
  });

  it("still allows the sizing to change on an event mid-draft", async () => {
    // 3a is about switching the draft *off*, not about freezing the panel.
    const fixture = await awardedDraft();
    expect(
      unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, mode: "teams", value: 2 }))
        .shape.sizing
    ).toEqual({ mode: "teams", value: 2 });
  });
});

/**
 * An event with two teams, a pool and one **awarded** lot — UC-42 3a's
 * precondition.
 *
 * Built exactly as `random-teams-actions.test.ts` builds it, through the
 * library's own writes rather than by inserting a row that looks like an award.
 */
async function awardedDraft(): Promise<Fixture> {
  const fixture = await hostedEvent(6);
  unwrap(await setTeamCountAction(fixture.eventId, 2));

  const built = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.eventId, fixture.eventId));

  unwrap(await setDraftPool(fixture.eventId, {}, db));
  const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
  unwrap(await placeBid(lot.id, built[0].id, 10, {}, db));
  unwrap(await awardLot(lot.id, built[0].id, {}, db));
  return fixture;
}

/* --------------------------------------------------------------------- */
/* Hiding a tab is not forbidding it (UC-42 5b)                          */
/* --------------------------------------------------------------------- */

describe("a hidden tab's actions", () => {
  it("still refuse a reader who does not manage the event", async () => {
    const fixture = await hostedEvent(4);
    unwrap(
      await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false, draft: false })
    );

    // The Draft, Teams and Captains tabs are not drawn for this event at all.
    const shown = visibleTabs(eventShapeFrom(await storedConfig(fixture.eventId)));
    expect(shown).not.toContain("draft");
    expect(shown).not.toContain("teams");

    // A member who found the action anyway — by URL, or by keeping the page
    // open while somebody else turned the teams off.
    state.userId = fixture.members[0];
    await expect(saveDraftConfigAction(fixture.eventId, { rosterTarget: 4 })).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    await expect(setTeamCountAction(fixture.eventId, 4)).rejects.toThrow(/NEXT_REDIRECT/);
    // And the panel's own action is no different.
    await expect(saveEventShapeAction(fixture.eventId, TEAMS)).rejects.toThrow(/NEXT_REDIRECT/);

    state.userId = fixture.host;
  });

  it("refuse a signed-out caller too", async () => {
    const fixture = await hostedEvent(4);
    unwrap(await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false }));

    state.userId = null;
    await expect(saveDraftConfigAction(fixture.eventId, { rosterTarget: 4 })).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    state.userId = fixture.host;
  });

  it("and still work for the manager, because hiding is not forbidding", async () => {
    /*
     * The other half of 5b, and the half that says what the rule *is*: a hidden
     * tab is one that does not apply, not one that is barred. The server's
     * answer does not depend on what the editor drew — so the manager's own
     * call to a hidden tab's action goes through exactly as it did before, and
     * the refusals above are the guard's, not the rail's.
     */
    const fixture = await hostedEvent(4);
    unwrap(
      await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false, draft: false })
    );

    expect(
      unwrap(await saveDraftConfigAction(fixture.eventId, { rosterTarget: 4 })).config.rosterTarget
    ).toBe(4);
    expect(unwrap(await setTeamCountAction(fixture.eventId, 2)).teams.length).toBe(2);

    // Which is also why the shape save now refuses the way it does: the teams
    // that hidden tab's action just made are real, and 2a is about them rather
    // than about what the rail was drawing at the time.
    expect(
      refusal(await saveEventShapeAction(fixture.eventId, { ...TEAMS, teamEvent: false }))
    ).toBe(teamsInTheWayRefusal(2));
  });
});
