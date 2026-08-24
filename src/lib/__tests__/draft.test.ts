import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  draftLots,
  teamMembers,
  teams as teamsTable,
  users as usersTable,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  clearBid,
  discardLot,
  getDiscardedPlayers,
  getDraftConfig,
  getDraftHistory,
  getDraftPool,
  getDraftSnapshot,
  getDraftView,
  getOpenLotResolution,
  getTeams,
  getUnpooledApplicants,
  moveToReserve,
  openLot,
  placeBid,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setPoolKind,
  setTeams,
  viewerFor,
  voidLastLot,
  voidLot,
} from "@/lib/draft";
import { SPIN_DURATION_MS } from "@/lib/draft-policy";
import { applyToEvent, createEvent, publishEvent, setApplicationStatus } from "@/lib/events";

/**
 * The draft against real Postgres.
 *
 * `src/lib/__tests__/draft-policy.test.ts` proves the arithmetic; this file
 * proves the writes — that a captain really does occupy a slot, that an award
 * really is deducted once, and above all that an undo puts the money, the
 * roster and the pool back exactly where they were. The races live next door in
 * draft-concurrency.test.ts.
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
  const created = await createEvent({ title: `Draft fixture ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);

  const members: string[] = [];
  for (let index = 0; index < people; index += 1) {
    const userId = await makeUser(db, { displayName: `Player ${counter}-${index}` });
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

/** Two named teams, captained by the first two applicants. */
async function twoTeams(fixture: Fixture): Promise<{ a: string; b: string }> {
  const written = unwrap(
    await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
  );
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

/** Open a lot on a named player, bid, and award it. */
async function buy(
  eventId: string,
  playerUserId: string,
  teamId: string,
  amount: number
): Promise<string> {
  const lot = unwrap(await openLot(eventId, { userId: playerUserId }, db));
  unwrap(await placeBid(lot.id, teamId, amount, {}, db));
  unwrap(await awardLot(lot.id, teamId, {}, db));
  return lot.id;
}

async function balanceOf(eventId: string, teamId: string): Promise<number> {
  const all = await getTeams(eventId, db);
  const team = all.find((row) => row.id === teamId);
  if (!team) throw new Error("no such team");
  return team.balance;
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/* ------------------------------------------------------------------ */

describe("setTeams", () => {
  it("creates teams on the event's default balance", async () => {
    const fixture = await seededEvent(0);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    expect(written.teams.map((team) => team.name)).toEqual(["Alpha", "Bravo"]);
    expect(written.teams.every((team) => team.balanceStart === 1000)).toBe(true);
    expect(written.teams.map((team) => team.sort)).toEqual([0, 1]);
  });

  it("refuses more than eight", async () => {
    const fixture = await seededEvent(0);
    const nine = Array.from({ length: 9 }, (_unused, index) => ({ name: `Team ${index}` }));
    const result = await setTeams(fixture.eventId, nine, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/at most 8/);
  });

  it("refuses a blank name and two teams sharing one", async () => {
    const fixture = await seededEvent(0);
    const blank = await setTeams(fixture.eventId, [{ name: "   " }], db);
    expect(blank.ok === false && blank.errors?.["new-0"]).toMatch(/name/i);

    const twice = await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "alpha" }], db);
    expect(twice.ok === false && twice.errors?.["new-1"]).toMatch(/share a name/);
  });

  it("renames, reorders and swaps names without tripping the unique index", async () => {
    const fixture = await seededEvent(0);
    const first = unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db));
    const [a, b] = first.teams;

    // The awkward case: two teams exchanging names in one write.
    const swapped = unwrap(
      await setTeams(
        fixture.eventId,
        [
          { id: b.id, name: "Alpha" },
          { id: a.id, name: "Bravo" },
        ],
        db
      )
    );
    expect(swapped.teams.map((team) => `${team.name}`)).toEqual(["Alpha", "Bravo"]);
    expect(swapped.teams[0].id).toBe(b.id);
  });

  it("drops a team the list leaves out", async () => {
    const fixture = await seededEvent(0);
    const first = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    const kept = first.teams[0];
    const after = unwrap(await setTeams(fixture.eventId, [{ id: kept.id, name: "Alpha" }], db));
    expect(after.removed).toBe(1);
    expect(after.teams).toHaveLength(1);
  });

  it("refuses to delete a team that has already paid for somebody", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], a, 200);

    const result = await setTeams(fixture.eventId, [{ id: b, name: "Bravo" }], db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already drafted/);
  });

  it("refuses a team id from another event", async () => {
    const mine = await seededEvent(0);
    const theirs = await seededEvent(0);
    const written = unwrap(await setTeams(theirs.eventId, [{ name: "Alpha" }], db));
    const result = await setTeams(mine.eventId, [{ id: written.teams[0].id, name: "Alpha" }], db);
    expect(result.ok === false && result.errors?.[written.teams[0].id]).toMatch(
      /different event/
    );
  });

  it("honours per-team balances only when the mode says so", async () => {
    const fixture = await seededEvent(0);

    // Uniform: the mode wins over whatever the form sent.
    unwrap(await setTeams(fixture.eventId, [{ name: "Alpha", balanceStart: 40 }], db));
    expect((await getTeams(fixture.eventId, db))[0].balanceStart).toBe(1000);

    unwrap(await setDraftConfig(fixture.eventId, { balanceMode: "per_team" }, db));
    const written = unwrap(
      await setTeams(
        fixture.eventId,
        [{ name: "Alpha", balanceStart: 1200 }, { name: "Bravo" }],
        db
      )
    );
    expect(written.teams.map((team) => team.balanceStart)).toEqual([1200, 1000]);
  });
});

/* ------------------------------------------------------------------ */
/* Captains (§14)                                                     */
/* ------------------------------------------------------------------ */

describe("setCaptains", () => {
  it("puts the captain on the roster at no cost, filling a slot", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);

    const [team] = (await getTeams(fixture.eventId, db)).filter((row) => row.id === a);
    expect(team.captainUserId).toBe(fixture.members[0]);
    expect(team.members).toHaveLength(1);
    expect(team.members[0]).toMatchObject({
      userId: fixture.members[0],
      price: 0,
      isCaptain: true,
      lotId: null,
    });
    // Six-a-side by default, and the captain is one of the six.
    expect(team.roster).toMatchObject({ size: 1, slotsLeft: 5, captainCount: 1 });
    expect(team.balance).toBe(1000);
  });

  it("keeps a captain out of the draft pool, even after a reseed", async () => {
    const fixture = await seededEvent(5);
    await twoTeams(fixture);

    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const pool = await getDraftPool(fixture.eventId, db);
    const inPool = pool.main.map((entry) => entry.userId);
    expect(inPool).not.toContain(fixture.members[0]);
    expect(inPool).not.toContain(fixture.members[1]);
    expect(inPool).toHaveLength(3);

    // And again, because a reseed is the moment this would quietly go wrong.
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const again = await getDraftPool(fixture.eventId, db);
    expect(again.main.map((entry) => entry.userId)).not.toContain(fixture.members[0]);
  });

  it("pulls a captain out of a pool they were already sitting in", async () => {
    const fixture = await seededEvent(4);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }], db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    expect((await getDraftPool(fixture.eventId, db)).main).toHaveLength(4);

    unwrap(
      await setCaptains(
        fixture.eventId,
        [{ teamId: written.teams[0].id, userId: fixture.members[0] }],
        db
      )
    );
    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.main.map((entry) => entry.userId)).not.toContain(fixture.members[0]);
    expect(pool.main).toHaveLength(3);
  });

  /* --- Team names from captains -------------------------------- */

  it("names a team after its captain when nobody has named it", async () => {
    const fixture = await seededEvent(2);
    // What the Teams tab creates: a placeholder, because a blank is refused.
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Team 1" }], db));

    unwrap(
      await setCaptains(
        fixture.eventId,
        [{ teamId: written.teams[0].id, userId: fixture.members[0] }],
        db
      )
    );

    const [team] = await getTeams(fixture.eventId, db);
    expect(team.name).toMatch(/^Team Player /);
  });

  it("replaces a seed placeholder, because nobody chose that either", async () => {
    const fixture = await seededEvent(2);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Team 1" }], db));

    unwrap(
      await setCaptains(
        fixture.eventId,
        [{ teamId: written.teams[0].id, userId: fixture.members[0] }],
        db
      )
    );

    const [team] = await getTeams(fixture.eventId, db);
    expect(team.name).toMatch(/^Team Player /);
  });

  it("leaves a name an admin actually typed alone", async () => {
    const fixture = await seededEvent(2);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "The Cavalry" }], db));

    unwrap(
      await setCaptains(
        fixture.eventId,
        [{ teamId: written.teams[0].id, userId: fixture.members[0] }],
        db
      )
    );

    const [team] = await getTeams(fixture.eventId, db);
    expect(team.name).toBe("The Cavalry");
  });

  it("follows the captaincy when it moves, because the name was ours", async () => {
    const fixture = await seededEvent(3);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Team 1" }], db));
    const teamId = written.teams[0].id;

    unwrap(await setCaptains(fixture.eventId, [{ teamId, userId: fixture.members[0] }], db));
    const first = (await getTeams(fixture.eventId, db))[0].name;

    unwrap(await setCaptains(fixture.eventId, [{ teamId, userId: fixture.members[1] }], db));
    const second = (await getTeams(fixture.eventId, db))[0].name;

    expect(second).not.toBe(first);
    expect(second).toMatch(/^Team Player /);
  });

  it("does not write two teams the same name", async () => {
    const fixture = await seededEvent(3);
    // Two people answering to the same display name is an ordinary Discord
    // Tuesday, and a duplicate team name is something an admin then has to
    // untangle by hand.
    await db
      .update(usersTable)
      .set({ displayName: "Sam" })
      .where(inArray(usersTable.id, [fixture.members[0], fixture.members[1]]));

    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Team 1" }, { name: "Team 2" }], db)
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

    const names = (await getTeams(fixture.eventId, db)).map((team) => team.name);
    expect(names.filter((name) => name.startsWith("Team Sam"))).toHaveLength(2);
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses somebody who is not an accepted applicant", async () => {
    const fixture = await seededEvent(2);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }], db));
    const stranger = await makeUser(db);

    const result = await setCaptains(
      fixture.eventId,
      [{ teamId: written.teams[0].id, userId: stranger }],
      db
    );
    expect(result.ok === false && result.errors?.[written.teams[0].id]).toMatch(
      /accepted applicant/
    );
  });

  it("accepts somebody an admin has just accepted — the override is one layer up", async () => {
    const fixture = await seededEvent(2);
    const written = unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }], db));
    const late = await makeUser(db);
    const applied = unwrap(await applyToEvent(fixture.eventId, late, {}, db));
    unwrap(await setApplicationStatus(applied.id, "waitlisted", {}, db));

    const refused = await setCaptains(
      fixture.eventId,
      [{ teamId: written.teams[0].id, userId: late }],
      db
    );
    expect(refused.ok).toBe(false);

    unwrap(await setApplicationStatus(applied.id, "accepted", {}, db));
    const allowed = await setCaptains(
      fixture.eventId,
      [{ teamId: written.teams[0].id, userId: late }],
      db
    );
    expect(allowed.ok).toBe(true);
  });

  it("refuses one person captaining two teams", async () => {
    const fixture = await seededEvent(2);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    const result = await setCaptains(
      fixture.eventId,
      [
        { teamId: written.teams[0].id, userId: fixture.members[0] },
        { teamId: written.teams[1].id, userId: fixture.members[0] },
      ],
      db
    );
    expect(result.ok === false && result.errors?.[written.teams[1].id]).toMatch(
      /cannot captain two/
    );
  });

  it("swaps two captains in one write", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);

    unwrap(
      await setCaptains(
        fixture.eventId,
        [
          { teamId: a, userId: fixture.members[1] },
          { teamId: b, userId: fixture.members[0] },
        ],
        db
      )
    );

    const all = await getTeams(fixture.eventId, db);
    expect(all.find((team) => team.id === a)?.captainUserId).toBe(fixture.members[1]);
    expect(all.find((team) => team.id === b)?.captainUserId).toBe(fixture.members[0]);
    // Still exactly one roster row each — the old captaincy did not linger.
    expect(all.every((team) => team.members.length === 1)).toBe(true);
  });

  it("frees the slot when a captaincy is cleared", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setCaptains(fixture.eventId, [{ teamId: a, userId: null }], db));

    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    expect(team?.captainUserId).toBeNull();
    expect(team?.members).toHaveLength(0);
    expect(team?.roster.slotsLeft).toBe(6);
  });

  it("refuses a captain who has already been drafted by somebody else", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], a, 100);

    const result = await setCaptains(fixture.eventId, [{ teamId: b, userId: fixture.members[2] }], db);
    expect(result.ok === false && result.errors?.[b]).toMatch(/already been drafted/);
  });
});

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

describe("setDraftConfig", () => {
  it("gives an unconfigured event today's rules", async () => {
    const fixture = await seededEvent(0);
    expect(await getDraftConfig(fixture.eventId, db)).toMatchObject({
      biddingMode: "sealed",
      selectionMode: "wheel",
      rosterTarget: 6,
      mustFillRoster: true,
      bidVisibility: "admin_only",
    });
  });

  it("writes only the keys it is given", async () => {
    const fixture = await seededEvent(0);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 4 }, db));
    unwrap(await setDraftConfig(fixture.eventId, { minBid: 25 }, db));

    expect(await getDraftConfig(fixture.eventId, db)).toMatchObject({
      rosterTarget: 4,
      minBid: 25,
      biddingMode: "sealed",
    });
  });

  it("normalises what it stores", async () => {
    const fixture = await seededEvent(0);
    const written = unwrap(
      await setDraftConfig(fixture.eventId, { biddingMode: "open", minIncrement: 0 }, db)
    );
    expect(written.config).toMatchObject({ minIncrement: 1, bidVisibility: "captains" });
  });

  it("moves every team's starting balance when a uniform default changes", async () => {
    const fixture = await seededEvent(0);
    unwrap(await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db));

    const written = unwrap(await setDraftConfig(fixture.eventId, { defaultBalance: 500 }, db));
    expect(written.rebalanced).toBe(2);
    expect((await getTeams(fixture.eventId, db)).map((team) => team.balanceStart)).toEqual([
      500, 500,
    ]);
  });

  it("leaves the starting line alone once the draft has spent money", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], a, 100);

    const written = unwrap(await setDraftConfig(fixture.eventId, { defaultBalance: 5 }, db));
    expect(written.rebalanced).toBe(0);
    expect((await getTeams(fixture.eventId, db)).every((team) => team.balanceStart === 1000)).toBe(
      true
    );
  });

  it("refuses to shrink the roster after players have been bought for it", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], a, 100);

    const result = await setDraftConfig(fixture.eventId, { rosterTarget: 2 }, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot be lowered/);
  });

  it("leaves a per-team mode's handicaps alone", async () => {
    const fixture = await seededEvent(0);
    unwrap(await setDraftConfig(fixture.eventId, { balanceMode: "per_team" }, db));
    unwrap(
      await setTeams(
        fixture.eventId,
        [{ name: "Alpha", balanceStart: 1200 }, { name: "Bravo", balanceStart: 800 }],
        db
      )
    );
    const written = unwrap(await setDraftConfig(fixture.eventId, { minBid: 5 }, db));
    expect(written.rebalanced).toBe(0);
    expect((await getTeams(fixture.eventId, db)).map((team) => team.balanceStart)).toEqual([
      1200, 800,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The pool                                                           */
/* ------------------------------------------------------------------ */

describe("setPoolKind", () => {
  it("holds a player over and brings them back without touching the history", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const [held] = fixture.members;

    const over = unwrap(await setPoolKind(fixture.eventId, held, "reserve", db));
    expect(over.moved).toBe(true);
    expect(over.reserve.map((entry) => entry.userId)).toEqual([held]);
    expect(over.main.map((entry) => entry.userId)).not.toContain(held);

    const back = unwrap(await setPoolKind(fixture.eventId, held, "main", db));
    expect(back.main.map((entry) => entry.userId)).toContain(held);
    expect(back.reserve).toHaveLength(0);

    // Setting the pool up beforehand is bookkeeping, not something that
    // happened in front of everyone — it must leave no lot behind.
    expect(await getDraftHistory(fixture.eventId, db)).toHaveLength(0);
  });

  it("is a no-op when they are already in that pool", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const again = unwrap(await setPoolKind(fixture.eventId, fixture.members[0], "main", db));
    expect(again.moved).toBe(false);
    expect(again.main).toHaveLength(2);
  });

  it("refuses somebody who is not in the pool, and says why when they are drafted", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const stranger = await makeUser(db, { displayName: "Stranger" });
    const missing = await setPoolKind(fixture.eventId, stranger, "reserve", db);
    expect(missing.ok === false && missing.error).toMatch(/not in this draft's pool/i);

    const [team] = unwrap(
      await setTeams(fixture.eventId, [{ name: "Reds", balanceStart: 1000 }], db)
    ).teams;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await placeBid(lot.id, team.id, 10, {}, db));
    unwrap(await awardLot(lot.id, team.id, {}, db));

    const drafted = await setPoolKind(fixture.eventId, fixture.members[0], "reserve", db);
    expect(drafted.ok === false && drafted.error).toMatch(/already on a team/i);
  });
});

describe("setDraftPool", () => {
  it("seeds from the accepted applications in the order they arrived", async () => {
    const fixture = await seededEvent(4);
    const written = unwrap(await setDraftPool(fixture.eventId, {}, db));
    expect(written).toMatchObject({ main: 4, reserve: 0 });

    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.main.map((entry) => entry.userId)).toEqual(fixture.members);
    expect(pool.main.map((entry) => entry.sort)).toEqual([0, 1, 2, 3]);
  });

  it("leaves out anybody who is not accepted", async () => {
    const fixture = await seededEvent(3);
    const applications = await db.query.applications.findMany({
      where: (row, { eq: is }) => is(row.eventId, fixture.eventId),
      orderBy: (row, { asc: up }) => up(row.submittedAt),
    });
    unwrap(await setApplicationStatus(applications[1].id, "declined", {}, db));

    const written = unwrap(await setDraftPool(fixture.eventId, {}, db));
    expect(written.main).toBe(2);
  });

  it("takes an explicit list and refuses an unknown player", async () => {
    const fixture = await seededEvent(3);
    const written = unwrap(
      await setDraftPool(fixture.eventId, { userIds: [fixture.members[2], fixture.members[0]] }, db)
    );
    expect(written.main).toBe(2);
    expect((await getDraftPool(fixture.eventId, db)).main.map((entry) => entry.userId)).toEqual([
      fixture.members[2],
      fixture.members[0],
    ]);

    const bad = await setDraftPool(
      fixture.eventId,
      { userIds: ["00000000-0000-0000-0000-000000000000"] },
      db
    );
    expect(bad.ok === false && bad.error).toMatch(/do not have an account/);
  });

  it("removes people the new list drops", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const written = unwrap(
      await setDraftPool(fixture.eventId, { userIds: [fixture.members[0]] }, db)
    );
    expect(written.removed).toHaveLength(2);
    expect((await getDraftPool(fixture.eventId, db)).main).toHaveLength(1);
  });

  it("leaves a reserved player in the reserve pool across a reseed", async () => {
    const fixture = await seededEvent(4);
    await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await moveToReserve(lot.id, {}, db));
    expect((await getDraftPool(fixture.eventId, db)).reserve).toHaveLength(1);

    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.reserve.map((entry) => entry.userId)).toEqual([fixture.members[2]]);
    expect(pool.main.map((entry) => entry.userId)).toEqual([fixture.members[3]]);
  });

  it("refuses to change the pool with somebody on the block", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));

    const result = await setDraftPool(fixture.eventId, { userIds: [fixture.members[1]] }, db);
    expect(result.ok === false && result.error).toMatch(/on the block/);
  });

  it("names the accepted applicants nobody has put anywhere", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, { userIds: [fixture.members[0]] }, db));
    expect(await getUnpooledApplicants(fixture.eventId, db)).toEqual([
      fixture.members[1],
      fixture.members[2],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Lots                                                               */
/* ------------------------------------------------------------------ */

describe("openLot", () => {
  it("spins, and records everything a browser needs to replay it", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const now = new Date("2026-01-01T20:00:00Z");
    const lot = unwrap(await openLot(fixture.eventId, { now, pick: () => 1 }, db));

    expect(lot.playerUserId).toBe(fixture.members[1]);
    expect(lot.status).toBe("open");
    expect(lot.fromKind).toBe("main");
    expect(lot.spin).toEqual({
      pool: fixture.members,
      targetIndex: 1,
      startedAt: now.getTime(),
      durationMs: SPIN_DURATION_MS,
      turns: 6,
    });
  });

  it("records no spin when the admin names the player", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    expect(lot.spin).toBeNull();
  });

  it("leaves the player in the pool until the lot settles", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    expect((await getDraftPool(fixture.eventId, db)).main).toHaveLength(2);
  });

  it("refuses a second open lot", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));

    const second = await openLot(fixture.eventId, { userId: fixture.members[1] }, db);
    expect(second.ok === false && second.error).toMatch(/already on the block/);
  });

  it("refuses a player who is not in the pool, and an empty pool", async () => {
    const fixture = await seededEvent(2);
    const empty = await openLot(fixture.eventId, {}, db);
    expect(empty.ok === false && empty.error).toMatch(/empty/);

    unwrap(await setDraftPool(fixture.eventId, { userIds: [fixture.members[0]] }, db));
    const stranger = await openLot(fixture.eventId, { userId: fixture.members[1] }, db);
    expect(stranger.ok === false && stranger.error).toMatch(/not in that pool/);
  });

  it("falls through to the reserve pool once the main one is empty", async () => {
    const fixture = await seededEvent(3);
    await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, { userIds: [fixture.members[2]] }, db));

    const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await moveToReserve(first.id, {}, db));

    const next = unwrap(await openLot(fixture.eventId, { pick: () => 0 }, db));
    expect(next.fromKind).toBe("reserve");
    expect(next.playerUserId).toBe(fixture.members[2]);
  });

  it("refuses the reserve pool when the event has it switched off", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftConfig(fixture.eventId, { reserveEnabled: false }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const result = await openLot(fixture.eventId, { kind: "reserve" }, db);
    expect(result.ok === false && result.error).toMatch(/switched off/);
  });

  it("asks for a name when the event picks by hand", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftConfig(fixture.eventId, { selectionMode: "admin_pick" }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const result = await openLot(fixture.eventId, {}, db);
    expect(result.ok === false && result.error).toMatch(/name the player/);
    expect((await openLot(fixture.eventId, { userId: fixture.members[0] }, db)).ok).toBe(true);
  });

  it("takes the front of the queue in fixed order", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftConfig(fixture.eventId, { selectionMode: "fixed_order" }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const lot = unwrap(await openLot(fixture.eventId, {}, db));
    expect(lot.playerUserId).toBe(fixture.members[0]);
    expect(lot.spin).toBeNull();
  });
});

describe("placeBid", () => {
  it("records a bid without touching the balance", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    const placed = unwrap(await placeBid(lot.id, a, 250, {}, db));
    expect(placed.bid.amount).toBe(250);
    expect(placed.balance).toBe(1000);
    expect(await balanceOf(fixture.eventId, a)).toBe(1000);
  });

  it("refuses a second sealed bid from the same team", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    unwrap(await placeBid(lot.id, a, 100, {}, db));
    const again = await placeBid(lot.id, a, 200, {}, db);
    expect(again.ok === false && again.error).toMatch(/already bid/);
  });

  it("lets an open-bidding team raise its own bid", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { biddingMode: "open", minIncrement: 10 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    unwrap(await placeBid(lot.id, a, 100, {}, db));
    const low = await placeBid(lot.id, b, 105, {}, db);
    expect(low.ok === false && low.error).toMatch(/at least 110/);
    unwrap(await placeBid(lot.id, b, 110, {}, db));
    unwrap(await placeBid(lot.id, a, 200, {}, db));

    const bids = await db.select().from(draftLots).where(eq(draftLots.id, lot.id));
    expect(bids).toHaveLength(1);
    const resolution = await getOpenLotResolution(fixture.eventId, db);
    expect(resolution).toMatchObject({ kind: "winner", teamId: a, amount: 200 });
  });

  it("refuses a bid over the must-fill cap, at the boundary", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    // One captain on board, six-a-side: five slots left, four of them still to
    // fill after this one, so 996 is the most that may be offered.
    const over = await placeBid(lot.id, a, 997, {}, db);
    expect(over.ok === false && over.error).toMatch(/at most 996/);
    expect(unwrap(await placeBid(lot.id, a, 996, {}, db)).max).toBe(996);
  });

  it("lets the same team spend the lot when the rule is off", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { mustFillRoster: false }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    expect(unwrap(await placeBid(lot.id, a, 1000, {}, db)).max).toBe(1000);
  });

  it("refuses a team from another event outright", async () => {
    const mine = await seededEvent(3);
    const theirs = await seededEvent(3);
    await twoTeams(mine);
    const other = await twoTeams(theirs);
    unwrap(await setDraftPool(mine.eventId, {}, db));
    const lot = unwrap(await openLot(mine.eventId, { userId: mine.members[2] }, db));

    const result = await placeBid(lot.id, other.a, 10, {}, db);
    expect(result.ok === false && result.error).toMatch(/not in this draft/);
  });

  it("refuses a bid once the lot has settled", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 50, {}, db));
    unwrap(await awardLot(lot.id, a, {}, db));

    const late = await placeBid(lot.id, b, 500, {}, db);
    expect(late.ok === false && late.error).toMatch(/on the block/);
  });

  it("lets an admin take a bid back off an open lot", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 100, {}, db));

    expect(unwrap(await clearBid(lot.id, a, db)).cleared).toBe(true);
    expect(await getOpenLotResolution(fixture.eventId, db)).toEqual({ kind: "none" });
    // And the captain may bid again, which is the point of clearing it.
    expect((await placeBid(lot.id, a, 400, {}, db)).ok).toBe(true);
  });
});

describe("awardLot", () => {
  it("deducts exactly once and puts the player on the roster", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 300, {}, db));
    const awarded = unwrap(await awardLot(lot.id, a, {}, db));

    expect(awarded.lot).toMatchObject({ status: "awarded", winnerTeamId: a, price: 300 });
    expect(awarded.member).toMatchObject({ userId: fixture.members[2], price: 300, isCaptain: false });
    expect(awarded.balance).toBe(700);

    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    expect(team?.balance).toBe(700);
    expect(team?.roster).toMatchObject({ size: 2, slotsLeft: 4 });
    expect((await getDraftPool(fixture.eventId, db)).main.map((entry) => entry.userId)).toEqual([]);
  });

  it("refuses to award to a team that has not bid", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 10, {}, db));

    const result = await awardLot(lot.id, b, {}, db);
    expect(result.ok === false && result.error).toMatch(/has not bid/);
  });

  it("refuses to award the same lot twice", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 10, {}, db));
    unwrap(await placeBid(lot.id, b, 20, {}, db));
    unwrap(await awardLot(lot.id, b, {}, db));

    const again = await awardLot(lot.id, a, {}, db);
    expect(again.ok === false && again.error).toMatch(/already settled/);
    expect(await balanceOf(fixture.eventId, b)).toBe(980);
    expect(await balanceOf(fixture.eventId, a)).toBe(1000);
  });

  it("leaves a tie for the admin, and takes whichever team they name", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 200, {}, db));
    unwrap(await placeBid(lot.id, b, 200, {}, db));

    // Nothing settles it on its own.
    expect(await getOpenLotResolution(fixture.eventId, db)).toMatchObject({
      kind: "tie",
      amount: 200,
      teamIds: [a, b].sort(),
    });
    const snapshot = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(snapshot?.lot?.bids).toHaveLength(2);

    // The admin's call goes through at the tied amount.
    unwrap(await awardLot(lot.id, b, {}, db));
    expect(await balanceOf(fixture.eventId, b)).toBe(800);
  });

  it("refuses a player who is somehow already on a roster", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, { userIds: [fixture.members[3]] }, db));

    // Force the state the pool alone cannot reach: on a roster *and* still on
    // the wheel. The award has to notice, or the unique index would refuse it
    // with a constraint violation instead of a sentence.
    await db.insert(teamMembers).values({
      teamId: b,
      eventId: fixture.eventId,
      userId: fixture.members[3],
      price: 0,
      isCaptain: false,
    });

    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[3] }, db));
    unwrap(await placeBid(lot.id, a, 10, {}, db));

    const result = await awardLot(lot.id, a, {}, db);
    expect(result.ok === false && result.error).toMatch(/already been drafted/);
  });

  it("refuses to fill a seventh seat on a six-player roster", async () => {
    const fixture = await seededEvent(9);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 3 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    await buy(fixture.eventId, fixture.members[2], a, 10);
    await buy(fixture.eventId, fixture.members[3], a, 10);

    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[4] }, db));
    const bid = await placeBid(lot.id, a, 10, {}, db);
    expect(bid.ok === false && bid.error).toMatch(/roster is full/);
  });
});

describe("discardLot and moveToReserve", () => {
  it("takes a discarded player out of the draft", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));

    const closed = unwrap(await discardLot(lot.id, {}, db));
    expect(closed.status).toBe("discarded");
    expect((await getDraftPool(fixture.eventId, db)).main.map((entry) => entry.userId)).toEqual([
      fixture.members[1],
      fixture.members[2],
    ]);
    expect(await getDiscardedPlayers(fixture.eventId, db)).toEqual([fixture.members[0]]);
  });

  it("sends a reserved player round again later", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await moveToReserve(first.id, {}, db));

    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.main.map((entry) => entry.userId)).toEqual([fixture.members[3]]);
    expect(pool.reserve.map((entry) => entry.userId)).toEqual([fixture.members[2]]);

    // The whole point: they can be drafted on the second pass.
    const second = unwrap(
      await openLot(fixture.eventId, { kind: "reserve", userId: fixture.members[2] }, db)
    );
    expect(second.fromKind).toBe("reserve");
    unwrap(await placeBid(second.id, a, 40, {}, db));
    unwrap(await awardLot(second.id, a, {}, db));

    expect(await balanceOf(fixture.eventId, a)).toBe(960);
    expect((await getDraftPool(fixture.eventId, db)).reserve).toEqual([]);
  });

  it("refuses to reserve somebody who is already in the reserve pool", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await moveToReserve(first.id, {}, db));

    const second = unwrap(
      await openLot(fixture.eventId, { kind: "reserve", userId: fixture.members[0] }, db)
    );
    const result = await moveToReserve(second.id, {}, db);
    expect(result.ok === false && result.error).toMatch(/already in the reserve/);
  });

  it("refuses to settle a lot twice", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await discardLot(lot.id, {}, db));

    expect((await discardLot(lot.id, {}, db)).ok).toBe(false);
    expect((await moveToReserve(lot.id, {}, db)).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Undo                                                               */
/* ------------------------------------------------------------------ */

describe("voidLot — the undo", () => {
  it("gives back the money, the slot and the player, and leaves a trace", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const lotId = await buy(fixture.eventId, fixture.members[2], a, 420);
    expect(await balanceOf(fixture.eventId, a)).toBe(580);

    const undone = unwrap(await voidLot(lotId, {}, db));
    expect(undone).toMatchObject({ refunded: 420, returnedTo: "main" });

    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    expect(team?.balance).toBe(1000);
    expect(team?.roster).toMatchObject({ size: 1, slotsLeft: 5 });
    expect((await getDraftPool(fixture.eventId, db)).main.map((entry) => entry.userId)).toEqual([
      fixture.members[2],
    ]);

    // The row survives, and it still says who paid what.
    const [row] = await db.select().from(draftLots).where(eq(draftLots.id, lotId));
    expect(row).toMatchObject({ status: "voided", winnerTeamId: a, price: 420 });
    expect(row.voidedAt).toBeInstanceOf(Date);
    expect(await getDraftHistory(fixture.eventId, db)).toHaveLength(1);
  });

  it("keeps the balance right when earlier lots are voided out of order", async () => {
    const fixture = await seededEvent(5);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const first = await buy(fixture.eventId, fixture.members[2], a, 100);
    await buy(fixture.eventId, fixture.members[3], a, 250);
    await buy(fixture.eventId, fixture.members[4], a, 50);
    expect(await balanceOf(fixture.eventId, a)).toBe(600);

    // Undo the *first* one, three lots later. A stored balance would have to be
    // patched; a derived one simply stops counting it.
    unwrap(await voidLot(first, {}, db));
    expect(await balanceOf(fixture.eventId, a)).toBe(700);

    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    expect(team?.roster.size).toBe(3);
    // The roster prices still agree with the awarded lots, which is the thing
    // two sources of truth would get wrong.
    const spent = team?.members.reduce((total, member) => total + member.price, 0);
    expect(spent).toBe(300);
    expect(team?.balanceStart! - spent!).toBe(team?.balance);
  });

  it("puts a discarded player back on the wheel they came from", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await discardLot(lot.id, {}, db));

    const undone = unwrap(await voidLot(lot.id, {}, db));
    expect(undone).toMatchObject({ refunded: null, returnedTo: "main" });
    expect((await getDraftPool(fixture.eventId, db)).main.map((entry) => entry.userId)).toContain(
      fixture.members[0]
    );
  });

  it("pulls a reserved player back into the main pool", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await moveToReserve(lot.id, {}, db));

    unwrap(await voidLot(lot.id, {}, db));
    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.reserve).toEqual([]);
    expect(pool.main.map((entry) => entry.userId)).toContain(fixture.members[0]);
  });

  it("returns an awarded reserve player to the reserve pool, not the main one", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await moveToReserve(first.id, {}, db));
    const second = unwrap(
      await openLot(fixture.eventId, { kind: "reserve", userId: fixture.members[2] }, db)
    );
    unwrap(await placeBid(second.id, a, 30, {}, db));
    unwrap(await awardLot(second.id, a, {}, db));

    unwrap(await voidLot(second.id, {}, db));
    const pool = await getDraftPool(fixture.eventId, db);
    expect(pool.reserve.map((entry) => entry.userId)).toEqual([fixture.members[2]]);
    expect(pool.main).toEqual([]);
  });

  it("cancels an open lot without disturbing the pool", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));

    const undone = unwrap(await voidLot(lot.id, {}, db));
    expect(undone).toMatchObject({ refunded: null, returnedTo: null });
    expect((await getDraftPool(fixture.eventId, db)).main).toHaveLength(2);
    // And the wheel can turn again.
    expect((await openLot(fixture.eventId, { userId: fixture.members[1] }, db)).ok).toBe(true);
  });

  it("refuses to void the same lot twice", async () => {
    const fixture = await seededEvent(2);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
    unwrap(await voidLot(lot.id, {}, db));

    const again = await voidLot(lot.id, {}, db);
    expect(again.ok === false && again.error).toMatch(/already been voided/);
  });

  it("unwinds a run of lots in the order they were drafted", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    await buy(fixture.eventId, fixture.members[2], a, 100);
    await buy(fixture.eventId, fixture.members[3], a, 200);
    expect(await balanceOf(fixture.eventId, a)).toBe(700);

    expect(unwrap(await voidLastLot(fixture.eventId, {}, db)).refunded).toBe(200);
    expect(await balanceOf(fixture.eventId, a)).toBe(900);
    expect(unwrap(await voidLastLot(fixture.eventId, {}, db)).refunded).toBe(100);
    expect(await balanceOf(fixture.eventId, a)).toBe(1000);

    const nothing = await voidLastLot(fixture.eventId, {}, db);
    expect(nothing.ok === false && nothing.error).toMatch(/nothing to undo/i);
  });

  it("lets a voided player be drafted again, by anybody", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const first = await buy(fixture.eventId, fixture.members[2], a, 400);
    unwrap(await voidLot(first, {}, db));
    await buy(fixture.eventId, fixture.members[2], b, 90);

    expect(await balanceOf(fixture.eventId, a)).toBe(1000);
    expect(await balanceOf(fixture.eventId, b)).toBe(910);
    const rosters = await getTeams(fixture.eventId, db);
    expect(rosters.find((team) => team.id === b)?.members).toHaveLength(2);
    // Both lots are on the record — the voided one and the one that stuck.
    expect(await getDraftHistory(fixture.eventId, db)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* A whole draft                                                      */
/* ------------------------------------------------------------------ */

describe("a draft from an empty pool to complete", () => {
  it("fills two three-player rosters and knows when it is done", async () => {
    const fixture = await seededEvent(6);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 3, defaultBalance: 300 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const start = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(start?.completion).toMatchObject({ complete: false, reason: "in_progress" });
    expect(start?.pools.main).toHaveLength(4);

    const pool = fixture.members.slice(2);
    await buy(fixture.eventId, pool[0], a, 120);
    await buy(fixture.eventId, pool[1], b, 90);
    await buy(fixture.eventId, pool[2], a, 60);
    await buy(fixture.eventId, pool[3], b, 30);

    const end = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(end?.completion).toMatchObject({ complete: true, reason: "both", short: [] });
    expect(end?.pools.main).toEqual([]);
    expect(end?.history).toHaveLength(4);

    const finished = await getTeams(fixture.eventId, db);
    expect(finished.map((team) => team.balance)).toEqual([120, 180]);
    expect(finished.every((team) => team.roster.full)).toBe(true);
    expect(finished.every((team) => team.members.filter((m) => m.isCaptain).length === 1)).toBe(
      true
    );
  });

  it("finishes with the pool empty and says who is short", async () => {
    const fixture = await seededEvent(3);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 3 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    await buy(fixture.eventId, fixture.members[2], a, 10);

    const snapshot = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(snapshot?.completion).toMatchObject({ complete: true, reason: "pool_empty" });
    expect(snapshot?.completion.short).toEqual([
      { teamId: a, slotsLeft: 1 },
      { teamId: b, slotsLeft: 2 },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The room                                                           */
/* ------------------------------------------------------------------ */

describe("getDraftView", () => {
  async function room() {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 120, {}, db));
    unwrap(await placeBid(lot.id, b, 45, {}, db));
    return { fixture, a, b, lotId: lot.id };
  }

  it("works out what each viewer is", async () => {
    const { fixture, a } = await room();
    expect(await viewerFor(fixture.eventId, fixture.members[0], false, db)).toEqual({
      role: "captain",
      userId: fixture.members[0],
      teamId: a,
    });
    expect(await viewerFor(fixture.eventId, fixture.members[2], false, db)).toMatchObject({
      role: "player",
      teamId: null,
    });
    expect(await viewerFor(fixture.eventId, await makeUser(db), false, db)).toMatchObject({
      role: "observer",
    });
    expect(await viewerFor(fixture.eventId, null, false, db)).toMatchObject({
      role: "observer",
      userId: null,
    });
    expect(await viewerFor(fixture.eventId, fixture.members[0], true, db)).toMatchObject({
      role: "admin",
    });
  });

  it("shows an admin the amounts and a captain only their own", async () => {
    const { fixture, a, b } = await room();

    const admin = await getDraftView(
      fixture.eventId,
      { role: "admin", userId: null, teamId: null },
      {},
      db
    );
    expect(admin?.teams.map((team) => team.bid)).toEqual([120, 45]);
    expect(admin?.lot?.resolution).toMatchObject({ kind: "winner", teamId: a });

    const captain = await getDraftView(
      fixture.eventId,
      { role: "captain", userId: fixture.members[1], teamId: b },
      {},
      db
    );
    expect(captain?.teams.map((team) => team.bid)).toEqual([null, 45]);
    expect(captain?.lot?.resolution).toBeNull();
    expect(captain?.mainPool).toBeNull();
    expect(captain?.mainPoolCount).toBe(2);
  });

  it("hands back the names for every id it did not hide", async () => {
    const { fixture } = await room();
    const view = await getDraftView(
      fixture.eventId,
      { role: "observer", userId: null, teamId: null },
      {},
      db
    );
    expect(view?.players[fixture.members[0]].displayName).toMatch(/^Player /);
    expect(view?.players[fixture.members[2]]).toBeDefined();
  });

  it("does not leak the player's name while the wheel is turning", async () => {
    const fixture = await seededEvent(3);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const now = new Date();
    unwrap(await openLot(fixture.eventId, { now, pick: () => 0 }, db));

    const view = await getDraftView(
      fixture.eventId,
      { role: "observer", userId: null, teamId: null },
      { now },
      db
    );
    expect(view?.phase).toBe("spinning");
    expect(view?.lot?.playerUserId).toBeNull();
    // The wheel is drawn from the ids in the spin, which every viewer has —
    // but the one it lands on is not called out until the animation ends.
    expect(view?.lot?.spin?.pool).toHaveLength(3);
  });

  it("is null for an event that does not exist", async () => {
    const missing = await getDraftView(
      "00000000-0000-0000-0000-000000000000",
      { role: "admin", userId: null, teamId: null },
      {},
      db
    );
    expect(missing).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* What Postgres holds on to                                          */
/* ------------------------------------------------------------------ */

describe("the tables underneath", () => {
  it("keeps every team's rows inside its own event", async () => {
    const fixture = await seededEvent(3);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], a, 10);

    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.eventId, fixture.eventId))
      .orderBy(asc(teamMembers.acquiredAt));
    expect(rows.every((row) => row.eventId === fixture.eventId)).toBe(true);

    const teamRows = await db
      .select()
      .from(teamsTable)
      .where(eq(teamsTable.eventId, fixture.eventId));
    expect(teamRows).toHaveLength(2);
  });
});
