import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  applications as applicationsTable,
  draftLots,
  events as eventsTable,
  teamMembers,
  teams as teamsTable,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  assignRandomTeams,
  awardLot,
  openLot,
  placeBid,
  setCaptains,
  setDraftPool,
  setTeams,
  voidLot,
} from "@/lib/draft";
import { applyToEvent, createEvent, publishEvent } from "@/lib/events";
import { planTeams } from "@/lib/random-teams";

/**
 * `assignRandomTeams` against real Postgres — UC-41's write (R-216).
 *
 * `random-teams.test.ts` proves the shuffle and the arithmetic with no
 * database in sight; this file proves the three things only a real transaction
 * can answer. **That the seeded assignment is what actually lands in
 * `team_members`**, not merely what the pure function returned. **That every
 * refusal leaves the teams exactly as they were** — the thing
 * `docs/decisions/004-refusals-inside-transactions.md` exists for, and the one
 * this function is most exposed to, because its first write deletes every team
 * on the event. And **that only accepted applicants are dealt**.
 *
 * No test here asserts a refusal based on a team's role composition, and that
 * is deliberate: the comp is stated and never enforced (R-215 / UC-41 2). If
 * one ever appears, the design has drifted.
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
async function seededEvent(people: number): Promise<Fixture> {
  counter += 1;
  const created = await createEvent(
    { ...PUBLISHABLE, title: `Random teams fixture ${counter}`, capacity: 64 },
    db
  );
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, {
      displayName: `Player ${counter}-${String(index).padStart(2, "0")}`,
    });
    const applied = await applyToEvent(created.data.id, userId, {}, db);
    if (!applied.ok) throw new Error(applied.error);
    members.push(userId);
  }

  return { eventId: created.data.id, members };
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

/** The stored teams, in the order the Teams tab shows them. */
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
  const [teams, rosters] = await Promise.all([storedTeams(eventId), storedRosters(eventId)]);
  return {
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      seed: team.seed,
      sort: team.sort,
    })),
    rosters: [...rosters.entries()].map(([teamId, userIds]) => [teamId, [...userIds].sort()]),
  };
}

/* ------------------------------------------------------------------ */
/* The happy path (UC-41 6)                                           */
/* ------------------------------------------------------------------ */

describe("shuffling the accepted participants into teams", () => {
  it("makes teams of the format's size and fills them", async () => {
    const fixture = await seededEvent(12);

    const result = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    expect(result.teams).toHaveLength(2);
    expect(result.short).toEqual([]);
    expect(result.discarded).toBe(0);

    const rosters = await storedRosters(fixture.eventId);
    expect([...rosters.values()].map((squad) => squad.length).sort()).toEqual([6, 6]);
    // Everybody accepted, each on exactly one team.
    expect([...rosters.values()].flat().sort()).toEqual([...fixture.members].sort());
  });

  it("stores the exact assignment the seeded generator produces", async () => {
    /*
     * The assertion that ties the two halves together. `random-teams.test.ts`
     * predicts what `dealTeams` returns; this proves those same squads are
     * what reached `team_members` — a shuffle whose result is computed and
     * then written in a different order would pass that test and fail here.
     */
    const fixture = await seededEvent(12);
    const plan = planTeams(12, 6);
    if (!plan.ok) throw new Error(plan.error);

    const result = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    // Seed 1 over twelve players in application order, pinned in the pure
    // test as p10,p4,p2,p8,p9,p11 then p12,p1,p7,p6,p5,p3 (1-based).
    const expected = [
      [10, 4, 2, 8, 9, 11].map((n) => fixture.members[n - 1]),
      [12, 1, 7, 6, 5, 3].map((n) => fixture.members[n - 1]),
    ];

    expect(result.rosters.map((row) => row.userIds)).toEqual(expected);

    const rosters = await storedRosters(fixture.eventId);
    expect(result.teams.map((team) => rosters.get(team.id))).toEqual(expected);
  });

  it("spreads an uneven count one per team and says which came out short (UC-41 4a)", async () => {
    const fixture = await seededEvent(16);

    const result = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(5) }, db)
    );

    expect(result.teams).toHaveLength(3);
    const rosters = await storedRosters(fixture.eventId);
    // 6, 5, 5 — not 6, 6, 4.
    expect(result.teams.map((team) => rosters.get(team.id)?.length)).toEqual([6, 5, 5]);
    expect(result.short).toEqual([2, 3]);
    // Nobody is dropped by the uneven split.
    expect([...rosters.values()].flat().sort()).toEqual([...fixture.members].sort());
  });

  it("sizes 3v3 teams at three from the same head count", async () => {
    const fixture = await seededEvent(12);

    const result = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 3, random: seeded(2) }, db)
    );

    expect(result.teams).toHaveLength(4);
    const rosters = await storedRosters(fixture.eventId);
    expect([...rosters.values()].map((squad) => squad.length)).toEqual([3, 3, 3, 3]);
  });

  it("writes the new teams as placeholders, not as names somebody typed", async () => {
    // `setTeamCount` is the only path that can truthfully record
    // `name_is_custom = false` (UC-15 4), which is why the shuffle goes
    // through it rather than writing team rows itself.
    const fixture = await seededEvent(12);
    unwrap(await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db));

    const teams = await storedTeams(fixture.eventId);
    expect(teams.map((team) => team.name)).toEqual(["Team 1", "Team 2"]);
    expect(teams.every((team) => team.nameIsCustom === false)).toBe(true);
  });

  it("deals nobody a price and nobody a captaincy", async () => {
    const fixture = await seededEvent(12);
    unwrap(await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db));

    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.eventId, fixture.eventId));
    expect(rows.every((row) => row.price === 0)).toBe(true);
    expect(rows.every((row) => row.isCaptain === false)).toBe(true);
    expect(rows.every((row) => row.lotId === null)).toBe(true);
  });

  it("deals only accepted applicants", async () => {
    const fixture = await seededEvent(14);
    /*
     * Two of the fourteen stop being accepted before the shuffle. Written
     * straight onto the rows rather than through `setApplicationStatus`
     * because what is under test is which status `assignRandomTeams` reads,
     * not what a decision does to the waitlist — and a promotion out of the
     * queue would quietly put the seat back.
     */
    await db
      .update(applicationsTable)
      .set({ status: "waitlisted" })
      .where(
        and(
          eq(applicationsTable.eventId, fixture.eventId),
          eq(applicationsTable.userId, fixture.members[0])
        )
      );
    await db
      .update(applicationsTable)
      .set({ status: "declined" })
      .where(
        and(
          eq(applicationsTable.eventId, fixture.eventId),
          eq(applicationsTable.userId, fixture.members[1])
        )
      );

    const result = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(3) }, db)
    );

    const dealt = result.rosters.flatMap((row) => row.userIds);
    expect(dealt).toHaveLength(12);
    expect(dealt).not.toContain(fixture.members[0]);
    expect(dealt).not.toContain(fixture.members[1]);
    // And the count it planned from is the accepted count, not the applicant
    // count: twelve accepted is two full teams, where fourteen would be three.
    expect(result.teams).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Replacing, and re-running (UC-41 3a, 5a)                           */
/* ------------------------------------------------------------------ */

describe("teams that already exist", () => {
  it("is refused while teams exist unless replacing is asked for, and writes nothing", async () => {
    const fixture = await seededEvent(12);
    unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db));
    const before = await snapshot(fixture.eventId);

    const error = refusal(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    // Names how many would go (UC-41 3a).
    expect(error).toContain("2 teams");
    expect(await snapshot(fixture.eventId)).toEqual(before);
  });

  it("replaces them when asked, and reports how many it discarded", async () => {
    const fixture = await seededEvent(12);
    unwrap(
      await setTeams(
        fixture.eventId,
        [{ name: "Alpha" }, { name: "Bravo" }, { name: "Charlie" }],
        db
      )
    );

    const result = unwrap(
      await assignRandomTeams(
        fixture.eventId,
        { teamSize: 6, random: seeded(1), replace: true },
        db
      )
    );

    expect(result.discarded).toBe(3);
    const teams = await storedTeams(fixture.eventId);
    expect(teams).toHaveLength(2);
    // The typed names are gone — which is exactly what the confirmation warns
    // about before this runs.
    expect(teams.map((team) => team.name)).toEqual(["Team 1", "Team 2"]);
  });

  it("may be re-run, and the second shuffle replaces the first (UC-41 5a)", async () => {
    const fixture = await seededEvent(12);

    const first = unwrap(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );
    const second = unwrap(
      await assignRandomTeams(
        fixture.eventId,
        { teamSize: 6, random: seeded(4), replace: true },
        db
      )
    );

    expect(second.discarded).toBe(2);
    // A different seed means a different assignment, and the first one is gone
    // rather than sitting alongside: two teams, not four.
    expect(await storedTeams(fixture.eventId)).toHaveLength(2);
    expect(second.rosters.map((row) => row.userIds)).not.toEqual(
      first.rosters.map((row) => row.userIds)
    );

    const rosters = await storedRosters(fixture.eventId);
    expect([...rosters.values()].flat().sort()).toEqual([...fixture.members].sort());
    expect(second.teams.map((team) => rosters.get(team.id))).toEqual(
      second.rosters.map((row) => row.userIds)
    );
  });

  it("clears the captaincies the discarded teams held", async () => {
    // A captain is a roster row plus `teams.captain_user_id`, and both go with
    // the team. Left behind, the event would have a captain on no roster.
    const fixture = await seededEvent(12);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
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

    unwrap(
      await assignRandomTeams(
        fixture.eventId,
        { teamSize: 6, random: seeded(1), replace: true },
        db
      )
    );

    const teams = await storedTeams(fixture.eventId);
    expect(teams.every((team) => team.captainUserId === null)).toBe(true);
    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.eventId, fixture.eventId));
    expect(rows.every((row) => row.isCaptain === false)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The refusals, and that each one writes nothing                     */
/* ------------------------------------------------------------------ */

describe("refusing to shuffle", () => {
  it("is refused outright once a lot has been awarded, and writes nothing (UC-41 3b)", async () => {
    const fixture = await seededEvent(12);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[5] }, db));
    unwrap(await placeBid(lot.id, written.teams[0].id, 10, {}, db));
    unwrap(await awardLot(lot.id, written.teams[0].id, {}, db));

    const before = await snapshot(fixture.eventId);

    // Refused even *with* `replace`, because 3b is not a confirmation: the
    // prices paid would be left pointing at teams that no longer exist.
    const error = refusal(
      await assignRandomTeams(
        fixture.eventId,
        { teamSize: 6, random: seeded(1), replace: true },
        db
      )
    );

    /*
     * Asserted on the **exact 3b sentence**, and that is the whole value of
     * this assertion rather than pedantry.
     *
     * With the awarded-lot gate deleted, this call still refuses — `setTeams`
     * will not empty a list containing a team that has won lots, so
     * `removeTeamsIn` says "Alpha has already drafted players … Void those
     * lots first". A test looking for `ok: false`, or for a phrase as loose as
     * "Void those lots", passes with the gate gone. Two mutations proved
     * exactly that before this line was tightened.
     */
    expect(error).toBe(
      "The draft has already awarded lots against these teams, so they cannot be shuffled now — the prices paid would be left pointing at teams that no longer exist. Void those lots in the draft room first."
    );
    expect(error).not.toContain("has already drafted players");

    expect(await snapshot(fixture.eventId)).toEqual(before);
    // The award itself is untouched.
    const lots = await db
      .select()
      .from(draftLots)
      .where(eq(draftLots.eventId, fixture.eventId));
    expect(lots.map((row) => row.status)).toEqual(["awarded"]);
  });

  it("hands back a callee's refusal about a voided lot, and writes nothing", async () => {
    /*
     * The gap between this function's own gate and `setTeams`'s, which is the
     * reason the two do not cover each other.
     *
     * This lot was **voided**, so no award is standing and the 3b gate above
     * lets the call through. `removeTeamsIn` still refuses, because it asks a
     * wider question: does any lot name this team as a winner at *any* status
     * — a voided award records a price that was once paid. Two different
     * questions, the same shape Task 57 found in `setTeams` itself.
     *
     * The refusal is a callee's, so it is re-raised as `NothingShuffled` and
     * turned back into the same sentence at the boundary rather than returned
     * from inside the transaction. Note what is *not* claimed here: no delete
     * is rolled back, because `removeTeamsIn` checks the lots before it
     * deletes anything, so nothing had been written when it refused. The
     * reachable `docs/decisions/004` exposure in this function is the
     * `beforeRemoval` hook, which *does* write — and that is proved in
     * `src/app/admin/events/__tests__/random-teams-actions.test.ts`.
     */
    const fixture = await seededEvent(12);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[5] }, db));
    unwrap(await placeBid(lot.id, written.teams[0].id, 10, {}, db));
    unwrap(await awardLot(lot.id, written.teams[0].id, {}, db));
    unwrap(await voidLot(lot.id, {}, db));

    const before = await snapshot(fixture.eventId);
    expect(before.teams).toHaveLength(2);

    const error = refusal(
      await assignRandomTeams(
        fixture.eventId,
        { teamSize: 6, random: seeded(1), replace: true },
        db
      )
    );

    // The callee's own sentence, handed back rather than swallowed.
    expect(error).toContain("has already drafted players");
    expect(await snapshot(fixture.eventId)).toEqual(before);
  });

  it("refuses too few participants, naming the count and the team size, and writes nothing", async () => {
    const fixture = await seededEvent(4);
    const before = await snapshot(fixture.eventId);

    const error = refusal(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    expect(error).toContain("4");
    expect(error).toContain("6");
    expect(await snapshot(fixture.eventId)).toEqual(before);
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });

  it("refuses exactly one team's worth — one team is not two sides", async () => {
    const fixture = await seededEvent(6);

    const error = refusal(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    expect(error).toContain("one team");
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });

  it("refuses an event that is not there", async () => {
    const error = refusal(
      await assignRandomTeams(
        "00000000-0000-0000-0000-000000000000",
        { teamSize: 6, random: seeded(1) },
        db
      )
    );
    expect(error).toContain("no longer exists");
  });

  it("refuses a finished event and writes nothing", async () => {
    // The standing rule a finished event carries (UC-09 6b), shared with every
    // other write through `lockRefusal` rather than restated here.
    const fixture = await seededEvent(12);
    await db
      .update(eventsTable)
      .set({ status: "complete" })
      .where(eq(eventsTable.id, fixture.eventId));

    const error = refusal(
      await assignRandomTeams(fixture.eventId, { teamSize: 6, random: seeded(1) }, db)
    );

    expect(error.length).toBeGreaterThan(0);
    expect(await storedTeams(fixture.eventId)).toHaveLength(0);
  });
});
