import { and, eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
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
  schema,
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
  placeOnRoster,
  removeFromRoster,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setPoolKind,
  setTeamCount,
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
 *
 * ## And a second list, for *when* the status is read
 *
 * `WRITES` is the list of writes the lock covers — the question it asks of each
 * one is *whether* it refuses. `LOCK_FIRST`, at the bottom of the file, asks the
 * narrower question of **where** it reads the status it refuses on: before the
 * event's row lock is a snapshot from before this transaction queued for it, so
 * a completion committing in that gap is invisible and the write lands anyway.
 *
 * Every row of `LOCK_FIRST` is a row of `WRITES`, and it is the shorter list
 * because it is the one Task 36 went through: the writes whose status read it
 * moved under the lock, plus `setTeams` and `setCaptains`, which Task 18 had
 * already moved and which are here so they stay moved. `recordGames`,
 * `setWinnerOverride` and `setMatchSchedule` carry the same assertion in
 * `format-db.test.ts`, next to the engine they belong to — `recordGames` under
 * "reads the event with its row lock, and reads it first", the other two under
 * "takes every deciding read after the event lock" and "takes the deciding read
 * after the event lock". This sentence was untrue for `recordGames` until it
 * was: no such test existed anywhere, and `lockEvent` → `readEvent` in
 * `recordGames` left all 3409 tests green. The rest of `WRITES`
 * is not covered by it — most already lock first, `updateEvent` and
 * `publishEvent` guard their status move with a compare-and-set on
 * `events.status` instead, and neither claim is asserted here. Keep both lists
 * honest: a row added to `WRITES` is not automatically a row here.
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
  const fixture = await playedEvent(midLot);
  await db.update(events).set({ status: "complete" }).where(eq(events.id, fixture.eventId));
  return fixture;
}

/**
 * The same tournament, left **running**.
 *
 * {@link finishedEvent} is this plus the one `update` that closes the record,
 * and the tests at the bottom of this file need the two apart: they are about a
 * write that starts on a live event and has the completion land underneath it,
 * so the completion has to be theirs to place.
 */
async function playedEvent(midLot = false): Promise<Fixture> {
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
  /*
   * The minimum number of maps, not every row in the series: a knockout series
   * stops when it is won, so a Bo3 recorded as three 1-0 games claims a third
   * map nobody could have played and `recordGames` refuses it (UC-19 5a).
   */
  unwrap(
    await recordGames(
      playedMatch.id,
      Array.from({ length: Math.floor((card?.bestOf ?? 1) / 2) + 1 }, (_unused, index) => ({
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

/** Every table that holds something *belonging to* an event, whole. */
const BELONGINGS = [
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
];

/**
 * Those tables and the `events` row itself, whole. The tests in this file run
 * one after another, so any difference is the write just tried.
 */
async function census() {
  return Promise.all([events, ...BELONGINGS].map((table) => db.select().from(table)));
}

/**
 * The same census with `events` left out, for the sequenced tests at the bottom
 * of this file: the completion they place is itself an `events` write, so the
 * event row is asserted on separately and this is everything else.
 */
async function belongings() {
  return Promise.all(BELONGINGS.map((table) => db.select().from(table)));
}

type Write = [name: string, midLot: boolean, attempt: (f: Fixture) => Promise<{ ok: boolean }>];

/** The event-owned writes that simply work again once the event is reopened. */
const WRITES: Write[] = [
  /* --- the event's own setup (updateEvent, UC-09 6b) --------------- */
  ["updateEvent: title", false, (f) => updateEvent(f.eventId, { title: "Corrected" }, db)],
  ["updateEvent: description", false, (f) => updateEvent(f.eventId, { description: "New" }, db)],
  [
    // The event's own dates are its days' now (R-24), so `setEventDays` below
    // is the write that moves them; the sign-up window is the date still kept
    // on the event row.
    "updateEvent: the sign-up window",
    false,
    (f) => updateEvent(f.eventId, { signupClosesAt: new Date("2100-01-01T12:00:00Z") }, db),
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
  ["setConfirmation", false, (f) => setConfirmation(f.applicationId, "out", {}, db)],
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
  // The count this fixture already has, for the `setDraftConfig` reason below:
  // two teams, one of which has won a lot, so *lowering* it would be refused
  // by the standing rule rather than by the archive lock, and this table is
  // about the archive lock.
  ["setTeamCount", false, (f) => setTeamCount(f.eventId, 2, db)],
  /*
   * These two ask for no change at all, which is deliberate.
   *
   * This fixture has awarded a lot, and UC-16 1a and E6a fix a draft's rules
   * and its pools from the moment the first lot opens — a rule that survives a
   * reopen, because reopening an event does not un-open the lot the room
   * watched. So a *changing* call is refused after the reopen for a reason that
   * has nothing to do with the archive lock, and this table is about the
   * archive lock.
   *
   * `lockRefusal` is asked before either of those checks in both functions, so
   * an identical re-save still proves what the row is here to prove: refused
   * with `REFUSAL` while the event is finished, through once it is live again.
   */
  ["setDraftConfig", false, (f) => setDraftConfig(f.eventId, {}, db)],
  ["setDraftPool", false, (f) => setDraftPool(f.eventId, { userIds: [f.members[3]] }, db)],
  ["setPoolKind", false, (f) => setPoolKind(f.eventId, f.members[3], "main", db)],
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
    /*
     * The two hand-placement writes (UC-15 5) are here rather than in `WRITES`
     * for the same reason `applyToEvent` is: they get past the lock to a rule
     * of their own. This fixture has awarded a lot, and UC-15 5a hands rosters
     * to the draft from the first lot onwards — a rule a reopen does not undo,
     * because reopening an event does not un-open the lot the room watched. So
     * they cannot be expected to succeed after the reopen; what matters here is
     * that `lockRefusal` is asked first, so a finished event answers with
     * `REFUSAL` rather than with the draft's sentence. The reopen half is
     * asserted below.
     */
    ["placeOnRoster", false, (f) => placeOnRoster(f.eventId, f.members[4], f.teamIds[1], db)],
    [
      "removeFromRoster",
      false,
      (f) => removeFromRoster(f.eventId, f.members[2], f.teamIds[0], db),
    ],
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

  it.each([
    [
      "placeOnRoster",
      (f: Fixture) => placeOnRoster(f.eventId, f.members[4], f.teamIds[1], db),
    ],
    [
      "removeFromRoster",
      (f: Fixture) => removeFromRoster(f.eventId, f.members[2], f.teamIds[0], db),
    ],
  ])("%s gets past the lock to the draft's own refusal", async (_, attempt) => {
    // A reopened event whose draft has already run still refuses a hand
    // placement — but with the draft's sentence, not the archive's, which is
    // what proves the lock was the thing that moved.
    //
    // Not "UC-15 5a", which this used to say: that flow is the *manager*
    // skipping step 5 on a draft event, not a server refusal. The rule here is
    // `rosterGuard`'s, and its docblock gives the reasoning and the way back
    // out (void the lots — R-67 / UC-16 7a).
    const fixture = await finishedEvent();
    await reopen(fixture);

    const result = await attempt(fixture);

    expect(result).toEqual({
      ok: false,
      error:
        "The draft has started, so rosters are filled in the draft room. Void the lots first if a roster has to be changed by hand.",
    });
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

/* ------------------------------------------------------------------ */
/* ...and the lock the refusal is read under (Task 36)                */
/* ------------------------------------------------------------------ */

/**
 * The rule the whole module follows: **`lockEvent` first, then every read that
 * decides, then the write.** A projection naming the lock may be read before
 * it, and nothing else may.
 *
 * The table above proves that a write on an event which is *already* finished
 * is refused. These writes are the ones where it is finished a moment later -
 * the manager presses Save on a live event, an admin marks it complete, and the
 * two land in the same instant. A status read before the lock is answered from
 * a snapshot taken before this transaction queued for it, so the completion
 * commits in the gap and the write goes through anyway: the refusal was asked
 * about an event that is no longer in that state.
 *
 * Each row is attempted twice below, once per half of the rule:
 *
 *  - against a running event, asserting on the **statements** that the first
 *    read of `events` is the one carrying `for update`. That is the only way to
 *    test lock ordering here without a race: PGlite is a single connection and
 *    serialises everything behind one mutex, so a plain read and a locking read
 *    issued at the same point in the same transaction *behave* identically, and
 *    a behavioural test of the two would pass either way. `format-db.test.ts`
 *    asserts statement order for the same class of bug and says so;
 *  - sequenced, with the completion placed exactly in the window - committed
 *    while the write queues for the lock - asserting that it is refused and
 *    that nothing of the event's was written.
 */
type LockFirst = [
  name: string,
  midLot: boolean,
  attempt: (fixture: Fixture, on: Database) => Promise<{ ok: boolean }>,
];

const LOCK_FIRST: LockFirst[] = [
  [
    "setEventDays",
    false,
    (f, on) => setEventDays(f.eventId, [{ id: f.dayId, label: "Night" }], on),
  ],
  ["setEventQuestions", false, (f, on) => setEventQuestions(f.eventId, [], on)],
  [
    // Closed by Task 18 rather than by Task 36, and here so it stays closed.
    "setTeams",
    false,
    (f, on) =>
      setTeams(
        f.eventId,
        [
          { id: f.teamIds[0], name: "Crimson" },
          { id: f.teamIds[1], name: "Blue" },
        ],
        on
      ),
  ],
  [
    // Task 18 as well, and here for the same reason.
    "setCaptains",
    false,
    (f, on) => setCaptains(f.eventId, [{ teamId: f.teamIds[1], userId: f.members[4] }], on),
  ],
  ["setDraftConfig", false, (f, on) => setDraftConfig(f.eventId, {}, on)],
  ["setDraftPool", false, (f, on) => setDraftPool(f.eventId, { userIds: [f.members[3]] }, on)],
  ["setPoolKind", false, (f, on) => setPoolKind(f.eventId, f.members[3], "main", on)],
  ["clearBid", true, (f, on) => clearBid(f.openLotId ?? "", f.teamIds[1], on)],
  ["clearMatch", false, (f, on) => clearMatch(f.matchId, 3, on)],
];

/**
 * This file's database again, over the same PGlite client, with every statement
 * it runs pushed onto `log` in the order it was issued.
 *
 * drizzle's own `logger` hook rather than a proxy over the query builders: the
 * hook fires from the prepared query, so it sees statements issued inside a
 * transaction too. `format-db.test.ts` builds the same handle for the same
 * purpose, and its docblock carries the rest of the reasoning.
 */
function logging(log: string[]): Database {
  return drizzlePglite(harness.client, {
    schema,
    logger: { logQuery: (query) => log.push(query) },
  });
}

/** The first statement this write ran against `events`, whatever it was for. */
function firstEventRead(log: string[]): string {
  const query = log.find((entry) => /from "events"/.test(entry));
  if (query === undefined) {
    throw new Error("This write never read the event at all, so it cannot be refusing on it.");
  }
  return query;
}

/**
 * This file's database, except that the transaction it opens is not one, and
 * the event is marked **complete** either just before the statement matching
 * `at.sql` is issued, or just after it has run.
 *
 * Sequenced rather than raced: the window it pins is one statement wide, and a
 * test that had to *win* a race to see it would be a test that passes by luck
 * on the days it did. `insertingAfter` in `hosting.test.ts` and
 * `committingAfter` in `format-db.test.ts` are the same device aimed at
 * different statements; this one is aimed by a pattern, because the statement
 * that matters here is `select ... for update` and the whole point is that a
 * version of the code without it never issues one at all.
 *
 * ## Why the transaction is flattened
 *
 * PGlite is a single connection and serialises everything behind one mutex, so
 * a statement issued while a transaction is open on the same client never runs
 * - it waits for a transaction that is waiting for it. (Measured: both a nested
 * `transaction` and a plain `query` inside an open one hang indefinitely.) So
 * the completion cannot be committed *inside* the write's transaction, and the
 * write under test is handed this handle where it expects a `tx`, which leaves
 * the connection free for the completion to open, write and commit a real
 * transaction of its own in the gap.
 *
 * What that does not exercise is the write's rollback, and it cannot: a
 * flattened transaction has nothing to roll back, and a row lock that was
 * really held would have made the completion *wait* rather than commit. What it
 * does exercise is the thing the lock is there for - that the status the
 * refusal is read from is the one on the row at the moment the lock is taken,
 * and not one from before the wait - so each test asserts outright that nothing
 * was written.
 *
 * ## Why it reports whether it fired
 *
 * Because a pattern that matches nothing is indistinguishable, from the
 * outside, from a write that behaved itself. `at.sql` missing leaves `pending`
 * set, the completion never runs, and the write under test runs against a
 * *live* event and succeeds - which satisfies "it was not left half way" and
 * "it did what it answered" without there having been a completion in the run
 * at all. Changing the pattern in the `clearMatch` test below to one matching
 * no statement was tried, and the test passed. So the handle hands back
 * `fired`, every test using it asserts `fired()`, and a pattern that has
 * drifted off the statement it was aimed at now fails instead of passing
 * vacuously.
 */
function completing(
  eventId: string,
  at: { sql: RegExp; when: "before" | "after" }
): { db: Database; fired: () => boolean } {
  let fired = false;
  let pending: (() => Promise<unknown>) | null = async () => {
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));
  };

  const hook = (builder: object): object =>
    new Proxy(builder, {
      get(target, property) {
        // `target` as the receiver rather than the proxy: drizzle's builders
        // read their own fields while they build, and handing them a proxy for
        // `this` is how a getter over a private field comes to throw.
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;

        // Every other builder method is passed through and its result hooked,
        // so the pattern below is matched against the finished statement.
        if (property !== "then") {
          return (...args: unknown[]) => {
            const next = method.apply(target, args);
            return typeof next === "object" && next !== null ? hook(next) : next;
          };
        }

        return (...handlers: unknown[]) => {
          const complete = pending;
          const sql = (target as { toSQL?: () => { sql: string } }).toSQL?.().sql ?? "";
          if (complete === null || !at.sql.test(sql)) return method.apply(target, handlers);
          pending = null;

          // The flag is set after the completion has actually committed, not
          // when the pattern matched, so `fired()` means what it says.
          const run = async (): Promise<void> => {
            await complete();
            fired = true;
          };

          const settle = (value: unknown): unknown => {
            const onFulfilled = handlers[0];
            return typeof onFulfilled === "function"
              ? (onFulfilled as (of: unknown) => unknown)(value)
              : value;
          };
          const reject = (error: unknown): unknown => {
            const onRejected = handlers[1];
            if (typeof onRejected !== "function") throw error;
            return (onRejected as (of: unknown) => unknown)(error);
          };
          const statement = () => method.call(target) as Promise<unknown>;

          return at.when === "before"
            ? run().then(statement).then(settle, reject)
            : statement()
                .then(async (value) => {
                  await run();
                  return value;
                })
                .then(settle, reject);
        };
      },
    });

  const BUILDERS = ["select", "update", "insert", "delete"];
  const flattened = new Proxy(db, {
    get(target, property, receiver) {
      if (pending === null || !BUILDERS.includes(property as string)) {
        return Reflect.get(target, property, receiver);
      }
      const builder = Reflect.get(target, property, target) as (...args: unknown[]) => object;
      return (...args: unknown[]) => hook(builder.apply(target, args));
    },
  });

  return {
    db: new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (run: Parameters<Database["transaction"]>[0]) => run(flattened as never);
      },
    }),
    fired: () => fired,
  };
}

/**
 * The completion, committed while the write queues for the event's row lock.
 *
 * The pattern names the table as well as the lock. `/for update/i` alone
 * matches the *first* locking read the write issues, whatever it is on, and
 * that is only the event's by coincidence of today's code: `clearBid` is one
 * step from locking the lot's row first, and this handle would then place the
 * completion on that statement instead and prove nothing about the event's
 * lock. Both halves in one regex rather than two tests of the statement,
 * because `completing` matches a single pattern against each statement, and
 * drizzle emits `for update` after the `from` clause it belongs to.
 */
function completingBeforeTheLock(eventId: string): { db: Database; fired: () => boolean } {
  return completing(eventId, { sql: /from "events"[\s\S]*\bfor update\b/i, when: "before" });
}

describe("the finished-event refusal is read off the locked row (R-39 / UC-09 6b)", () => {
  it.each(LOCK_FIRST)(
    "%s reads the event with its row lock, and reads it first",
    async (_, midLot, attempt) => {
      const fixture = await playedEvent(midLot);

      const log: string[] = [];
      expect(await attempt(fixture, logging(log))).toMatchObject({ ok: true });

      // `for update` on the *first* read of the event, not merely somewhere in
      // the transaction: a write that decides on a plain read and locks
      // afterwards has already decided on a status that may have moved.
      expect(firstEventRead(log)).toMatch(/for update/i);
    }
  );

  it("clearBid decides the lot's own status under that lock too", async () => {
    /*
     * The other read `clearBid` decides on. An award committing while this
     * transaction queued for the lock settles the lot, and clearing a bid off a
     * settled lot rewrites what the winner paid - so "is this lot still open"
     * has to be asked after the lock, exactly as `clearBids` asks it. The read
     * before the lock asks for `id` and `event_id` and nothing else, because
     * the lock has to be named before it can be taken.
     */
    const fixture = await playedEvent(true);

    const log: string[] = [];
    expect(
      await clearBid(fixture.openLotId ?? "", fixture.teamIds[1], logging(log))
    ).toMatchObject({ ok: true });

    const lock = log.findIndex((query) => /for update/i.test(query));
    expect(lock).toBeGreaterThanOrEqual(0);

    const before = log.slice(0, lock).filter((query) => /from "draft_lots"/.test(query));
    expect(before).toHaveLength(1);
    expect(before[0]).not.toMatch(/"status"/);
    expect(
      log
        .slice(lock + 1)
        .some((query) => /from "draft_lots"/.test(query) && /"status"/.test(query))
    ).toBe(true);
  });
});

describe("a completion landing while the write queues for the lock (R-39 / UC-09 6b)", () => {
  it.each(LOCK_FIRST)("%s is refused and writes nothing", async (_, midLot, attempt) => {
    const fixture = await playedEvent(midLot);
    const [was] = await db.select().from(events).where(eq(events.id, fixture.eventId));
    const before = await belongings();

    const completion = completingBeforeTheLock(fixture.eventId);
    const result = await attempt(fixture, completion.db);

    // There was a completion in this run at all. These rows are safe without it
    // only by accident - a completion that never fires leaves the write running
    // against a live event, where it succeeds and the assertion below fails -
    // but "safe by accident" is how the sibling test at the bottom of this file
    // came to pass vacuously, and the assertion costs a line.
    expect(completion.fired(), "the completion never fired, so this run proves nothing").toBe(
      true
    );
    expect(result).toEqual({ ok: false, error: REFUSAL });
    expect(await belongings()).toEqual(before);
    // The completion is the only thing that moved on the event row, so the
    // refused write did not quietly edit it on the way out either.
    const [now] = await db.select().from(events).where(eq(events.id, fixture.eventId));
    expect(now).toEqual({ ...was, status: "complete" });
  });
});

describe("clearMatch clears everything or nothing (UC-09 6b, UC-19 3a)", () => {
  /** The series and the override, as one comparable shape. */
  async function stateOf(matchId: string) {
    const [row] = await db.select().from(matches).where(eq(matches.id, matchId));
    const games = await db.select().from(matchGames).where(eq(matchGames.matchId, matchId));
    return {
      override: row.winnerOverrideId,
      finishedAt: row.finishedAt,
      durationMin: row.durationMin,
      games: games
        .sort((x, y) => x.index - y.index)
        .map((game) => [game.played, game.scoreA, game.scoreB, game.map] as const),
    };
  }

  type SeriesState = Awaited<ReturnType<typeof stateOf>>;

  function describeState(now: SeriesState, was: SeriesState): "cleared" | "untouched" | "half" {
    const wiped =
      now.override === null &&
      now.finishedAt === null &&
      now.durationMin === null &&
      now.games.every(([played, a, b, map]) => !played && a === 0 && b === 0 && map === "");
    if (wiped) return "cleared";
    return JSON.stringify(now) === JSON.stringify(was) ? "untouched" : "half";
  }

  /** A played series with an override standing on it, on a running event. */
  async function overridden(): Promise<Fixture> {
    const fixture = await playedEvent();
    const [row] = await db.select().from(matches).where(eq(matches.id, fixture.matchId));
    const view = await formatFor(fixture.eventId, db);
    const card = view?.stages
      .flatMap((stage) => stage.matches)
      .find((match) => match.slot === row.slot);
    unwrap(await setWinnerOverride(fixture.matchId, card?.teamBId ?? null, db));
    return fixture;
  }

  it("never drops the override and then refuses the games, when the event completes between them", async () => {
    /*
     * The window Task 36 was written for, and the reason `clearMatch` is one
     * transaction rather than two. It used to drop the override in one and
     * clear the games in another; a completion committing in the gap left the
     * override gone and committed while the games refused, so the single most
     * destructive operation on the site was also the one that could stop half
     * way through and report that it had done nothing.
     *
     * The completion is placed on exactly that statement - immediately after
     * the `update ... winner_override_id`, which is the first write either half
     * makes. Whatever `clearMatch` answers, the series and the override have to
     * agree with it: `half` is the state that must not exist.
     *
     * And `fired()` first, because this is the sole evidence for Task 36's
     * second acceptance criterion and both assertions below are satisfied by a
     * run with no completion in it. Proved: changing the pattern to one
     * matching no statement left the completion unfired, `clearMatch` cleared
     * the series on a live event and answered `ok`, `state` was `cleared`, and
     * the test passed while testing nothing.
     */
    const fixture = await overridden();
    const was = await stateOf(fixture.matchId);
    expect(was.override).not.toBeNull();

    const completion = completing(fixture.eventId, {
      sql: /update "matches" set "winner_override_id"/,
      when: "after",
    });
    const result = await clearMatch(fixture.matchId, 3, completion.db);

    expect(
      completion.fired(),
      "the completion never fired, so this run never exercised the window"
    ).toBe(true);
    const state = describeState(await stateOf(fixture.matchId), was);
    expect(state).not.toBe("half");
    expect(state).toBe(result.ok ? "cleared" : "untouched");
  });

  it("leaves the override alone when the games it is asked to clear are not there", async () => {
    /*
     * The same promise with no completion in it, and the one that proves the
     * rollback rather than the lock. A `gameCount` past the end of the series
     * is a refusal `recordGamesIn` makes *after* the override has been dropped,
     * so it is thrown and the transaction is rolled back - the one place in
     * `format.ts` that rolls one back, because a refusal merely returned from a
     * transaction callback commits what came before it.
     */
    const fixture = await overridden();
    const was = await stateOf(fixture.matchId);

    const result = await clearMatch(fixture.matchId, 9, db);

    expect(result).toMatchObject({ ok: false });
    expect(describeState(await stateOf(fixture.matchId), was)).toBe("untouched");
  });
});
