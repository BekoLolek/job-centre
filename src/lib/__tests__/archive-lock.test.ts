import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  applications,
  draftLots,
  events,
  matchGames,
  matches,
  teamMembers,
  teams as teamsTable,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  clearBid,
  discardLot,
  getDraftHistory,
  getTeams,
  moveToReserve,
  openLot,
  placeBid,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setPoolKind,
  setTeams,
  voidLastLot,
  voidLot,
} from "@/lib/draft";
import {
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  setEventDays,
  setEventQuestions,
  updateEvent,
} from "@/lib/events";
import {
  applySchedule,
  clearMatch,
  formatFor,
  generateMatches,
  matchIdsFor,
  recordGames,
  setMatchSchedule,
  setStages,
  setWinnerOverride,
} from "@/lib/format";

/**
 * **Nothing destructive, ever** — checklist.md's standing rule, enforced.
 *
 * This file is the evidence for it. Every write anywhere in the codebase that
 * can erase a completed event's results, rosters or draft prices gets one test
 * here: the event is marked `complete`, the write is attempted, and two things
 * are asserted — that it was refused with a sentence, and that the data it
 * would have taken is still there afterwards. The second assertion is the one
 * that matters. A refusal that returns `ok: false` after already deleting the
 * rows would pass the first on its own.
 *
 * The rule exists because a draft's prices were lost once already.
 *
 * The last block is the other half of the promise: the lock is a lock and not a
 * trap. Moving the event back to `live` — one legal status change, itself in the
 * audit log — restores every one of these writes.
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

type Fixture = {
  eventId: string;
  members: string[];
  teamIds: string[];
  stageId: string;
  matchIds: Record<string, string>;
  /** The slot of a match with a recorded, played result. */
  playedSlot: string;
};

/**
 * A whole tournament, played: two teams with captains, a lot awarded for a
 * real price, a generated bracket and a recorded result. Then finished.
 *
 * Everything below tries to destroy some part of it.
 */
async function finishedEvent(): Promise<Fixture> {
  counter += 1;
  const event = unwrap(await createEvent({ title: `Locked fixture ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));

  // Four accepted members: two captains, one to be drafted, one spare.
  const members: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const userId = await makeUser(db, { displayName: `Locked ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  const teams = unwrap(
    await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)
  ).teams;
  const teamIds = teams.map((team) => team.id);

  unwrap(
    await setCaptains(
      event.id,
      [
        { teamId: teamIds[0], userId: members[0] },
        { teamId: teamIds[1], userId: members[1] },
      ],
      db
    )
  );

  // A lot, bid on and awarded: this is the price the rule is about.
  unwrap(await setDraftPool(event.id, { userIds: [members[2], members[3]] }, db));
  const lot = unwrap(await openLot(event.id, { userId: members[2] }, db));
  unwrap(await placeBid(lot.id, teamIds[0], 250, {}, db));
  unwrap(await awardLot(lot.id, teamIds[0], {}, db));

  // A bracket, generated and played.
  const stages = unwrap(await setStages(event.id, [{ kind: "single_elim" }], db));
  const stageId = stages[0].id;
  unwrap(await generateMatches(stageId, db));

  const ids = await matchIdsFor(event.id, db);
  const playedSlot = Object.keys(ids)[0];
  const view = await formatFor(event.id, db);
  const match = view?.stages
    .flatMap((stage) => stage.matches)
    .find((row) => row.slot === playedSlot);

  unwrap(
    await recordGames(
      ids[playedSlot],
      (match?.games ?? []).map((_, index) => ({
        index,
        scoreA: 1,
        scoreB: 0,
        played: true,
        map: "Yggsgard",
        referee: "Ref",
      })),
      {},
      db
    )
  );

  await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

  return { eventId: event.id, members, teamIds, stageId, matchIds: ids, playedSlot };
}

/** Everything that must survive whatever was just attempted. */
async function census(fixture: Fixture) {
  const [teamRows, memberRows, lotRows, matchRows, gameRows] = await Promise.all([
    db.select().from(teamsTable).where(eq(teamsTable.eventId, fixture.eventId)),
    db.select().from(teamMembers).where(eq(teamMembers.eventId, fixture.eventId)),
    db.select().from(draftLots).where(eq(draftLots.eventId, fixture.eventId)),
    db.select().from(matches).where(eq(matches.eventId, fixture.eventId)),
    db.select().from(matchGames),
  ]);

  const ourMatchIds = new Set(matchRows.map((row) => row.id));
  const played = gameRows.filter((row) => ourMatchIds.has(row.matchId) && row.played);

  return {
    teams: teamRows.length,
    members: memberRows.length,
    prices: memberRows.map((row) => row.price).sort((a, b) => a - b),
    awarded: lotRows.filter((row) => row.status === "awarded").length,
    lotPrices: lotRows.map((row) => row.price),
    matches: matchRows.length,
    playedGames: played.length,
    scheduled: matchRows.filter((row) => row.scheduledAt !== null).length,
    finished: matchRows.filter((row) => row.finishedAt !== null).length,
  };
}

/** Attempt a write, assert it was refused, and assert nothing moved. */
async function refuses(
  fixture: Fixture,
  attempt: () => Promise<{ ok: boolean; error?: string }>
): Promise<string> {
  const before = await census(fixture);
  const result = await attempt();

  expect(result.ok).toBe(false);
  const error = (result as { error: string }).error;
  expect(error).toMatch(/finished/i);
  expect(error).toMatch(/back to live/i);

  // The assertion that actually matters: a refusal that had already deleted the
  // rows would pass the one above on its own.
  expect(await census(fixture)).toEqual(before);
  return error;
}

describe("a finished event's results", () => {
  it("cannot be re-recorded, unticked or zeroed", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () =>
      recordGames(
        fixture.matchIds[fixture.playedSlot],
        [{ index: 0, scoreA: 0, scoreB: 0, played: false }],
        {},
        db
      )
    );
  });

  it("cannot be cleared back to an unplayed card", async () => {
    const fixture = await finishedEvent();
    // The path that used to be composed in the action file, and therefore
    // reached both writes without ever asking whether the event was finished.
    await refuses(fixture, () => clearMatch(fixture.matchIds[fixture.playedSlot], 3, db));
  });

  it("cannot have its winner overturned, or the override dropped", async () => {
    const fixture = await finishedEvent();
    const matchId = fixture.matchIds[fixture.playedSlot];
    await refuses(fixture, () => setWinnerOverride(matchId, fixture.teamIds[1], db));
    // The clearing path used to have strictly less validation than the setting
    // path — `teamId: null` skipped the membership block entirely.
    await refuses(fixture, () => setWinnerOverride(matchId, null, db));
  });
});

describe("a finished event's bracket", () => {
  it("cannot be regenerated", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => generateMatches(fixture.stageId, db));
  });

  it("cannot have its format changed or a stage removed", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setStages(fixture.eventId, [{ kind: "round_robin" }], db));
    await refuses(fixture, () => setStages(fixture.eventId, [], db));
  });

  it("cannot have its running order rebuilt, or one match moved", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => applySchedule(fixture.eventId, ["2026-09-12T16:00:00Z"], db));
    await refuses(fixture, () =>
      setMatchSchedule(fixture.matchIds[fixture.playedSlot], null, db)
    );
    // `config.format` is where the schedule settings live, so rewriting it
    // changes the block plan the recorded order was derived from.
    await refuses(fixture, () =>
      updateEvent(fixture.eventId, { config: { format: { days: 4 } } }, db)
    );
  });
});

describe("a finished event's teams and rosters", () => {
  it("cannot have a team removed or renamed", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setTeams(fixture.eventId, [{ name: "Only one" }], db));
  });

  it("cannot have its captains changed", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () =>
      setCaptains(fixture.eventId, [{ teamId: fixture.teamIds[0], userId: null }], db)
    );
  });
});

describe("a finished event's draft", () => {
  it("cannot have its pool re-seeded", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setDraftPool(fixture.eventId, {}, db));
    await refuses(fixture, () => setPoolKind(fixture.eventId, fixture.members[3], "reserve", db));
  });

  it("cannot have its rules changed", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setDraftConfig(fixture.eventId, { defaultBalance: 10 }, db));
  });

  it("cannot be run again", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => openLot(fixture.eventId, { userId: fixture.members[3] }, db));
  });

  it("cannot have a lot voided — the price is the record", async () => {
    const fixture = await finishedEvent();
    const [awarded] = (await getDraftHistory(fixture.eventId, db)).filter(
      (lot) => lot.status === "awarded"
    );
    const message = await refuses(fixture, () => voidLot(awarded.id, {}, db));
    expect(message).toContain("erase what was paid");

    // The one-button undo goes through `voidLot`, so it is refused too — and it
    // is the more dangerous of the two, since it picks its own target.
    await refuses(fixture, () => voidLastLot(fixture.eventId, {}, db));
  });

  it("keeps the price on the roster row and on the lot", async () => {
    const fixture = await finishedEvent();
    const teams = await getTeams(fixture.eventId, db);
    const bought = teams
      .flatMap((team) => team.members)
      .find((member) => !member.isCaptain);
    expect(bought?.price).toBe(250);
  });
});

describe("a finished event's scaffolding", () => {
  it("cannot have its days rewritten, which would take availability with them", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setEventDays(fixture.eventId, [], db));
  });

  it("cannot have its application form rewritten, which would scrub answers", async () => {
    const fixture = await finishedEvent();
    await refuses(fixture, () => setEventQuestions(fixture.eventId, [], db));
  });
});

describe("what a finished event may still do", () => {
  it("keeps its title and description editable — a typo is not destructive", async () => {
    const fixture = await finishedEvent();
    const result = await updateEvent(
      fixture.eventId,
      { title: "March Cup (corrected)", description: "Played over one night." },
      db
    );
    expect(result.ok).toBe(true);
  });

  it("still accepts an application decision, which erases nothing", async () => {
    // Deliberately not locked. `setApplicationStatus` is §8.3's override and the
    // one write an admin genuinely may need afterwards — "they never turned up".
    // It touches no result, no roster row and no price, which is the whole of
    // what the standing rule protects.
    const fixture = await finishedEvent();
    const [spare] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(eq(applications.eventId, fixture.eventId), eq(applications.userId, fixture.members[3]))
      );
    const before = await census(fixture);
    const decided = await setApplicationStatus(spare.id, "declined", {}, db);
    expect(decided.ok).toBe(true);
    expect(await census(fixture)).toEqual(before);
  });
});

describe("the way out", () => {
  it("is one legal status change, and it restores every refused write", async () => {
    const fixture = await finishedEvent();

    // Refused while finished…
    expect((await generateMatches(fixture.stageId, db)).ok).toBe(false);
    expect((await setDraftConfig(fixture.eventId, { defaultBalance: 10 }, db)).ok).toBe(false);
    expect((await setEventDays(fixture.eventId, [], db)).ok).toBe(false);

    // …and allowed again the moment the admin says it is not over. That is the
    // difference between a rule that protects a record and one that traps its
    // owner: the way out is one click, and it is itself audited.
    unwrap(await updateEvent(fixture.eventId, { status: "live" }, db));

    expect((await setDraftConfig(fixture.eventId, { defaultBalance: 10 }, db)).ok).toBe(true);
    expect((await setEventDays(fixture.eventId, [], db)).ok).toBe(true);
    // The bracket is still guarded by `stageHasResults`, which is the *other*
    // rule and has nothing to do with the event's status.
    const regenerated = await generateMatches(fixture.stageId, db);
    expect(regenerated.ok).toBe(false);
    expect((regenerated as { error: string }).error).toContain("already has results");
  });
});

describe("a lot's bids", () => {
  it("cannot be cleared on a finished event", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Open lot ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const captain = await makeUser(db, { displayName: `Captain ${counter}` });
    const player = await makeUser(db, { displayName: `Player ${counter}` });
    for (const userId of [captain, player]) {
      unwrap(await applyToEvent(event.id, userId, {}, db));
    }

    const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;
    unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));
    unwrap(await setDraftPool(event.id, { userIds: [player] }, db));

    const lot = unwrap(await openLot(event.id, { userId: player }, db));
    unwrap(await placeBid(lot.id, teams[0].id, 40, {}, db));

    // Marking an event finished mid-lot is odd but possible, and a bid is
    // somebody's word — so the lot operations refuse rather than tidy up.
    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

    for (const attempt of [
      () => clearBid(lot.id, teams[0].id, db),
      () => placeBid(lot.id, teams[0].id, 50, {}, db),
      () => awardLot(lot.id, teams[0].id, {}, db),
      () => discardLot(lot.id, {}, db),
      () => moveToReserve(lot.id, {}, db),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/finished/i);
    }

    // The bid is untouched.
    const [still] = await db.select().from(draftLots).where(eq(draftLots.id, lot.id));
    expect(still.status).toBe("open");
  });
});

describe("a team's starting balance", () => {
  it("cannot move once a lot has been awarded, even on a live event", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Balance ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const captain = await makeUser(db, { displayName: `Cap ${counter}` });
    const player = await makeUser(db, { displayName: `Bought ${counter}` });
    for (const userId of [captain, player]) {
      unwrap(await applyToEvent(event.id, userId, {}, db));
    }

    unwrap(await setDraftConfig(event.id, { balanceMode: "per_team", defaultBalance: 1000 }, db));
    const teams = unwrap(
      await setTeams(
        event.id,
        [
          { name: "Red", balanceStart: 1000 },
          { name: "Blue", balanceStart: 1000 },
        ],
        db
      )
    ).teams;
    unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));
    unwrap(await setDraftPool(event.id, { userIds: [player] }, db));

    const lot = unwrap(await openLot(event.id, { userId: player }, db));
    unwrap(await placeBid(lot.id, teams[0].id, 300, {}, db));
    unwrap(await awardLot(lot.id, teams[0].id, {}, db));

    const before = (await getTeams(event.id, db)).map((team) => team.balance);

    // Every remaining balance on the site is `balanceStart` minus the awarded
    // lots — there is deliberately no `balance_left` column — so moving the
    // starting figure now silently rewrites what that 300 appears to have cost.
    const moved = await setTeams(
      event.id,
      teams.map((team) => ({
        id: team.id,
        name: team.name,
        seed: team.seed,
        balanceStart: 5000,
      })),
      db
    );

    expect(moved.ok).toBe(false);
    expect((moved as { error: string }).error).toContain("starting balance cannot change");
    expect((await getTeams(event.id, db)).map((team) => team.balance)).toEqual(before);
  });
});
