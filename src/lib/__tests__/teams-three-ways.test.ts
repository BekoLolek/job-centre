import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventConfig,
  applications,
  events as eventsTable,
  teamMembers,
  teams as teamsTable,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  assignRandomTeams,
  awardLot,
  getTeams,
  openLot,
  placeBid,
  placeOnRoster,
  setCaptains,
  setDraftPool,
  setTeamCount,
  setTeams,
  teamsFillOf,
} from "@/lib/draft";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { applyToEvent, createEvent, publishEvent, updateEvent } from "@/lib/events";
import {
  type EventShape,
  countFollowsFormatRefusal,
  eventShapeFrom,
  planSides,
  sizingConsequence,
  teamCountFrom,
} from "@/lib/events-policy";
import { dealTeams, planTeams } from "@/lib/random-teams";

/**
 * Task 81 — R-220 / UC-42 6, 6a: the teams are filled by hand, at random or
 * from a draft, and all three agree about how many teams there are.
 *
 * ## What is proved here and nowhere else
 *
 * **That the random fill sizes itself from the Format panel** (`eventShape`),
 * not from the night's 6v6/3v3 comp — the same twelve people make two teams
 * under "6 per team" and three under "3 teams". Task 78's `random-teams-db`
 * tests keep holding the default, which *is* the comp's size.
 *
 * **That it is Task 78's shuffle doing the dealing.** Not a grep for an
 * import: a generator that throws is handed in and the write dies on it with
 * nothing written, and a pinned generator produces exactly the squads
 * `dealTeams` predicts for the plan `planSides` made. A second shuffle
 * written beside the first could pass neither.
 *
 * **That `setTeamCount` follows the panel** — refusing a count that
 * disagrees, before any write, and leaving the count free only while the
 * panel cannot say how many teams there are.
 *
 * **That `teamsFillOf` says which route filled the current rosters**, read
 * off the rows and the marker the shuffle leaves on `events.config`, with the
 * marker going inert the moment the teams it made are gone.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

let counter = 0;

type Fixture = { eventId: string; members: string[] };

/** A published event with `people` accepted applicants, in application order. */
async function seededEvent(people: number, config?: EventConfig): Promise<Fixture> {
  counter += 1;
  const created = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Three ways ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(created.id, db));

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, {
      displayName: `Way ${counter}-${String(index).padStart(2, "0")}`,
    });
    unwrap(await applyToEvent(created.id, userId, {}, db));
    members.push(userId);
  }
  if (config) unwrap(await updateEvent(created.id, { config }, db));

  return { eventId: created.id, members };
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

/** The same seeded generator `random-teams.test.ts` uses. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const shaped = (sizing: EventShape["sizing"], over: Partial<EventShape> = {}): EventConfig => ({
  eventShape: { teamEvent: true, draft: true, ...over, sizing },
});

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

async function storedConfig(eventId: string): Promise<EventConfig> {
  const [row] = await db
    .select({ config: eventsTable.config })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId))
    .limit(1);
  return row?.config ?? {};
}

async function storedTeams(eventId: string) {
  return db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.eventId, eventId))
    .orderBy(asc(teamsTable.sort), asc(teamsTable.createdAt));
}

/** Every roster row for the event, as `teamId → userIds`. */
async function storedRosters(eventId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(asc(teamMembers.acquiredAt));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    out.set(row.teamId, [...(out.get(row.teamId) ?? []), row.userId]);
  }
  return out;
}

/** A snapshot precise enough that "nothing was written" is a real assertion. */
async function snapshot(eventId: string) {
  const [teams, rosters, config] = await Promise.all([
    storedTeams(eventId),
    storedRosters(eventId),
    storedConfig(eventId),
  ]);
  return {
    teams: teams.map((team) => ({ id: team.id, name: team.name, sort: team.sort })),
    rosters: [...rosters.entries()].map(([teamId, userIds]) => [teamId, [...userIds].sort()]),
    config,
  };
}

/** The fill as the page computes it: the real `getTeams` rows and the stored config. */
async function fillOf(eventId: string) {
  return teamsFillOf(await getTeams(eventId, db), await storedConfig(eventId));
}

/* ------------------------------------------------------------------ */
/* The plan both modes make (pure)                                    */
/* ------------------------------------------------------------------ */

describe("planSides", () => {
  it("is Task 78's planTeams when the panel says players per team", () => {
    expect(planSides({ mode: "perTeam", value: 6 }, 16)).toEqual(planTeams(16, 6));
    expect(planSides({ mode: "perTeam", value: 6 }, 4)).toEqual(planTeams(4, 6));
  });

  it("deals the remainder one per side when the panel says how many teams", () => {
    // 14 into 4 is 4, 4, 3, 3 — never 5, 3, 3, 3 — and the two light sides are named.
    const plan = planSides({ mode: "teams", value: 4 }, 14);
    expect(plan).toEqual({ ok: true, plan: { teams: 4, sizes: [4, 4, 3, 3], short: [3, 4] } });
  });

  it("names nobody short when the sides come out even", () => {
    expect(planSides({ mode: "teams", value: 3 }, 12)).toEqual({
      ok: true,
      plan: { teams: 3, sizes: [4, 4, 4], short: [] },
    });
  });

  it("refuses fewer people than sides, naming both numbers", () => {
    const result = planSides({ mode: "teams", value: 4 }, 3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBe(
      "Only 3 players are accepted, and 4 teams need at least one player each. Accept more on the Applicants tab, or lower the team count in Setup → Format."
    );
  });

  it("reads one player as singular in that refusal", () => {
    const result = planSides({ mode: "teams", value: 2 }, 1);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("Only 1 player is accepted");
  });

  it("refuses nobody at all rather than planning empty sides", () => {
    expect(planSides({ mode: "teams", value: 2 }, 0).ok).toBe(false);
  });

  it("seats everybody, with no two sides more than one apart, for every legal count", () => {
    let checked = 0;
    for (let sides = MIN_TEAMS; sides <= MAX_TEAMS; sides += 1) {
      for (let people = sides; people <= 60; people += 1) {
        const result = planSides({ mode: "teams", value: sides }, people);
        if (!result.ok) throw new Error(result.error);
        const sum = result.plan.sizes.reduce((total, size) => total + size, 0);
        expect(sum).toBe(people);
        expect(Math.max(...result.plan.sizes) - Math.min(...result.plan.sizes)).toBeLessThanOrEqual(1);
        checked += 1;
      }
    }
    // A floor, so an empty scan cannot pass this.
    expect(checked).toBeGreaterThan(300);
  });

  it("agrees with the Format panel's own sentence for every legal count", () => {
    // Task 79's `sizingConsequence` prints the figure; this plans the write.
    // Two readings of one sizing, held against each other rather than trusted.
    let checked = 0;
    for (let sides = MIN_TEAMS; sides <= MAX_TEAMS; sides += 1) {
      for (let people = sides; people <= 60; people += 1) {
        const sizing = { mode: "teams" as const, value: sides };
        const plan = planSides(sizing, people);
        if (!plan.ok) throw new Error(plan.error);
        const said = sizingConsequence(sizing, people);
        expect(plan.plan.teams).toBe(said.teams);
        expect(plan.plan.sizes).toEqual(said.sizes);
        expect(plan.plan.short).toEqual(said.short);
        checked += 1;
      }
    }
    for (let per = 1; per <= 8; per += 1) {
      for (let people = 1; people <= 60; people += 1) {
        const sizing = { mode: "perTeam" as const, value: per };
        const plan = planSides(sizing, people);
        const said = sizingConsequence(sizing, people);
        if (plan.ok) {
          expect(plan.plan.teams).toBe(said.teams);
          expect(plan.plan.sizes).toEqual(said.sizes);
        } else {
          expect(said.problem).toBe(plan.error);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(700);
  });
});

/* ------------------------------------------------------------------ */
/* The count the panel yields (pure)                                  */
/* ------------------------------------------------------------------ */

describe("teamCountFrom", () => {
  const shape = (sizing: EventShape["sizing"], teamEvent = true): EventShape => ({
    teamEvent,
    draft: true,
    sizing,
  });

  it("is the panel's figure under a count of teams, whoever is accepted", () => {
    expect(teamCountFrom(shape({ mode: "teams", value: 4 }), 0)).toBe(4);
    expect(teamCountFrom(shape({ mode: "teams", value: 4 }), 40)).toBe(4);
  });

  it("rounds a fractional team up under players per team — the extra side is short, not dropped", () => {
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 12)).toBe(2);
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 13)).toBe(3);
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 16)).toBe(3);
  });

  it("cannot say with nobody accepted, too few, or exactly one team's worth", () => {
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 0)).toBeNull();
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 4)).toBeNull();
    expect(teamCountFrom(shape({ mode: "perTeam", value: 6 }), 6)).toBeNull();
  });

  it("has nothing to say about a solo event", () => {
    expect(teamCountFrom(shape({ mode: "teams", value: 4 }, false), 20)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The random fill sizes itself from the Format panel                 */
/* ------------------------------------------------------------------ */

describe("the random fill follows the Format panel", () => {
  it("makes three teams of four when the panel says 3 teams — the same twelve people", async () => {
    // Under the night's own 6v6 these twelve would be two teams of six.
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));

    const result = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));

    expect(result.teams).toHaveLength(3);
    expect(result.short).toEqual([]);
    const rosters = await storedRosters(fixture.eventId);
    expect(result.teams.map((team) => rosters.get(team.id)?.length)).toEqual([4, 4, 4]);
  });

  it("makes three teams when the panel says 4 per team", async () => {
    const fixture = await seededEvent(12, shaped({ mode: "perTeam", value: 4 }));
    const result = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));
    expect(result.teams).toHaveLength(3);
  });

  it("still sizes from the night's comp when the panel has never been saved", async () => {
    // `eventShapeFrom` reads an absent key as the comp's own size, so Task 78's
    // behaviour is unchanged for every event stored before the panel existed.
    const fixture = await seededEvent(12);
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("eventShape");

    const result = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));
    expect(result.teams).toHaveLength(2);
  });

  it("deals exactly what Task 78's dealTeams predicts for the panel's plan", async () => {
    /*
     * The injection, proved rather than inspected. The plan is the one
     * `planSides` makes for "3 teams", the people are in application order,
     * and the generator is pinned — so there is exactly one assignment the
     * real shuffle can produce, and it is asserted against the rows written.
     */
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));
    const plan = planSides({ mode: "teams", value: 3 }, 12);
    if (!plan.ok) throw new Error(plan.error);
    const expected = dealTeams(fixture.members, plan.plan, seeded(7));

    const result = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(7) }, db));

    expect(result.rosters.map((row) => row.userIds)).toEqual(expected);
    const rosters = await storedRosters(fixture.eventId);
    expect(result.teams.map((team) => rosters.get(team.id))).toEqual(expected);
  });

  it("dies on the generator it was handed, and writes nothing", async () => {
    // A thrower, so the call provably reaches the shuffle — and the whole
    // transaction rolls back behind it.
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));
    const before = await snapshot(fixture.eventId);

    await expect(
      assignRandomTeams(
        fixture.eventId,
        {
          random: () => {
            throw new Error("reached the shuffle");
          },
        },
        db
      )
    ).rejects.toThrow("reached the shuffle");

    expect(await snapshot(fixture.eventId)).toEqual(before);
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });

  it("refuses a solo event, and writes nothing", async () => {
    const fixture = await seededEvent(12, SOLO);
    const before = await snapshot(fixture.eventId);

    const error = refusal(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));

    expect(error).toBe(
      "This event has no teams, so there is nothing to shuffle people into. Setup → Format is where that is decided."
    );
    expect(await snapshot(fixture.eventId)).toEqual(before);
  });

  it("refuses fewer people than sides under a count of teams, naming both, and writes nothing", async () => {
    const fixture = await seededEvent(3, shaped({ mode: "teams", value: 4 }));
    const before = await snapshot(fixture.eventId);

    const error = refusal(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));

    expect(error).toContain("Only 3 players are accepted, and 4 teams need at least one player each");
    expect(await snapshot(fixture.eventId)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* Which route filled the current teams                               */
/* ------------------------------------------------------------------ */

describe("teamsFillOf", () => {
  it("says nobody is placed when the rosters are empty", async () => {
    const fixture = await seededEvent(4);
    unwrap(await setTeamCount(fixture.eventId, 2, db));
    expect(await fillOf(fixture.eventId)).toEqual({ route: "empty" });
  });

  it("counts captains as nobody placed — they are chosen on the Captains tab", async () => {
    const fixture = await seededEvent(4);
    const written = unwrap(await setTeamCount(fixture.eventId, 2, db));
    unwrap(
      await setCaptains(
        fixture.eventId,
        [
          { teamId: written.teams[0].id, userId: fixture.members[0] },
          { teamId: written.teams[1].id, userId: fixture.members[1] },
        ],
        db
      )
    );
    expect(await fillOf(fixture.eventId)).toEqual({ route: "empty" });
  });

  it("reads hand placements as filled by hand", async () => {
    const fixture = await seededEvent(4);
    const written = unwrap(await setTeamCount(fixture.eventId, 2, db));
    unwrap(await placeOnRoster(fixture.eventId, fixture.members[0], written.teams[0].id, db));
    unwrap(await placeOnRoster(fixture.eventId, fixture.members[1], written.teams[1].id, db));
    unwrap(await placeOnRoster(fixture.eventId, fixture.members[2], written.teams[1].id, db));

    expect(await fillOf(fixture.eventId)).toEqual({ route: "hand", placed: 3 });
  });

  it("reads a shuffle as filled at random, from the marker it left on the event", async () => {
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));
    unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));

    const fill = await fillOf(fixture.eventId);
    expect(fill.route).toBe("random");
    if (fill.route !== "random") throw new Error("expected random");
    expect(fill.dealt).toBe(12);
    expect(fill.byHandSince).toBe(0);
    // The marker is a plain key on events.config, so no migration was needed,
    // and it names the teams it made rather than being a bare flag.
    const marker = (await storedConfig(fixture.eventId)).randomFill as {
      at: string;
      teamIds: string[];
    };
    expect(fill.at).toBe(marker.at);
    expect(marker.teamIds).toHaveLength(3);
  });

  it("counts a hand placement made after the shuffle as such", async () => {
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));
    const made = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));

    // A thirteenth person accepted afterwards and put on a team by hand.
    const late = await makeUser(db, { displayName: `Late ${counter}` });
    unwrap(await applyToEvent(fixture.eventId, late, {}, db));
    unwrap(await placeOnRoster(fixture.eventId, late, made.teams[0].id, db));

    const fill = await fillOf(fixture.eventId);
    expect(fill).toMatchObject({ route: "random", dealt: 12, byHandSince: 1 });
  });

  it("reads a draft award as filled by the draft, whatever else is on the rosters", async () => {
    const fixture = await seededEvent(6);
    const written = unwrap(await setTeamCount(fixture.eventId, 2, db));
    unwrap(await placeOnRoster(fixture.eventId, fixture.members[0], written.teams[1].id, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[5] }, db));
    unwrap(await placeBid(lot.id, written.teams[0].id, 10, {}, db));
    unwrap(await awardLot(lot.id, written.teams[0].id, {}, db));

    expect(await fillOf(fixture.eventId)).toEqual({ route: "draft", won: 1, byHand: 1 });
  });

  it("forgets the shuffle once the teams it made are gone", async () => {
    /*
     * The marker names team ids rather than being a flag, so it needs no
     * clearing: discard the shuffled teams, build new ones by hand, and the
     * rows say "by hand" because none of them is a team the shuffle made.
     */
    const fixture = await seededEvent(12, shaped({ mode: "teams", value: 3 }));
    unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(1) }, db));
    unwrap(await setTeams(fixture.eventId, [], db));
    const rebuilt = unwrap(await setTeamCount(fixture.eventId, 3, db));
    unwrap(await placeOnRoster(fixture.eventId, fixture.members[0], rebuilt.teams[0].id, db));

    expect(await storedConfig(fixture.eventId)).toHaveProperty("randomFill");
    expect(await fillOf(fixture.eventId)).toEqual({ route: "hand", placed: 1 });
  });

  it("reads an absent or malformed marker as no shuffle", () => {
    const team = {
      id: "t1",
      members: [
        { teamId: "t1", userId: "u1", price: 0, isCaptain: false, lotId: null, acquiredAt: new Date() },
      ],
    };
    const rows = [team] as unknown as Parameters<typeof teamsFillOf>[0];
    expect(teamsFillOf(rows, {})).toEqual({ route: "hand", placed: 1 });
    expect(teamsFillOf(rows, { randomFill: "yes" })).toEqual({ route: "hand", placed: 1 });
    expect(teamsFillOf(rows, { randomFill: { at: "not a date", teamIds: ["t1"] } })).toEqual({
      route: "hand",
      placed: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The team count follows the Format panel                            */
/* ------------------------------------------------------------------ */

describe("setTeamCount follows the Format panel", () => {
  it("refuses a count that disagrees with a stated number of teams, and writes nothing", async () => {
    const fixture = await seededEvent(4, shaped({ mode: "teams", value: 4 }));
    const shape = eventShapeFrom(await storedConfig(fixture.eventId));

    const error = refusal(await setTeamCount(fixture.eventId, 3, db));

    expect(error).toBe(countFollowsFormatRefusal(shape, 4, 4, 3));
    expect(error).toBe(
      "Setup → Format says this event has 4 teams, so it cannot be set to 3 here. Change it there, or make it 4."
    );
    // Not the bounds sentence, which a count of 3 would never trip anyway.
    expect(error).not.toContain("between 2 and 8");
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });

  it("accepts the count the panel states", async () => {
    const fixture = await seededEvent(4, shaped({ mode: "teams", value: 4 }));
    expect(unwrap(await setTeamCount(fixture.eventId, 4, db)).teams).toHaveLength(4);
  });

  it("refuses a count that disagrees with players per team once the accepted count settles it", async () => {
    const fixture = await seededEvent(12, shaped({ mode: "perTeam", value: 6 }));
    const shape = eventShapeFrom(await storedConfig(fixture.eventId));

    const error = refusal(await setTeamCount(fixture.eventId, 3, db));

    expect(error).toBe(countFollowsFormatRefusal(shape, 12, 2, 3));
    expect(error).toBe(
      "Setup → Format sizes the teams at 6 a side, which makes 2 teams from the 12 accepted — so it cannot be set to 3 here. Change the sizing there, or make it 2."
    );
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
    expect(unwrap(await setTeamCount(fixture.eventId, 2, db)).teams).toHaveLength(2);
  });

  it("refuses the disagreeing count even when it is the count that already exists", async () => {
    // Four teams built before the panel said three: re-submitting four is not
    // a no-op, it is a contradiction, and the sentence says where to settle it.
    const fixture = await seededEvent(4);
    unwrap(await setTeamCount(fixture.eventId, 4, db));
    unwrap(await updateEvent(fixture.eventId, { config: shaped({ mode: "teams", value: 3 }) }, db));

    expect(refusal(await setTeamCount(fixture.eventId, 4, db))).toContain("has 3 teams");
    expect(await storedTeams(fixture.eventId)).toHaveLength(4);
  });

  it("leaves the count free while the panel cannot say how many teams there are", async () => {
    // Nobody accepted yet, players per team: the consequence is an assumption
    // (UC-42 4a), so there is nothing to disagree with and 2–8 is the rule.
    const none = await seededEvent(0, shaped({ mode: "perTeam", value: 6 }));
    expect(unwrap(await setTeamCount(none.eventId, 4, db)).teams).toHaveLength(4);

    // Too few for two sides: the planner has no count either.
    const few = await seededEvent(4, shaped({ mode: "perTeam", value: 6 }));
    expect(unwrap(await setTeamCount(few.eventId, 3, db)).teams).toHaveLength(3);
  });

  it("leaves the count free on a solo event — hiding a tab is not forbidding it", async () => {
    const fixture = await seededEvent(12, SOLO);
    expect(unwrap(await setTeamCount(fixture.eventId, 5, db)).teams).toHaveLength(5);
  });

  it("still holds the two-to-eight bound ahead of everything", async () => {
    const fixture = await seededEvent(4, shaped({ mode: "teams", value: 4 }));
    expect(refusal(await setTeamCount(fixture.eventId, 9, db))).toBe(
      `An event needs between ${MIN_TEAMS} and ${MAX_TEAMS} teams.`
    );
  });

  it("agrees with its own shuffle, so a random fill is never refused by this rule", async () => {
    // Both read `teamCountFrom` over the same rows, which is the point of
    // there being one function.
    const fixture = await seededEvent(13, shaped({ mode: "perTeam", value: 6 }));
    const result = unwrap(await assignRandomTeams(fixture.eventId, { random: seeded(2) }, db));
    expect(result.teams).toHaveLength(3);
    // 13 at six a side is 5, 4, 4 — the remainder spread, so every side is light.
    expect(result.short).toEqual([1, 2, 3]);
    const accepted = await db
      .select({ userId: applications.userId })
      .from(applications)
      .where(and(eq(applications.eventId, fixture.eventId), eq(applications.status, "accepted")));
    expect(accepted).toHaveLength(13);
  });
});
