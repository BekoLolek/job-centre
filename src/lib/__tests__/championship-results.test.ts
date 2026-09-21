import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  applications,
  championshipPlacements,
  championships,
  events,
  teamMembers,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type ChampionshipStanding,
  type CountingEventInput,
  CHAMPIONSHIP_LOCKED_REFUSAL,
  scoreChampionship,
} from "@/lib/championship-policy";
import {
  addCountingEvent,
  createChampionship,
  getChampionship,
  listCountingEvents,
  setCountingEvent,
  unscoredResults,
} from "@/lib/championships";
import {
  eventParticipants,
  listPlacements,
  scoringInputFor,
  setPlacements,
} from "@/lib/championship-results";

/*
 * UC-33 — record where everyone finished — against a real in-memory Postgres.
 *
 * Everything goes through the write layer rather than the actions, so the rules
 * are tested where they live; who may press the button is
 * `src/app/admin/events/__tests__/`'s.
 *
 * Every scoring assertion is assembled the way the public page will assemble
 * it: the season's rules, the counting events, the *stored* places and the
 * participant list read back fresh. Nothing is asserted against a total,
 * because there is no total — which is the whole reason a correction cannot
 * leave one behind.
 */

let handle: TestDatabase;
let db: Database;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

async function seasonIn(
  status: ChampionshipStatusValue = "published",
  scoring: { pointsTable?: number[]; participationPoints?: number } = {}
): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Result season ${counter}`, ...scoring }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

async function anEvent(
  status: "draft" | "live" | "complete" | "cancelled" = "complete"
): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `result-${counter}`, title: `Result night ${counter}`, status })
    .returning({ id: events.id });
  return row.id;
}

/** An accepted applicant, named so the assertions can read. */
async function accepted(eventId: string, displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
  return userId;
}

/** A team with a roster, as the draft leaves one. */
async function aTeam(
  eventId: string,
  name: string,
  memberIds: string[]
): Promise<string> {
  const [team] = await db
    .insert(teams)
    .values({ eventId, name })
    .returning({ id: teams.id });
  for (const userId of memberIds) {
    await db.insert(teamMembers).values({ teamId: team.id, eventId, userId });
  }
  return team.id;
}

/** A season with one event counting towards it. */
async function counting(
  options: { seasonStatus?: ChampionshipStatusValue; eventStatus?: "draft" | "live" | "complete" } = {}
): Promise<{ seasonId: string; eventId: string }> {
  const seasonId = await seasonIn(options.seasonStatus ?? "published");
  const eventId = await anEvent(options.eventStatus ?? "complete");
  const added = await addCountingEvent(seasonId, eventId, db);
  if (!added.ok) throw new Error(added.error);
  return { seasonId, eventId };
}

/* ------------------------------------------------------------------ */
/* Scoring, assembled from what is stored and nothing else            */
/* ------------------------------------------------------------------ */

async function standings(championshipId: string): Promise<ChampionshipStanding[]> {
  const season = await getChampionship(championshipId, db);
  if (!season) throw new Error("no such season");

  /*
   * `scoringInputFor` and nothing else: the mapping from stored rows to what
   * scoring takes is production code, so a copy of it here would let the two
   * drift while every assertion below kept passing. This is the read Task 42's
   * page makes, over the rows this file has just written.
   */
  const counting = await listCountingEvents(championshipId, db);
  const inputs = (
    await Promise.all(counting.map((row) => scoringInputFor(row.eventId, db)))
  ).filter((input): input is CountingEventInput => input !== null);

  return scoreChampionship(
    {
      pointsTable: season.pointsTable,
      participationPoints: season.participationPoints,
      countBest: season.countBest,
    },
    inputs
  );
}

/** What one member scored across the season. */
function pointsFor(rows: ChampionshipStanding[], userId: string): number {
  return rows.find((row) => row.userId === userId)?.points ?? 0;
}

/** Where one member sits in the season. */
function positionOf(rows: ChampionshipStanding[], userId: string): number | null {
  return rows.find((row) => row.userId === userId)?.position ?? null;
}

/**
 * A handle whose `transaction` runs `between` first — `writingAfter` in
 * `events.test.ts`, for the window between this write's reads and its
 * statements.
 *
 * Sequenced rather than raced: the window it pins is one transaction wide, and
 * a test that had to *win* a race to see it would pass by luck.
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

/* ------------------------------------------------------------------ */
/* UC-33 2: who the system lists                                      */
/* ------------------------------------------------------------------ */

describe("who took part", () => {
  it("lists the teams when the event had them", async () => {
    // UC-33 2a. The place belongs to the team, and scores for everybody on it.
    const eventId = await anEvent();
    const ana = await accepted(eventId, "Ana");
    const ben = await accepted(eventId, "Ben");
    const teamId = await aTeam(eventId, "Rivals Red", [ana, ben]);

    const participants = await eventParticipants(eventId, db);

    expect(participants.teamed).toBe(true);
    expect(participants.rows).toEqual([
      {
        id: teamId,
        name: "Rivals Red",
        members: [
          { userId: ana, name: "Ana" },
          { userId: ben, name: "Ben" },
        ],
      },
    ]);
  });

  it("lists the accepted applicants when it had no teams", async () => {
    // UC-33 2. Nobody else: a waitlisted applicant did not take part.
    const eventId = await anEvent();
    const ana = await accepted(eventId, "Ana solo");
    const queued = await makeUser(db, { displayName: "Queued" });
    await db.insert(applications).values({ eventId, userId: queued, status: "waitlisted" });

    const participants = await eventParticipants(eventId, db);

    expect(participants.teamed).toBe(false);
    expect(participants.rows).toEqual([
      { id: ana, name: "Ana solo", members: [{ userId: ana, name: "Ana solo" }] },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-33 3-4: the order, and what it scores                           */
/* ------------------------------------------------------------------ */

describe("recording the order", () => {
  it("saves it and scores it against the table and the weight", async () => {
    // UC-33 3-4, and UC-32 3: the weight multiplies everything the event pays.
    const { seasonId, eventId } = await counting();
    const first = await accepted(eventId, "First");
    const second = await accepted(eventId, "Second");
    expect((await setCountingEvent(eventId, { weight: 2 }, db)).ok).toBe(true);

    const saved = await setPlacements(
      eventId,
      [
        { id: first, position: 1 },
        { id: second, position: 2 },
      ],
      db
    );

    expect(saved.ok).toBe(true);
    const rows = await standings(seasonId);
    expect(pointsFor(rows, first)).toBe(50); // 25 × 2
    expect(pointsFor(rows, second)).toBe(36); // 18 × 2
    expect(positionOf(rows, first)).toBe(1);
  });

  it("scores a team's place for every member of that team", async () => {
    // UC-33 2a / R-180.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana team");
    const ben = await accepted(eventId, "Ben team");
    const cal = await accepted(eventId, "Cal team");
    const red = await aTeam(eventId, "Red", [ana, ben]);
    const blue = await aTeam(eventId, "Blue", [cal]);

    expect(
      (
        await setPlacements(
          eventId,
          [
            { id: red, position: 1 },
            { id: blue, position: 2 },
          ],
          db
        )
      ).ok
    ).toBe(true);

    const rows = await standings(seasonId);
    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, ben)).toBe(25);
    expect(pointsFor(rows, cal)).toBe(18);
  });

  it("gives two who genuinely tied the same points and leaves the next place empty", async () => {
    // UC-33 3a. 1, 1, 3 — the same shape a season's own standings take.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana tie");
    const ben = await accepted(eventId, "Ben tie");
    const cal = await accepted(eventId, "Cal tie");

    expect(
      (
        await setPlacements(
          eventId,
          [
            { id: ana, position: 1 },
            { id: ben, position: 1 },
            { id: cal, position: 3 },
          ],
          db
        )
      ).ok
    ).toBe(true);

    const rows = await standings(seasonId);
    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, ben)).toBe(25);
    expect(pointsFor(rows, cal)).toBe(15); // 3rd, not 2nd: the 18 is unclaimed.
  });

  it("gives somebody who took part and was not placed the taking-part points", async () => {
    // UC-33 3b. They are in the participant list and in no placement.
    // 1, not more: UC-31 4a refuses a season where taking part beats the last
    // place in the table, which the default table puts at 1.
    const seasonId = await seasonIn("published", { participationPoints: 1 });
    const eventId = await anEvent();
    const added = await addCountingEvent(seasonId, eventId, db);
    expect(added.ok).toBe(true);
    const winner = await accepted(eventId, "Winner");
    const bystander = await accepted(eventId, "Bystander");

    expect((await setPlacements(eventId, [{ id: winner, position: 1 }], db)).ok).toBe(true);

    const rows = await standings(seasonId);
    expect(pointsFor(rows, winner)).toBe(25);
    expect(pointsFor(rows, bystander)).toBe(1);
  });

  it("stores nothing about what the order is worth", async () => {
    // The outcome UC-33 states in so many words. Only places are written.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana stored");

    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);

    const [row] = await db
      .select()
      .from(championshipPlacements)
      .where(eq(championshipPlacements.userId, ana));
    expect(row.position).toBe(1);
    expect(Object.keys(row)).not.toContain("points");
  });
});

/* ------------------------------------------------------------------ */
/* UC-33 4a: correcting it later                                      */
/* ------------------------------------------------------------------ */

describe("correcting the order", () => {
  it("re-scores the season and leaves nothing stale behind", async () => {
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana wrong");
    const ben = await accepted(eventId, "Ben wrong");
    expect(
      (
        await setPlacements(
          eventId,
          [
            { id: ana, position: 1 },
            { id: ben, position: 2 },
          ],
          db
        )
      ).ok
    ).toBe(true);

    // They were the wrong way round.
    const fixed = await setPlacements(
      eventId,
      [
        { id: ben, position: 1 },
        { id: ana, position: 2 },
      ],
      db
    );

    expect(fixed.ok).toBe(true);
    const rows = await standings(seasonId);
    expect(pointsFor(rows, ben)).toBe(25);
    expect(pointsFor(rows, ana)).toBe(18);
    expect(positionOf(rows, ben)).toBe(1);
    // Two people, two rows: the first order is gone rather than added to.
    const stored = await listPlacements(eventId, db);
    expect(stored).toHaveLength(2);
    expect(stored).toEqual([
      { id: ben, position: 1, kind: "member", name: "Ben wrong" },
      { id: ana, position: 2, kind: "member", name: "Ana wrong" },
    ]);
  });

  it("drops somebody the correction leaves out, back to the taking-part points", async () => {
    const seasonId = await seasonIn("published", { participationPoints: 1 });
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    const ana = await accepted(eventId, "Ana dropped");
    const ben = await accepted(eventId, "Ben dropped");
    expect(
      (
        await setPlacements(
          eventId,
          [
            { id: ana, position: 1 },
            { id: ben, position: 2 },
          ],
          db
        )
      ).ok
    ).toBe(true);

    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);

    const rows = await standings(seasonId);
    expect(pointsFor(rows, ben)).toBe(1);
    expect(await listPlacements(eventId, db)).toEqual([
      { id: ana, position: 1, kind: "member", name: "Ana dropped" },
    ]);
  });

  it("clears the order entirely when an empty one is saved", async () => {
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana cleared");
    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);

    expect((await setPlacements(eventId, [], db)).ok).toBe(true);

    expect(await listPlacements(eventId, db)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-33 3c, 3d: what is rejected                                     */
/* ------------------------------------------------------------------ */

describe("an order that cannot be right", () => {
  it("rejects the same player twice and saves nothing", async () => {
    // UC-33 3c, through `duplicateMemberIn`.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana doubled");
    const ben = await accepted(eventId, "Ben doubled");

    const result = await setPlacements(
      eventId,
      [
        { id: ana, position: 1 },
        { id: ben, position: 2 },
        { id: ana, position: 3 },
      ],
      db
    );

    expect(result).toEqual({
      ok: false,
      error: "Ana doubled is in that order twice. Somebody finishes in one place.",
    });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("rejects the same team twice, naming somebody on it", async () => {
    // The team form of UC-33 3c: one place for the team is one place for
    // everybody on it, so twice is everybody twice.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana twice");
    const red = await aTeam(eventId, "Red twice", [ana]);
    await aTeam(eventId, "Blue twice", []);

    const result = await setPlacements(
      eventId,
      [
        { id: red, position: 1 },
        { id: red, position: 2 },
      ],
      db
    );

    expect(result).toEqual({
      ok: false,
      error: "Ana twice is in that order twice. Somebody finishes in one place.",
    });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("rejects a team with nobody on it twice, naming the team", async () => {
    // The one duplicate `duplicateMemberIn` cannot see, because an empty team
    // puts no member in the order at all.
    const { eventId } = await counting();
    const empty = await aTeam(eventId, "Nobody", []);

    const result = await setPlacements(
      eventId,
      [
        { id: empty, position: 1 },
        { id: empty, position: 2 },
      ],
      db
    );

    expect(result).toEqual({
      ok: false,
      error: "Nobody is in that order twice. Somebody finishes in one place.",
    });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("rejects somebody who was not in the event and saves nothing", async () => {
    // UC-33 3d.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana in");
    const stranger = await makeUser(db, { displayName: "Stranger" });

    const result = await setPlacements(
      eventId,
      [
        { id: ana, position: 1 },
        { id: stranger, position: 2 },
      ],
      db
    );

    expect(result).toEqual({
      ok: false,
      error: "One of those places is for somebody who did not take part in this event.",
    });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("rejects a place that is not a whole number of 1 or more", async () => {
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana zero");

    const result = await setPlacements(eventId, [{ id: ana, position: 0 }], db);

    expect(result).toEqual({
      ok: false,
      error: "A finishing place has to be a whole number of 1 or more.",
    });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("refuses an event that counts towards no season", async () => {
    const eventId = await anEvent();
    const ana = await accepted(eventId, "Ana nowhere");

    const result = await setPlacements(eventId, [{ id: ana, position: 1 }], db);

    expect(result).toEqual({
      ok: false,
      error: "This event does not count towards a championship.",
    });
  });
});

/* ------------------------------------------------------------------ */
/* UC-33 1a, 1b: when recording is allowed                            */
/* ------------------------------------------------------------------ */

describe("when a result may be recorded", () => {
  it("refuses while the season is finished, with the reopen message", async () => {
    // UC-33 1a / UC-35 2b.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana closed");
    await db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.id, seasonId));

    const result = await setPlacements(eventId, [{ id: ana, position: 1 }], db);

    expect(result).toEqual({ ok: false, error: CHAMPIONSHIP_LOCKED_REFUSAL });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("takes no order from a season closed between the read and the write", async () => {
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana raced");
    const close = () =>
      db.update(championships).set({ status: "closed" }).where(eq(championships.id, seasonId));

    const result = await setPlacements(
      eventId,
      [{ id: ana, position: 1 }],
      committingAfter(close)
    );

    expect(result).toEqual({ ok: false, error: CHAMPIONSHIP_LOCKED_REFUSAL });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("allows it on a complete event, because the result belongs to the season", async () => {
    // UC-33 1b. The event's own record stays locked (UC-09 6b); this is not
    // part of it.
    const { seasonId, eventId } = await counting({ eventStatus: "complete" });
    const ana = await accepted(eventId, "Ana finished");

    const result = await setPlacements(eventId, [{ id: ana, position: 1 }], db);

    expect(result.ok).toBe(true);
    expect(pointsFor(await standings(seasonId), ana)).toBe(25);
  });
});

/* ------------------------------------------------------------------ */
/* When the participant list changes afterwards                       */
/* ------------------------------------------------------------------ */

describe("a participant list that moved after the order was saved", () => {
  it("keeps a place recorded for somebody who has since withdrawn", async () => {
    // Not in UC-33. They took part and they finished third; a withdrawal
    // afterwards does not rewrite what happened. A re-save must not be made
    // to delete it silently, so 3d asks "was in the event", not "is in the
    // list now".
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana here");
    const gone = await accepted(eventId, "Ana gone");
    expect(
      (
        await setPlacements(
          eventId,
          [
            { id: ana, position: 1 },
            { id: gone, position: 2 },
          ],
          db
        )
      ).ok
    ).toBe(true);

    await db
      .update(applications)
      .set({ status: "withdrawn" })
      .where(eq(applications.userId, gone));

    const again = await setPlacements(
      eventId,
      [
        { id: ana, position: 1 },
        { id: gone, position: 2 },
      ],
      db
    );

    expect(again.ok).toBe(true);
    expect(await listPlacements(eventId, db)).toHaveLength(2);
  });

  it("stops scoring for a member who has left a placed team", async () => {
    // The team still finished first. The member who left simply stops being
    // one of the people that place pays, because scoring derives the roster
    // on every read rather than writing it down.
    const { seasonId, eventId } = await counting();
    const stayed = await accepted(eventId, "Stayed");
    const left = await accepted(eventId, "Left");
    const red = await aTeam(eventId, "Red roster", [stayed, left]);
    expect((await setPlacements(eventId, [{ id: red, position: 1 }], db)).ok).toBe(true);
    expect(pointsFor(await standings(seasonId), left)).toBe(25);

    await db.delete(teamMembers).where(eq(teamMembers.userId, left));

    const rows = await standings(seasonId);
    expect(pointsFor(rows, stayed)).toBe(25);
    expect(rows.some((row) => row.userId === left)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* UC-33 5: the admin home stops asking                               */
/* ------------------------------------------------------------------ */

describe("counting events nobody has scored", () => {
  it("lists one that has been played and no result recorded", async () => {
    const { eventId } = await counting({ eventStatus: "complete" });

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).toContain(eventId);
  });

  it("stops listing it once an order is in", async () => {
    // UC-33 5. Nothing is marked done: the line is a count taken now.
    const { eventId } = await counting({ eventStatus: "complete" });
    const ana = await accepted(eventId, "Ana scored");

    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);

    const rows = await unscoredResults(db);
    expect(rows.map((row) => row.eventId)).not.toContain(eventId);
  });

  it("does not list an event that has not been played", async () => {
    const { eventId } = await counting({ eventStatus: "draft" });

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).not.toContain(eventId);
  });

  it("does not list one whose season is finished", async () => {
    // A finished season refuses the write, so asking for a result would be
    // asking for a refusal.
    const { seasonId, eventId } = await counting({ eventStatus: "complete" });
    await db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.id, seasonId));

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).not.toContain(eventId);
  });
});
