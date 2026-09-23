import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  draftLots,
  draftPoolEntries,
  teamMembers,
  teams as teamsTable,
  users as usersTable,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  clearBid,
  clearBids,
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
  const created = await createEvent({ ...PUBLISHABLE, title: `Draft fixture ${counter}` }, db);
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

/**
 * This file's database, except that the first transaction it opens runs
 * `between` to completion first — the same helper `events.test.ts` uses, for
 * the same reason.
 *
 * Sequenced rather than raced. A second manager awarding a lot in the exact
 * window between "which lot is last" and "void it" is not something a timer
 * can be trusted to reproduce, and a test that had to *win* a race to see the
 * bug would pass by luck on the days it did not. This pins the interleave:
 * everything the outer call could have read before it opened its transaction
 * is stale, because the inner one has already committed.
 */
function committingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) => {
        const first = pending;
        pending = null;
        if (first) await first();
        return target.transaction(run);
      };
    },
  });
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

    // It used to accept the save and quietly rebalance nobody. UC-16 1a says
    // the rule is refused outright, which is the better answer: an admin who
    // pressed Save and was told "saved" reasonably believed the new figure was
    // in force.
    const result = await setDraftConfig(fixture.eventId, { defaultBalance: 5 }, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/the starting balance/);
    expect((await getTeams(fixture.eventId, db)).every((team) => team.balanceStart === 1000)).toBe(
      true
    );
    expect((await getDraftConfig(fixture.eventId, db)).defaultBalance).toBe(1000);
  });

  /*
   * UC-16 1a: "Rules changed after the first lot opened - System refuses."
   *
   * The first lot *opened*, which is earlier than the first lot awarded and
   * much earlier than anything the old refusals watched for. From the moment a
   * name is on the wheel, captains are working out what to offer against a
   * published minimum, timer and roster size, and moving any of them changes
   * what every bid already placed was worth.
   */
  describe("the rules lock when the first lot opens (UC-16 1a)", () => {
    /** An event with rules saved, a pool, and one lot open on the wheel. */
    async function midLot() {
      const fixture = await seededEvent(4);
      await twoTeams(fixture);
      unwrap(await setDraftConfig(fixture.eventId, { minBid: 20 }, db));
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
      return { fixture, lot };
    }

    it("refuses a rule change while the very first lot is still open", async () => {
      const { fixture } = await midLot();

      const result = await setDraftConfig(fixture.eventId, { minBid: 500 }, db);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/the minimum bid/);
      expect((await getDraftConfig(fixture.eventId, db)).minBid).toBe(20);
    });

    it("names every rule the save would have moved", async () => {
      const { fixture } = await midLot();

      const result = await setDraftConfig(
        fixture.eventId,
        { bidTimerSeconds: 45, mustFillRoster: false },
        db
      );
      expect(result.ok === false && result.error).toMatch(/the bid timer/);
      expect(result.ok === false && result.error).toMatch(/the roster-fill protection/);
    });

    it("still refuses once that first lot has been cancelled", async () => {
      // A lot that opened and was cancelled still happened in front of the
      // room, and the room was told the rules it was bidding under.
      const { fixture, lot } = await midLot();
      unwrap(await voidLot(lot.id, {}, db));

      expect((await setDraftConfig(fixture.eventId, { minBid: 1 }, db)).ok).toBe(false);
    });

    it("lets an identical re-save through, because nothing moved", async () => {
      // The Draft tab posts the whole form on every save, so this is the
      // ordinary case; refusing it would tell an admin the draft is broken
      // when they have changed nothing at all.
      const { fixture } = await midLot();
      const current = await getDraftConfig(fixture.eventId, db);

      expect(unwrap(await setDraftConfig(fixture.eventId, current, db)).config).toEqual(current);
    });

    it("lets every rule through right up until the wheel turns", async () => {
      const fixture = await seededEvent(4);
      await twoTeams(fixture);
      unwrap(await setDraftPool(fixture.eventId, {}, db));

      const before = unwrap(
        await setDraftConfig(
          fixture.eventId,
          { minBid: 30, bidTimerSeconds: 45, rosterTarget: 4, reserveRounds: 2 },
          db
        )
      );
      expect(before.config).toMatchObject({ minBid: 30, bidTimerSeconds: 45, reserveRounds: 2 });
    });
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

  /*
   * R-148 is the manager moving players between the pools *before the draft*,
   * and UC-16 E6a refuses the same move after the first lot has opened. The
   * "before" half worked; the "after" half was never checked, so a name could
   * be moved off the wheel the room was looking at with nothing to show for it.
   */
  describe("after the first lot has opened (UC-16 E6a)", () => {
    it("refuses the move, and points at the way that leaves a trace", async () => {
      const fixture = await seededEvent(4);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
      unwrap(await discardLot(lot.id, {}, db));

      const result = await setPoolKind(fixture.eventId, fixture.members[1], "reserve", db);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/pools are fixed/);

      const pool = await getDraftPool(fixture.eventId, db);
      expect(pool.reserve).toEqual([]);
      expect(pool.main.map((entry) => entry.userId)).toContain(fixture.members[1]);
    });

    it("is still a no-op rather than a refusal when nothing would move", async () => {
      // E6a is about changing the pools, and asking for the pool somebody is
      // already in changes nothing. A refusal here would make an idle screen
      // refresh look like a failure.
      const fixture = await seededEvent(3);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[0] }, db));
      unwrap(await discardLot(lot.id, {}, db));

      const same = unwrap(await setPoolKind(fixture.eventId, fixture.members[1], "main", db));
      expect(same.moved).toBe(false);
    });
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

  /*
   * UC-16 8: "Repeat 3-7 until rosters are full or the pool is empty." The
   * pool-empty half has always been refused ("that pool is empty"); the
   * rosters-full half was not, so the wheel happily put a name up that every
   * captain would then be refused a bid on — `canPlaceBid` answers
   * `roster_full` to all of them — leaving a lot that can only be cancelled.
   */
  it("refuses to open a lot when every roster is full (UC-16 8)", async () => {
    const fixture = await seededEvent(5);
    const { a, b } = await twoTeams(fixture);
    // One seat per team, and the captain is in it (§14).
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 1 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const named = await openLot(fixture.eventId, { userId: fixture.members[2] }, db);
    expect(named.ok).toBe(false);
    expect(named.ok === false && named.error).toMatch(/Every roster is full/);

    // The wheel is refused the same way, so it is the state and not the name.
    expect((await openLot(fixture.eventId, {}, db)).ok).toBe(false);

    // There are still players waiting, which is what makes this the right
    // refusal rather than "the pool is empty".
    expect((await getDraftPool(fixture.eventId, db)).main.length).toBeGreaterThan(0);
    expect([a, b]).toHaveLength(2);
  });

  it("opens again the moment an undo frees a seat", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 2 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const bought = await buy(fixture.eventId, fixture.members[2], a, 10);
    await buy(fixture.eventId, fixture.members[3], b, 10);
    expect((await openLot(fixture.eventId, {}, db)).ok).toBe(false);

    // Derived, not counted: voiding the lot gives the seat back and the wheel
    // turns again without anything being reset.
    unwrap(await voidLot(bought, {}, db));
    expect((await openLot(fixture.eventId, { userId: fixture.members[2] }, db)).ok).toBe(true);
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

/* ------------------------------------------------------------------ */
/* Task 20: the settings that were stored but never walked            */
/* ------------------------------------------------------------------ */

/**
 * R-143 / UC-16 E1, via UC-17 3d: "bids after it are refused".
 *
 * The countdown on the screen is a convenience; the refusal has to be the
 * server's, because a browser with its clock an hour out, a tab that has been
 * throttled, or anybody typing into the console is not bound by a countdown.
 */
describe("the bid time limit (R-143 / UC-16 E1)", () => {
  /** An event with a `seconds` timer and a lot open at `at`. */
  async function timed(seconds: number, at: Date) {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { bidTimerSeconds: seconds }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(
      await openLot(fixture.eventId, { userId: fixture.members[2], now: at }, db)
    );
    return { fixture, a, lot };
  }

  const at = new Date("2026-03-01T12:00:00.000Z");

  it("takes a bid inside the limit", async () => {
    const { a, lot } = await timed(30, at);
    const inTime = new Date(at.getTime() + 29_000);
    expect((await placeBid(lot.id, a, 50, { now: inTime }, db)).ok).toBe(true);
  });

  it("refuses one that arrives after it, on the server (UC-17 3d)", async () => {
    const { fixture, a, lot } = await timed(30, at);
    const late = new Date(at.getTime() + 30_001);

    const result = await placeBid(lot.id, a, 50, { now: late }, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/closed/i);

    // "System rejects; nothing stored" — UC-17 3d, both halves.
    expect((await getDraftSnapshot(fixture.eventId, {}, db))?.lot?.bids).toEqual([]);
    expect(await getOpenLotResolution(fixture.eventId, db)).toEqual({ kind: "none" });
  });

  it("gives the room the same deadline the server enforces, spin included", async () => {
    /*
     * The bug this pins. `biddingOpen` starts the clock when the *wheel stops*
     * — nobody can bid on a name they cannot see — but the payload's `endsAt`
     * was `openedAt + timer`, which on a 20 second timer is six and a half
     * seconds early. A captain watched the countdown hit zero and stopped
     * bidding while the server was still taking bids.
     */
    const fixture = await seededEvent(4);
    await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { bidTimerSeconds: 20 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));

    const lot = unwrap(await openLot(fixture.eventId, { now: at, pick: () => 0 }, db));
    expect(lot.spin).not.toBeNull();

    const snapshot = await getDraftSnapshot(fixture.eventId, { now: at }, db);
    expect(snapshot?.lot?.endsAt).toBe(at.getTime() + SPIN_DURATION_MS + 20_000);
  });

  it("does not start the clock until the wheel has stopped", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { bidTimerSeconds: 20 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { now: at, pick: () => 0 }, db));

    // A moment that is past `openedAt + 20s` but inside the real window.
    const during = new Date(at.getTime() + SPIN_DURATION_MS + 19_000);
    expect((await placeBid(lot.id, a, 10, { now: during }, db)).ok).toBe(true);
  });

  it("never closes when the manager has set no timer", async () => {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(
      await openLot(fixture.eventId, { userId: fixture.members[2], now: at }, db)
    );

    const muchLater = new Date(at.getTime() + 86_400_000);
    expect((await placeBid(lot.id, a, 10, { now: muchLater }, db)).ok).toBe(true);
    expect((await getDraftSnapshot(fixture.eventId, {}, db))?.lot?.endsAt).toBeNull();
  });
});

/**
 * R-145 / UC-16 E3: "manager sets a minimum bid - UC-17 refuses bids below it."
 */
describe("the minimum bid (R-145 / UC-16 E3)", () => {
  async function floored(minBid: number) {
    const fixture = await seededEvent(4);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { minBid }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    return { fixture, a, lot };
  }

  it("refuses a bid below it and names the figure", async () => {
    const { a, lot } = await floored(100);
    const low = await placeBid(lot.id, a, 99, {}, db);
    expect(low.ok).toBe(false);
    expect(low.ok === false && low.error).toMatch(/minimum bid is 100/);
  });

  it("takes one exactly on it", async () => {
    const { a, lot } = await floored(100);
    expect((await placeBid(lot.id, a, 100, {}, db)).ok).toBe(true);
  });

  it("lets a player go for nothing when the minimum is zero, as today", async () => {
    const { a, lot } = await floored(0);
    expect((await placeBid(lot.id, a, 0, {}, db)).ok).toBe(true);
  });
});

/**
 * R-146 / UC-16 E4: "manager switches off the roster-fill protection — UC-17 3b
 * no longer applies."
 */
describe("the roster-fill protection (R-146 / UC-16 E4)", () => {
  /** A team with four seats left and 1000 to spend. */
  async function protection(mustFillRoster: boolean) {
    const fixture = await seededEvent(6);
    const { a } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 5, mustFillRoster }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    return { fixture, a, lot };
  }

  it("keeps back a slot's worth for each seat still to fill, when on", async () => {
    // Five-player roster, the captain is one of them, so four seats left:
    // winning this lot takes one and three must still be fillable at 1 each.
    const { a, lot } = await protection(true);
    const overCap = await placeBid(lot.id, a, 998, {}, db);
    expect(overCap.ok).toBe(false);
    expect(overCap.ok === false && overCap.error).toMatch(/at most 997/);
    expect((await placeBid(lot.id, a, 997, {}, db)).ok).toBe(true);
  });

  it("lets a captain spend the lot when it is off (UC-17 3b no longer applies)", async () => {
    const { fixture, a, lot } = await protection(false);
    expect((await placeBid(lot.id, a, 1000, {}, db)).ok).toBe(true);
    unwrap(await awardLot(lot.id, a, {}, db));
    expect(await balanceOf(fixture.eventId, a)).toBe(0);
  });

  it("still refuses a bid over the balance either way (UC-17 3a)", async () => {
    // The switch turns off the *reserve*, not the balance. A draft where a
    // team can spend money it does not have is not a draft.
    for (const on of [true, false]) {
      const { a, lot } = await protection(on);
      const result = await placeBid(lot.id, a, 1001, {}, db);
      expect(result.ok).toBe(false);
    }
  });
});

/**
 * R-147 / UC-16 E5: "manager clears one captain's bid or every bid on the open
 * lot - System removes them; captains may bid again."
 */
describe("clearing bids (R-147 / UC-16 E5)", () => {
  async function threeBids() {
    const fixture = await seededEvent(5);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }, { name: "Charlie" }], db)
    );
    const [a, b, c] = written.teams.map((team) => team.id);
    unwrap(
      await setCaptains(
        fixture.eventId,
        [
          { teamId: a, userId: fixture.members[0] },
          { teamId: b, userId: fixture.members[1] },
          { teamId: c, userId: fixture.members[2] },
        ],
        db
      )
    );
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[3] }, db));
    unwrap(await placeBid(lot.id, a, 10, {}, db));
    unwrap(await placeBid(lot.id, b, 20, {}, db));
    unwrap(await placeBid(lot.id, c, 30, {}, db));
    return { fixture, a, b, c, lot };
  }

  it("takes one bid off and leaves the others standing", async () => {
    const { fixture, c, lot } = await threeBids();
    expect(unwrap(await clearBid(lot.id, c, db)).cleared).toBe(true);

    const snapshot = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(snapshot?.lot?.bids.map((bid) => bid.amount).sort((x, y) => x - y)).toEqual([10, 20]);
  });

  it("takes every bid off in one go, and says how many", async () => {
    const { fixture, lot } = await threeBids();
    expect(unwrap(await clearBids(lot.id, db)).cleared).toBe(3);
    expect((await getDraftSnapshot(fixture.eventId, {}, db))?.lot?.bids).toEqual([]);
    expect(await getOpenLotResolution(fixture.eventId, db)).toEqual({ kind: "none" });
  });

  it("lets the captains bid again afterwards, which is the point", async () => {
    const { a, b, c, lot } = await threeBids();
    unwrap(await clearBids(lot.id, db));
    // Sealed bidding is one bid per lot, so this is only possible because the
    // rows are gone rather than merely ignored.
    for (const teamId of [a, b, c]) {
      expect((await placeBid(lot.id, teamId, 40, {}, db)).ok).toBe(true);
    }
  });

  it("says nothing was cleared rather than failing on an untouched lot", async () => {
    const fixture = await seededEvent(3);
    await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    expect(unwrap(await clearBids(lot.id, db)).cleared).toBe(0);
  });

  it("refuses to clear bids off a lot that has already settled", async () => {
    const { a, lot } = await threeBids();
    unwrap(await voidLot(lot.id, {}, db));
    const result = await clearBids(lot.id, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already settled/);
    expect(a).toBeTruthy();
  });
});

/**
 * R-149 / UC-16 E7: "every captain able to bid has bid - System tells the
 * manager." The payload's `allBidsIn`, end to end.
 */
describe("the all-bids-in light (R-149 / UC-16 E7)", () => {
  it("comes on once every captain who can bid has", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    const viewer = { role: "admin", userId: null, teamId: null } as const;

    unwrap(await placeBid(lot.id, a, 10, {}, db));
    expect((await getDraftView(fixture.eventId, viewer, {}, db))?.lot?.allBidsIn).toBe(false);

    unwrap(await placeBid(lot.id, b, 20, {}, db));
    expect((await getDraftView(fixture.eventId, viewer, {}, db))?.lot?.allBidsIn).toBe(true);
  });

  it("does not wait for a team that has no captain to bid with", async () => {
    // The state a draft is in for its first few minutes. The light used to
    // stay dark for ever here, so a manager waited for a bid nobody could make.
    const fixture = await seededEvent(4);
    const written = unwrap(
      await setTeams(fixture.eventId, [{ name: "Alpha" }, { name: "Bravo" }], db)
    );
    const [a, bravo] = written.teams;
    unwrap(
      await setCaptains(fixture.eventId, [{ teamId: a.id, userId: fixture.members[0] }], db)
    );
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a.id, 10, {}, db));

    const view = await getDraftView(
      fixture.eventId,
      { role: "admin", userId: null, teamId: null },
      {},
      db
    );
    expect(view?.lot?.allBidsIn).toBe(true);
    expect(bravo.captainUserId).toBeNull();
  });

  it("does not wait for a team whose roster is already full", async () => {
    const fixture = await seededEvent(5);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftConfig(fixture.eventId, { rosterTarget: 2 }, db));
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    await buy(fixture.eventId, fixture.members[2], b, 10);

    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[3] }, db));
    unwrap(await placeBid(lot.id, a, 10, {}, db));

    const view = await getDraftView(
      fixture.eventId,
      { role: "admin", userId: null, teamId: null },
      {},
      db
    );
    expect(view?.lot?.allBidsIn).toBe(true);
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

  /*
   * UC-16 6: "Manager closes the lot and awards it to the highest bid."
   *
   * The only check used to be that the named team had bid at all, so a console
   * listing every bidder made "sell the player to whoever offered least, for
   * their own lower price" one click — in front of a room that had just
   * watched somebody else win.
   */
  it("refuses to award a lot to anything but the highest bid (UC-16 6)", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 100, {}, db));
    unwrap(await placeBid(lot.id, b, 500, {}, db));

    const wrong = await awardLot(lot.id, a, {}, db);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.error).toMatch(/highest bid/);

    // Nothing moved: no roster row, no money, and the lot is still open for the
    // manager to settle properly.
    expect(await balanceOf(fixture.eventId, a)).toBe(1000);
    const still = await getDraftSnapshot(fixture.eventId, {}, db);
    expect(still?.lot?.id).toBe(lot.id);

    unwrap(await awardLot(lot.id, b, {}, db));
    expect(await balanceOf(fixture.eventId, b)).toBe(500);
  });

  it("lets the lower bidder win once the higher bid is cleared (R-147)", async () => {
    const fixture = await seededEvent(4);
    const { a, b } = await twoTeams(fixture);
    unwrap(await setDraftPool(fixture.eventId, {}, db));
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 100, {}, db));
    unwrap(await placeBid(lot.id, b, 500, {}, db));

    // The way round a mistaken bid, and the one the refusal points at: the bid
    // goes, so the highest bid is a different number rather than the same
    // number awarded to somebody else.
    unwrap(await clearBid(lot.id, b, db));
    unwrap(await awardLot(lot.id, a, {}, db));
    expect(await balanceOf(fixture.eventId, a)).toBe(900);
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

  /*
   * R-144 / UC-16 E2: "manager sets how many times a reserved player can come
   * back — at 8a a reserved player is put up again at most that many times,
   * then is out of the draft."
   *
   * Until now the setting was stored and never read, and `moveToReserve`
   * refused outright the second time round — which made "comes back once" a
   * fact of the code rather than a number anybody could set. R-144's note in
   * docs/requirements.md says in so many words that it *replaces* that
   * assumption.
   */
  describe("how many times a reserved player comes back (R-144)", () => {
    /** Put `userId` up from the reserve wheel and hold them over again. */
    async function roundAgain(eventId: string, userId: string) {
      const lot = unwrap(await openLot(eventId, { kind: "reserve", userId }, db));
      return moveToReserve(lot.id, {}, db);
    }

    it("lets a player come back twice when the manager asks for two rounds", async () => {
      const fixture = await seededEvent(2);
      unwrap(await setDraftConfig(fixture.eventId, { reserveRounds: 2 }, db));
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const player = fixture.members[0];

      const first = unwrap(await openLot(fixture.eventId, { userId: player }, db));
      expect(unwrap(await moveToReserve(first.id, {}, db))).toMatchObject({
        returnedToPool: true,
        comebacksLeft: 2,
      });

      // Turn one of two: still has one left, so back on the wheel.
      expect(unwrap(await roundAgain(fixture.eventId, player))).toMatchObject({
        returnedToPool: true,
        comebacksLeft: 1,
      });
      expect((await getDraftPool(fixture.eventId, db)).reserve.map((e) => e.userId)).toEqual([
        player,
      ]);

      // Turn two of two: out of the draft, so out of the pool.
      expect(unwrap(await roundAgain(fixture.eventId, player))).toMatchObject({
        returnedToPool: false,
        comebacksLeft: 0,
      });
      expect((await getDraftPool(fixture.eventId, db)).reserve).toEqual([]);

      // And the wheel will not put them up again.
      const again = await openLot(fixture.eventId, { kind: "reserve", userId: player }, db);
      expect(again.ok).toBe(false);
    });

    it("stops after one round when that is what the manager set", async () => {
      const fixture = await seededEvent(2);
      unwrap(await setDraftConfig(fixture.eventId, { reserveRounds: 1 }, db));
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const player = fixture.members[0];

      const first = unwrap(await openLot(fixture.eventId, { userId: player }, db));
      unwrap(await moveToReserve(first.id, {}, db));

      expect(unwrap(await roundAgain(fixture.eventId, player))).toMatchObject({
        returnedToPool: false,
      });
      expect((await getDraftPool(fixture.eventId, db)).reserve).toEqual([]);
    });

    it("keeps a spent player off the wheel even if they are back in the pool", async () => {
      const fixture = await seededEvent(2);
      unwrap(await setDraftConfig(fixture.eventId, { reserveRounds: 1 }, db));
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const player = fixture.members[0];

      const first = unwrap(await openLot(fixture.eventId, { userId: player }, db));
      unwrap(await moveToReserve(first.id, {}, db));
      unwrap(await roundAgain(fixture.eventId, player));
      expect((await getDraftPool(fixture.eventId, db)).reserve).toEqual([]);

      // Force the state the pool alone cannot reach — a spent player sitting
      // in the reserve pool anyway — so the refusal is proved to come from the
      // count of lots rather than from their entry having been removed. This
      // is the state a future "put them back" button would produce.
      await db
        .insert(draftPoolEntries)
        .values({ eventId: fixture.eventId, userId: player, kind: "reserve", sort: 99 });

      const byName = await openLot(fixture.eventId, { kind: "reserve", userId: player }, db);
      expect(byName.ok).toBe(false);
      expect(byName.ok === false && byName.error).toMatch(/come back/);

      // And the wheel does not land on them either — that pool reads as empty.
      const bySpin = await openLot(fixture.eventId, { kind: "reserve" }, db);
      expect(bySpin.ok).toBe(false);
      expect(bySpin.ok === false && bySpin.error).toMatch(/pool is empty/);
    });

    it("comes back for ever when the manager has not set a limit", async () => {
      const fixture = await seededEvent(2);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const player = fixture.members[0];

      const first = unwrap(await openLot(fixture.eventId, { userId: player }, db));
      expect(unwrap(await moveToReserve(first.id, {}, db))).toMatchObject({
        returnedToPool: true,
        comebacksLeft: null,
      });

      for (let round = 0; round < 3; round += 1) {
        expect(unwrap(await roundAgain(fixture.eventId, player))).toMatchObject({
          returnedToPool: true,
          comebacksLeft: null,
        });
      }
      expect((await getDraftPool(fixture.eventId, db)).reserve.map((e) => e.userId)).toEqual([
        player,
      ]);
    });

    it("does not spend a turn that was undone", async () => {
      const fixture = await seededEvent(2);
      unwrap(await setDraftConfig(fixture.eventId, { reserveRounds: 1 }, db));
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const player = fixture.members[0];

      const first = unwrap(await openLot(fixture.eventId, { userId: player }, db));
      unwrap(await moveToReserve(first.id, {}, db));

      // A lot opened from the reserve wheel and then cancelled: the room never
      // saw a comeback, so it must not count as one.
      const second = unwrap(
        await openLot(fixture.eventId, { kind: "reserve", userId: player }, db)
      );
      unwrap(await voidLot(second.id, {}, db));

      expect(unwrap(await roundAgain(fixture.eventId, player))).toMatchObject({
        returnedToPool: false,
      });
    });
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

  /*
   * UC-16 7a: "Manager undoes the last award."
   *
   * The last one — which is a fact about when lots *settled*, not about when
   * they opened, and not about which row the database felt like returning.
   */
  describe("which lot the one-button undo lands on (UC-16 7a)", () => {
    it("takes the most recent award when two lots opened in the same instant", async () => {
      const fixture = await seededEvent(4);
      const { a } = await twoTeams(fixture);
      unwrap(await setDraftPool(fixture.eventId, {}, db));

      // `openedAt` comes from a JavaScript `Date`, so it is only good to the
      // millisecond — and the old ordering broke the tie on `id`, which is a
      // random uuid. Pinning both lots to one instant makes that coin toss
      // deterministic enough to assert on.
      const at = new Date("2026-01-01T10:00:00.000Z");
      const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2], now: at }, db));
      unwrap(await placeBid(first.id, a, 100, { now: at }, db));
      unwrap(await awardLot(first.id, a, { now: at }, db));

      const second = unwrap(
        await openLot(fixture.eventId, { userId: fixture.members[3], now: at }, db)
      );
      unwrap(await placeBid(second.id, a, 250, { now: at }, db));
      unwrap(await awardLot(second.id, a, { now: new Date(at.getTime() + 1) }, db));

      const undone = unwrap(await voidLastLot(fixture.eventId, {}, db));
      expect(undone.lot.id).toBe(second.id);
      expect(undone.refunded).toBe(250);
      expect(await balanceOf(fixture.eventId, a)).toBe(900);
    });

    it("prefers the award when an award and a discard settled together", async () => {
      const fixture = await seededEvent(4);
      const { a } = await twoTeams(fixture);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      const at = new Date("2026-02-01T10:00:00.000Z");

      const sold = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2], now: at }, db));
      unwrap(await placeBid(sold.id, a, 70, { now: at }, db));
      unwrap(await awardLot(sold.id, a, { now: at }, db));

      const binned = unwrap(
        await openLot(fixture.eventId, { userId: fixture.members[3], now: at }, db)
      );
      unwrap(await discardLot(binned.id, { now: at }, db));

      // 7a is about undoing an award; a discard is the cheaper mistake to
      // leave standing, and undoing it by hand costs one click.
      expect(unwrap(await voidLastLot(fixture.eventId, {}, db)).lot.id).toBe(sold.id);
    });

    it("cancels the open lot when there is one, and pays nothing back", async () => {
      const fixture = await seededEvent(4);
      const { a } = await twoTeams(fixture);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      await buy(fixture.eventId, fixture.members[2], a, 300);
      const open = unwrap(await openLot(fixture.eventId, { userId: fixture.members[3] }, db));

      const undone = unwrap(await voidLastLot(fixture.eventId, {}, db));
      expect(undone.lot.id).toBe(open.id);
      expect(undone.refunded).toBeNull();
      expect(await balanceOf(fixture.eventId, a)).toBe(700);
    });

    it("does not reverse the award before last when one lands mid-undo", async () => {
      /*
       * The race, sequenced rather than run.
       *
       * The old `voidLastLot` read "the last lot" on the default handle and
       * *then* called `voidLot`, which opened its own transaction and took the
       * event's row lock — so the choice was made outside the lock that was
       * supposed to protect it. A second manager awarding a lot in that gap
       * left the undo pointed at the award before last: the money went back to
       * the wrong team and the newest award stayed standing.
       *
       * `committingAfter` pins that interleave exactly. It makes the first
       * transaction this call opens wait until a second award has committed,
       * so everything the undo could have read beforehand is stale. With the
       * target chosen inside the transaction there is nothing stale to read.
       */
      const fixture = await seededEvent(5);
      const { a, b } = await twoTeams(fixture);
      unwrap(await setDraftPool(fixture.eventId, {}, db));
      await buy(fixture.eventId, fixture.members[2], a, 100);

      // The lot the second manager opens and settles has to be one the stale
      // read cannot have seen at all — a lot that was already open before the
      // undo started is picked either way, so racing that one proves nothing.
      let later = "";
      const undone = unwrap(
        await voidLastLot(
          fixture.eventId,
          {},
          committingAfter(async () => {
            const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[3] }, db));
            later = lot.id;
            unwrap(await placeBid(lot.id, b, 400, {}, db));
            unwrap(await awardLot(lot.id, b, {}, db));
          })
        )
      );

      expect(undone.lot.id).toBe(later);
      expect(undone.refunded).toBe(400);
      // A's older award is untouched, which is the half that went wrong.
      expect(await balanceOf(fixture.eventId, a)).toBe(900);
      expect(await balanceOf(fixture.eventId, b)).toBe(1000);
    });
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
