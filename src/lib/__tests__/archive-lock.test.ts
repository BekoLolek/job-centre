import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  applications,
  availability,
  confirmations,
  draftBids,
  draftConfigs,
  draftLots,
  draftPoolEntries,
  eventDays,
  eventQuestions,
  events,
  matchGames,
  matches,
  stages,
  teamMembers,
  teams as teamsTable,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  clearBid,
  discardLot,
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
  setApplicationNote,
  setApplicationStatus,
  setAvailability,
  setConfirmation,
  setEventDays,
  setEventQuestions,
  updateEvent,
  withdrawApplication,
} from "@/lib/events";
import {
  applySchedule,
  clearMatch,
  formatFor,
  generateMatches,
  recordGames,
  reflipMatch,
  setMatchSchedule,
  setStages,
  setWinnerOverride,
} from "@/lib/format";

/**
 * **A finished event is a record** — R-39, UC-09 6b, enforced.
 *
 * While an event is `complete`, nothing belonging to it may change: its setup,
 * its applications, its teams, its draft, its stages and its results (the Event
 * domain rule). This file is the evidence. Every event-owned write on the site
 * has one row in the table below, and each row is attempted twice:
 *
 *  - on a finished event, where it must be refused with the one sentence
 *    UC-09 6b gives, *and* leave every event-owned table exactly as it was. The
 *    second assertion is the one that matters: a refusal that returns
 *    `ok: false` after already deleting the rows would pass the first alone;
 *  - on the same event reopened (UC-09 6a), where it must go through.
 *
 * One write gets past the lock after reopening only to meet a rule of its own:
 * a reopened event is live, and a live event takes no new applications. That
 * one is asserted separately, with the rule it meets, so the table never needs
 * an `if`.
 */

const REFUSAL = "This event is finished - reopen it to change it";

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
  /** Captains, the drafted player, the pooled player, and a spare applicant. */
  members: string[];
  /** Somebody who has not applied. */
  outsider: string;
  teamIds: string[];
  stageId: string;
  matchId: string;
  /** A second stage, generated and never played. */
  unplayedStageId: string;
  unplayedMatchId: string;
  dayId: string;
  /** The spare applicant's application: decisions, notes, attendance. */
  applicationId: string;
  awardedLotId: string;
  /** Only on the mid-lot fixture: a lot with a bid on it, still open. */
  openLotId: string | null;
};

/**
 * A whole tournament, played: two teams with captains, a lot awarded for a
 * real price, a generated bracket and a recorded result. With `midLot`, a
 * second lot is left open with a bid on it. Then finished.
 */
async function finishedEvent(midLot = false): Promise<Fixture> {
  counter += 1;
  const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Locked fixture ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const userId = await makeUser(db, { displayName: `Locked ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }
  const outsider = await makeUser(db, { displayName: `Outsider ${counter}` });

  const teamIds = unwrap(
    await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)
  ).teams.map((team) => team.id);
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

  unwrap(await setDraftPool(event.id, { userIds: [members[2], members[3]] }, db));
  const awarded = unwrap(await openLot(event.id, { userId: members[2] }, db));
  unwrap(await placeBid(awarded.id, teamIds[0], 250, {}, db));
  unwrap(await awardLot(awarded.id, teamIds[0], {}, db));

  const [stage, unplayed] = unwrap(
    await setStages(event.id, [{ kind: "single_elim" }, { kind: "single_elim" }], db)
  );
  unwrap(await generateMatches(stage.id, db));
  unwrap(await generateMatches(unplayed.id, db));
  const [unplayedMatch] = await db.select().from(matches).where(eq(matches.stageId, unplayed.id));
  const [playedMatch] = await db.select().from(matches).where(eq(matches.stageId, stage.id));
  const view = await formatFor(event.id, db);
  const card = view?.stages
    .find((row) => row.id === stage.id)
    ?.matches.find((row) => row.slot === playedMatch.slot);
  unwrap(
    await recordGames(
      playedMatch.id,
      (card?.games ?? []).map((_, index) => ({
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

  const openLotId = midLot ? await openLotWithBid(event.id, members[3], teamIds[1]) : null;

  const [day] = await db.select().from(eventDays).where(eq(eventDays.eventId, event.id));
  const [spare] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.eventId, event.id), eq(applications.userId, members[4])));

  await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

  return {
    eventId: event.id,
    members,
    outsider,
    teamIds,
    stageId: stage.id,
    matchId: playedMatch.id,
    unplayedStageId: unplayed.id,
    unplayedMatchId: unplayedMatch.id,
    dayId: day.id,
    applicationId: spare.id,
    awardedLotId: awarded.id,
    openLotId,
  };
}

async function openLotWithBid(eventId: string, userId: string, teamId: string): Promise<string> {
  const lot = unwrap(await openLot(eventId, { userId }, db));
  unwrap(await placeBid(lot.id, teamId, 40, {}, db));
  return lot.id;
}

/**
 * Every table that holds something belonging to an event, whole. The tests in
 * this file run one after another, so any difference is the write just tried.
 */
async function census() {
  return Promise.all(
    [
      events,
      eventDays,
      eventQuestions,
      applications,
      availability,
      confirmations,
      teamsTable,
      teamMembers,
      draftConfigs,
      draftPoolEntries,
      draftLots,
      draftBids,
      stages,
      matches,
      matchGames,
    ].map((table) => db.select().from(table))
  );
}

type Write = [name: string, midLot: boolean, attempt: (f: Fixture) => Promise<{ ok: boolean }>];

/** The event-owned writes that simply work again once the event is reopened. */
const WRITES: Write[] = [
  /* --- the event's own setup (updateEvent, UC-09 6b) --------------- */
  ["updateEvent: title", false, (f) => updateEvent(f.eventId, { title: "Corrected" }, db)],
  ["updateEvent: description", false, (f) => updateEvent(f.eventId, { description: "New" }, db)],
  [
    "updateEvent: dates",
    false,
    (f) => updateEvent(f.eventId, { endsAt: new Date("2100-01-03T00:00:00Z") }, db),
  ],
  ["updateEvent: capacity", false, (f) => updateEvent(f.eventId, { capacity: 40 }, db)],
  ["updateEvent: rank rules", false, (f) => updateEvent(f.eventId, { minRankToEnter: null }, db)],
  [
    "updateEvent: config",
    false,
    (f) => updateEvent(f.eventId, { config: { format: { days: 4 } } }, db),
  ],
  [
    "updateEvent: an edit riding along with the reopen",
    false,
    (f) => updateEvent(f.eventId, { status: "live", title: "Sneaked in" }, db),
  ],
  ["setEventDays", false, (f) => setEventDays(f.eventId, [{ id: f.dayId, label: "Night" }], db)],
  ["setEventQuestions", false, (f) => setEventQuestions(f.eventId, [], db)],
  /* --- applications (UC-13 3b, UC-14 4a) ---------------------------- */
  ["withdrawApplication", false, (f) => withdrawApplication(f.eventId, f.members[4], db)],
  [
    "setApplicationStatus",
    false,
    (f) => setApplicationStatus(f.applicationId, "declined", {}, db),
  ],
  ["setApplicationNote", false, (f) => setApplicationNote(f.applicationId, "No show", db)],
  ["setAvailability", false, (f) => setAvailability(f.applicationId, { [f.dayId]: "no" }, db)],
  ["setConfirmation", false, (f) => setConfirmation(f.applicationId, "out", db)],
  /* --- teams and the draft ------------------------------------------ */
  [
    "setTeams",
    false,
    (f) =>
      setTeams(
        f.eventId,
        [
          { id: f.teamIds[0], name: "Crimson" },
          { id: f.teamIds[1], name: "Blue" },
        ],
        db
      ),
  ],
  [
    "setCaptains",
    false,
    (f) => setCaptains(f.eventId, [{ teamId: f.teamIds[1], userId: f.members[4] }], db),
  ],
  ["setDraftConfig", false, (f) => setDraftConfig(f.eventId, { defaultBalance: 10 }, db)],
  ["setDraftPool", false, (f) => setDraftPool(f.eventId, { userIds: [f.members[3]] }, db)],
  ["setPoolKind", false, (f) => setPoolKind(f.eventId, f.members[3], "reserve", db)],
  ["openLot", false, (f) => openLot(f.eventId, { userId: f.members[3] }, db)],
  ["placeBid", true, (f) => placeBid(f.openLotId ?? "", f.teamIds[0], 50, {}, db)],
  ["clearBid", true, (f) => clearBid(f.openLotId ?? "", f.teamIds[1], db)],
  ["awardLot", true, (f) => awardLot(f.openLotId ?? "", f.teamIds[1], {}, db)],
  ["discardLot", true, (f) => discardLot(f.openLotId ?? "", {}, db)],
  ["moveToReserve", true, (f) => moveToReserve(f.openLotId ?? "", {}, db)],
  ["voidLot", false, (f) => voidLot(f.awardedLotId, {}, db)],
  ["voidLastLot", false, (f) => voidLastLot(f.eventId, {}, db)],
  /* --- stages and results ------------------------------------------- */
  [
    "setStages",
    false,
    (f) =>
      setStages(
        f.eventId,
        [
          { id: f.stageId, kind: "single_elim" },
          { id: f.unplayedStageId, kind: "single_elim" },
          { kind: "round_robin" },
        ],
        db
      ),
  ],
  [
    "recordGames",
    false,
    (f) => recordGames(f.matchId, [{ index: 0, scoreA: 2, scoreB: 0, played: true }], {}, db),
  ],
  ["setWinnerOverride", false, (f) => setWinnerOverride(f.matchId, f.teamIds[1], db)],
  ["clearMatch", false, (f) => clearMatch(f.matchId, 3, db)],
  ["setMatchSchedule", false, (f) => setMatchSchedule(f.matchId, null, db)],
  ["generateMatches", false, (f) => generateMatches(f.unplayedStageId, db)],
  ["reflipMatch", false, (f) => reflipMatch(f.unplayedMatchId, null, db)],
  ["applySchedule", false, (f) => applySchedule(f.eventId, ["2100-01-02T16:00:00Z"], db)],
];

async function reopen(fixture: Fixture): Promise<void> {
  unwrap(await updateEvent(fixture.eventId, { from: "complete", status: "live" }, db));
}

describe("a finished event refuses every change (UC-09 6b)", () => {
  it.each<Write>([
    ...WRITES,
    ["applyToEvent", false, (f) => applyToEvent(f.eventId, f.outsider, {}, db)],
  ])("%s is refused and writes nothing", async (_, midLot, attempt) => {
    const fixture = await finishedEvent(midLot);
    const before = await census();

    const result = await attempt(fixture);

    expect(result).toEqual({ ok: false, error: REFUSAL });
    expect(await census()).toEqual(before);
  });
});

describe("a status move out of a finished event other than reopening", () => {
  // Refused by the status flow before the lock is asked, so it keeps the
  // sentence UC-09 3a gives it. Either way, nothing is written.
  it.each([
    ["updateEvent", (f: Fixture) => updateEvent(f.eventId, { status: "draft" }, db)],
    ["publishEvent", (f: Fixture) => publishEvent(f.eventId, db)],
  ])("%s is refused and writes nothing", async (_, attempt) => {
    const fixture = await finishedEvent();
    const before = await census();

    const result = await attempt(fixture);

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/complete/) });
    expect(await census()).toEqual(before);
  });
});

describe("a reopened event takes the same changes again (UC-09 6a)", () => {
  it("allows the reopen itself, the one write a finished event accepts", async () => {
    const fixture = await finishedEvent();

    const result = await updateEvent(fixture.eventId, { from: "complete", status: "live" }, db);

    expect(result).toMatchObject({ ok: true, data: { status: "live" } });
  });

  it.each(WRITES)("%s goes through", async (_, midLot, attempt) => {
    const fixture = await finishedEvent(midLot);
    await reopen(fixture);

    const result = await attempt(fixture);

    expect(result).toMatchObject({ ok: true });
  });

  it("applyToEvent gets past the lock to its own rule", async () => {
    // A reopened event is live, and a live event takes no new applications.
    const fixture = await finishedEvent();
    await reopen(fixture);

    const result = await applyToEvent(fixture.eventId, fixture.outsider, {}, db);

    expect(result).toEqual({ ok: false, error: "This event has already started." });
  });
});

describe("a team's starting balance", () => {
  it("cannot move once a lot has been awarded, even on a live event", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Balance ${counter}` }, db));
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
