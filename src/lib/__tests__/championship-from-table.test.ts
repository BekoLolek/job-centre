import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type Database,
  type EventConfig,
  applications,
  championships,
  eventRoundScores,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type ChampionshipStanding,
  type CountingEventInput,
  duplicateMemberIn,
  scoreChampionship,
} from "@/lib/championship-policy";
import {
  ROUND_SCORED_REFUSAL,
  finishingOrderFor,
  listPlacements,
  scoringInputFor,
  setPlacements,
  unscoredResults,
} from "@/lib/championship-results";
import { seasonPage } from "@/lib/championship-season";
import {
  addCountingEvent,
  createChampionship,
  getChampionship,
  listCountingEvents,
  setChampionshipStatus,
  unscoredCountingEvents,
} from "@/lib/championships";
import { listRoundScores, saveRound } from "@/lib/round-scores";

/*
 * UC-46 5, 5a, 5b, 5c, 5d — the season takes its places from the night's table
 * (R-232, R-236, R-238; docs/decisions/006-round-scored-events.md, decision 2)
 * — against a real in-memory Postgres.
 *
 * Every round is written through Task 88's `saveRound`, the only writer of
 * `event_round_scores`, and every standing is read the way the public page
 * reads it: `scoringInputFor` per counting event into `scoreChampionship`.
 * Nothing is asserted against a stored total, because there is none; nothing
 * is asserted against a stored place either, because for these events there
 * is none of those — which is the point.
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

/** Three unnamed rounds, highest score wins, no bonuses — the smallest setup with room for a tie. */
const THREE_ROUNDS = {
  rounds: [{ name: null }, { name: null }, { name: null }],
  lowWins: false,
  bonuses: [],
};

const ROUND_SCORED: EventConfig = { roundScoring: THREE_ROUNDS };

async function seasonIn(
  scoring: { pointsTable?: number[]; participationPoints?: number } = {}
): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Table season ${counter}`, ...scoring }, db);
  if (!made.ok) throw new Error(made.error);
  await db
    .update(championships)
    .set({ status: "published" })
    .where(eq(championships.id, made.data.id));
  return made.data.id;
}

/** A live night — `saveRound` is refused on a complete one (UC-09 6b). */
async function night(config: EventConfig = ROUND_SCORED): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `table-${counter}`, title: `Table night ${counter}`, status: "live", config })
    .returning({ id: events.id });
  return row.id;
}

/** A season with one night counting towards it. */
async function counting(
  options: { config?: EventConfig; participationPoints?: number } = {}
): Promise<{ seasonId: string; eventId: string }> {
  const seasonId = await seasonIn(
    options.participationPoints === undefined
      ? {}
      : { participationPoints: options.participationPoints }
  );
  const eventId = await night(options.config);
  const added = await addCountingEvent(seasonId, eventId, db);
  if (!added.ok) throw new Error(added.error);
  return { seasonId, eventId };
}

async function accepted(eventId: string, displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
  return userId;
}

/** Score one round through the real write, replacing whatever the round held. */
async function scored(
  eventId: string,
  roundIndex: number,
  scores: Record<string, number>
): Promise<void> {
  const expected = (await listRoundScores(eventId, db)).filter(
    (row) => row.roundIndex === roundIndex
  );
  const saved = await saveRound(
    eventId,
    {
      roundIndex,
      entries: Object.entries(scores).map(([userId, score]) => ({ userId, score, bonuses: {} })),
      expected,
    },
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

/** Switch how the night is scored, as the Scoring panel's save does. */
async function rescored(eventId: string, config: EventConfig): Promise<void> {
  await db.update(events).set({ config }).where(eq(events.id, eventId));
}

/* ------------------------------------------------------------------ */
/* Scoring, assembled from what is stored and nothing else            */
/* ------------------------------------------------------------------ */

async function standings(championshipId: string): Promise<ChampionshipStanding[]> {
  const season = await getChampionship(championshipId, db);
  if (!season) throw new Error("no such season");

  // `scoringInputFor` and nothing else — the one mapping from stored rows to
  // what scoring takes, as `championship-results.test.ts` reads it.
  const rows = await listCountingEvents(championshipId, db);
  const inputs = (
    await Promise.all(rows.map((row) => scoringInputFor(row.eventId, db)))
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

function pointsFor(rows: ChampionshipStanding[], userId: string): number {
  return rows.find((row) => row.userId === userId)?.points ?? 0;
}

function positionOf(rows: ChampionshipStanding[], userId: string): number | null {
  return rows.find((row) => row.userId === userId)?.position ?? null;
}

/* ------------------------------------------------------------------ */
/* UC-46 5: the season follows the table                              */
/* ------------------------------------------------------------------ */

describe("a round-scored event in a season", () => {
  it("scores it from its table, with nobody typing an order", async () => {
    // UC-46 5 / R-236. The default table pays 25, 18, 15.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana table");
    const ben = await accepted(eventId, "Ben table");
    const cal = await accepted(eventId, "Cal table");
    await scored(eventId, 1, { [ana]: 10, [ben]: 5, [cal]: 7 });
    await scored(eventId, 2, { [ana]: 10, [ben]: 9, [cal]: 6 });

    const rows = await standings(seasonId);

    expect(pointsFor(rows, ana)).toBe(25); // 20
    expect(pointsFor(rows, ben)).toBe(18); // 14
    expect(pointsFor(rows, cal)).toBe(15); // 13
    expect(positionOf(rows, ana)).toBe(1);
    // Nothing was typed, and nothing was written where a typed order goes.
    expect(await listPlacements(eventId, db)).toEqual([]);
    expect((await finishingOrderFor(eventId, db)).source).toBe("table");
  });

  it("pays two players level in the table the same row, and the row below to nobody", async () => {
    // UC-46 5d / R-238. 1, 1, 3 — the 18 is unclaimed.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana level");
    const ben = await accepted(eventId, "Ben level");
    const cal = await accepted(eventId, "Cal level");
    await scored(eventId, 1, { [ana]: 10, [ben]: 12, [cal]: 7 });
    await scored(eventId, 2, { [ana]: 10, [ben]: 8, [cal]: 6 });

    const rows = await standings(seasonId);

    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, ben)).toBe(25);
    expect(pointsFor(rows, cal)).toBe(15);
    expect(rows.map((row) => row.points)).not.toContain(18);
    const order = await finishingOrderFor(eventId, db);
    expect(order.places.map((place) => place.position)).toEqual([1, 1, 3]);
  });

  it("moves the standings when a round is corrected", async () => {
    // UC-46 5c / R-233. The same read, before and after; nothing stored a total.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana before");
    const ben = await accepted(eventId, "Ben before");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });
    await scored(eventId, 2, { [ana]: 10, [ben]: 8 });
    const before = await standings(seasonId);
    expect(positionOf(before, ana)).toBe(1);
    expect(pointsFor(before, ben)).toBe(18);

    // Round 2 was typed the wrong way round.
    await scored(eventId, 2, { [ana]: 8, [ben]: 20 });

    const after = await standings(seasonId);
    expect(positionOf(after, ben)).toBe(1);
    expect(pointsFor(after, ben)).toBe(25);
    expect(pointsFor(after, ana)).toBe(18);
    expect(after.map((row) => [row.userId, row.points])).not.toEqual(
      before.map((row) => [row.userId, row.points])
    );
  });

  it("gives a player with no score in any round the taking-part points, and no place", async () => {
    // UC-46 5a / UC-33 3b. They were there and played nothing.
    const { seasonId, eventId } = await counting({ participationPoints: 1 });
    const ana = await accepted(eventId, "Ana played");
    const dee = await accepted(eventId, "Dee watched");
    await scored(eventId, 1, { [ana]: 10 });

    const rows = await standings(seasonId);

    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, dee)).toBe(1);
    expect(rows.find((row) => row.userId === dee)?.results[0].position).toBeNull();
    const order = await finishingOrderFor(eventId, db);
    expect(order.places.map((place) => place.id)).toEqual([ana]);
  });

  it("ranks each player once, so nobody can hold two places in the derived order", async () => {
    // `scoreChampionship` counts a member who appears twice once, at their
    // best; the derived order cannot produce that case, because `rankRounds`
    // groups the rows by player before it places anyone.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana once");
    const ben = await accepted(eventId, "Ben once");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });
    await scored(eventId, 2, { [ana]: 3, [ben]: 9 });
    await scored(eventId, 3, { [ana]: 6 });

    const input = await scoringInputFor(eventId, db);

    expect(input).not.toBeNull();
    expect(input!.placements).toHaveLength(2);
    expect(duplicateMemberIn(input!.placements)).toBeNull();
    expect(input!.placements.every((place) => place.subject.kind === "member")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* UC-46 5b: the hand-typed order is refused                          */
/* ------------------------------------------------------------------ */

describe("typing an order by hand for a round-scored event", () => {
  it("is refused, pointing at the Results tab, and writes nothing", async () => {
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana typed");
    await scored(eventId, 1, { [ana]: 10 });

    const result = await setPlacements(eventId, [{ id: ana, position: 1 }], db);

    expect(result).toEqual({ ok: false, error: ROUND_SCORED_REFUSAL });
    expect(ROUND_SCORED_REFUSAL).toBe(
      "This night is scored in rounds, so its finishing order is its table. Correct a round on the Results tab instead."
    );
    // Not `saveRound`'s refusal, which shares three words with it.
    expect(ROUND_SCORED_REFUSAL).not.toContain("not scored in rounds");
    expect(await listPlacements(eventId, db)).toEqual([]);
  });

  it("is refused even when nothing has been scored yet", async () => {
    // The table being empty does not make the typed order the authority: a
    // night with no rounds in yet has no result, not a different kind of one.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana early");

    const result = await setPlacements(eventId, [{ id: ana, position: 1 }], db);

    expect(result).toEqual({ ok: false, error: ROUND_SCORED_REFUSAL });
    expect(await listPlacements(eventId, db)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* An order typed before the night became round-scored               */
/* ------------------------------------------------------------------ */

describe("a hand-typed order that predates the switch to rounds", () => {
  it("is kept, shadowed, and never read while the night is scored in rounds", async () => {
    const { seasonId, eventId } = await counting({ config: {} });
    const ana = await accepted(eventId, "Ana shadowed");
    const ben = await accepted(eventId, "Ben shadowed");
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
    expect(pointsFor(await standings(seasonId), ana)).toBe(25);

    await rescored(eventId, ROUND_SCORED);
    await scored(eventId, 1, { [ana]: 5, [ben]: 10 });

    // The season reads the table: the typed order said the opposite.
    const rows = await standings(seasonId);
    expect(pointsFor(rows, ben)).toBe(25);
    expect(pointsFor(rows, ana)).toBe(18);
    // The typed rows are still there, and the order says so.
    const typed = await listPlacements(eventId, db);
    expect(typed).toEqual([
      { id: ana, position: 1, kind: "member", name: "Ana shadowed" },
      { id: ben, position: 2, kind: "member", name: "Ben shadowed" },
    ]);
    const order = await finishingOrderFor(eventId, db);
    expect(order.source).toBe("table");
    expect(order.source === "table" && order.shadowed).toEqual(typed);
  });

  it("is read again, exactly as it was, once the night is no longer scored in rounds", async () => {
    // The promise Task 93 can lean on: nothing was deleted, so nothing has to
    // be resurrected — the rows were there all along, and the screen said so.
    const { seasonId, eventId } = await counting({ config: {} });
    const ana = await accepted(eventId, "Ana back");
    const ben = await accepted(eventId, "Ben back");
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
    await rescored(eventId, ROUND_SCORED);
    await scored(eventId, 1, { [ana]: 5, [ben]: 10 });
    expect(pointsFor(await standings(seasonId), ben)).toBe(25);

    await rescored(eventId, {});

    const rows = await standings(seasonId);
    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, ben)).toBe(18);
    expect(await finishingOrderFor(eventId, db)).toEqual({
      source: "typed",
      places: await listPlacements(eventId, db),
    });
  });
});

/* ------------------------------------------------------------------ */
/* An event that is not round-scored is unaffected                    */
/* ------------------------------------------------------------------ */

describe("an event that is not scored in rounds", () => {
  it("reads its typed order and nothing else, whatever sits in the round table", async () => {
    // The statement behind "UC-33 is untouched": the typed order is the whole
    // finishing order, and a round row on such an event is not consulted.
    const { seasonId, eventId } = await counting({ config: {} });
    const ana = await accepted(eventId, "Ana typed only");
    const ben = await accepted(eventId, "Ben typed only");
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
    // A row no screen can write for this event, planted to prove it is ignored.
    await db
      .insert(eventRoundScores)
      .values({ eventId, roundIndex: 1, userId: ben, score: 99, bonuses: {} });

    expect(await finishingOrderFor(eventId, db)).toEqual({
      source: "typed",
      places: await listPlacements(eventId, db),
    });
    const rows = await standings(seasonId);
    expect(pointsFor(rows, ana)).toBe(25);
    expect(pointsFor(rows, ben)).toBe(18);
  });
});

/* ------------------------------------------------------------------ */
/* The public season page (UC-34 6, over a round-scored night)        */
/* ------------------------------------------------------------------ */

describe("the public season page", () => {
  it("counts a round-scored night and names its winner from the table", async () => {
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana public");
    const ben = await accepted(eventId, "Ben public");
    await scored(eventId, 1, { [ana]: 4, [ben]: 9 });

    const season = await getChampionship(seasonId, db);
    const page = await seasonPage(season!, db);

    expect(page.toCome).toEqual([]);
    expect(page.counted.map((event) => [event.eventId, event.winners])).toEqual([
      [eventId, ["Ben public"]],
    ]);
    expect(page.standings[0]).toMatchObject({ userId: ben, points: 25, position: 1 });
  });

  it("lists a round-scored night with nothing scored yet as still to come", async () => {
    const { seasonId, eventId } = await counting();
    await accepted(eventId, "Ana waiting");

    const season = await getChampionship(seasonId, db);
    const page = await seasonPage(season!, db);

    expect(page.counted).toEqual([]);
    expect(page.toCome.map((event) => event.eventId)).toEqual([eventId]);
    expect(page.standings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The admin home's "missing a result" line (UC-33 5), over a night   */
/* whose result is its table                                          */
/* ------------------------------------------------------------------ */

describe("the admin home and a round-scored night", () => {
  it("does not list a night whose table has a result", async () => {
    // Task 94. The season scores this night from its table, so the home page
    // saying nobody has recorded a result would be saying something false.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana home");
    const ben = await accepted(eventId, "Ben home");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });
    await scored(eventId, 2, { [ana]: 7, [ben]: 9 });
    await scored(eventId, 3, { [ana]: 6, [ben]: 5 });

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).not.toContain(eventId);
  });

  it("does not list a night with only some rounds in, because the season already pays from it", async () => {
    // The one judgment in Task 94. A table covering 1 of 3 rounds is shown to
    // visitors as it stands (UC-46 3a) and the season takes its places from it
    // now, so "has a result" is the same question the reader answers for the
    // season — not a second rule about how many rounds make a result.
    const { eventId } = await counting();
    const ana = await accepted(eventId, "Ana early rounds");
    const ben = await accepted(eventId, "Ben early rounds");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).not.toContain(eventId);
  });

  it("lists a night with nothing scored, because it genuinely has no result", async () => {
    const { eventId } = await counting();
    await accepted(eventId, "Ana nothing yet");

    const rows = await unscoredResults(db);

    expect(rows.map((row) => row.eventId)).toContain(eventId);
  });

  it("lists a night whose only rows are a shadowed typed order", async () => {
    // The order was typed before the night became round-scored. Task 91's
    // decision is that those rows are kept and never read as places, so the
    // season pays nothing from this night and the home page must say so —
    // which it can only get right by asking the reader, not the table of rows.
    const { eventId } = await counting({ config: {} });
    const ana = await accepted(eventId, "Ana shadowed home");
    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);
    expect((await unscoredResults(db)).map((row) => row.eventId)).not.toContain(eventId);

    await rescored(eventId, ROUND_SCORED);

    const rows = await unscoredResults(db);
    expect(rows.map((row) => row.eventId)).toContain(eventId);
  });
});

/* ------------------------------------------------------------------ */
/* Closing the season (UC-35 1a) over a night whose result is its     */
/* table                                                              */
/* ------------------------------------------------------------------ */

/** The one sentence the close-season question is allowed to be, for one night. */
function askedAbout(title: string): string {
  return `"${title}" has no result yet. Close the season anyway?`;
}

/** Everything a refused close must leave exactly as it was. */
async function stateOf(seasonId: string, eventId: string) {
  return {
    season: await getChampionship(seasonId, db),
    counting: await listCountingEvents(seasonId, db),
    typed: await listPlacements(eventId, db),
    rounds: (await listRoundScores(eventId, db)).sort((x, y) =>
      `${x.roundIndex}:${x.userId}`.localeCompare(`${y.roundIndex}:${y.userId}`)
    ),
  };
}

describe("closing a season that contains a round-scored night", () => {
  it("does not ask about a night whose table is fully scored", async () => {
    // Task 96. The season pays this night from its table, so "has no result
    // yet" would be false; the old `championship_placements` read said it.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana closing");
    const ben = await accepted(eventId, "Ben closing");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });
    await scored(eventId, 2, { [ana]: 7, [ben]: 9 });
    await scored(eventId, 3, { [ana]: 6, [ben]: 5 });
    expect(await unscoredCountingEvents(seasonId, db)).toEqual([]);

    const result = await setChampionshipStatus(seasonId, "published", "closed", {}, db);

    expect(result.ok).toBe(true);
    expect((await getChampionship(seasonId, db))?.status).toBe("closed");
  });

  it("does not ask about a night with only some rounds in, because the season already pays from it", async () => {
    // Task 94's judgment, applied here: a part-scored table has places, and
    // the season takes them now (UC-46 3a, 5), so nothing is missing from it.
    const { seasonId, eventId } = await counting();
    const ana = await accepted(eventId, "Ana part closing");
    const ben = await accepted(eventId, "Ben part closing");
    await scored(eventId, 1, { [ana]: 10, [ben]: 8 });

    const result = await setChampionshipStatus(seasonId, "published", "closed", {}, db);

    expect(result.ok).toBe(true);
  });

  it("asks about a night with nothing scored, and writes nothing while it asks", async () => {
    // UC-35 1a. The refusal precedes the one write (decision 004, shape 1), so
    // the rows it would have touched are compared, not merely the `ok`.
    const { seasonId, eventId } = await counting();
    await accepted(eventId, "Ana unscored closing");
    const title = (await listCountingEvents(seasonId, db))[0].title;
    const before = await stateOf(seasonId, eventId);

    const result = await setChampionshipStatus(seasonId, "published", "closed", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(askedAbout(title));
    // The season question, not the Results-tab refusal or the lock's sentence.
    expect(!result.ok && result.error).not.toContain("scored in rounds");
    expect(!result.ok && result.error).not.toContain("finished");
    expect(!result.ok && result.unscored).toEqual([{ eventId, title }]);
    expect(await stateOf(seasonId, eventId)).toEqual(before);
    expect(before.season?.status).toBe("published");
  });

  it("closes a season with such a night once the admin confirms", async () => {
    // UC-35 1a, confirmed — the same answer the typed world gives.
    const { seasonId, eventId } = await counting();
    await accepted(eventId, "Ana confirmed closing");

    const result = await setChampionshipStatus(
      seasonId,
      "published",
      "closed",
      { confirm: true },
      db
    );

    expect(result.ok).toBe(true);
    expect((await getChampionship(seasonId, db))?.status).toBe("closed");
  });

  it("asks about a night whose only rows are a shadowed typed order", async () => {
    // The case that matters most, and the one a `championship_placements`
    // read can never get right: the rows are there, so it says the night has a
    // result, and the season closes paying nothing for that night. Task 91's
    // decision is that those rows are kept and never read as places.
    const { seasonId, eventId } = await counting({ config: {} });
    const ana = await accepted(eventId, "Ana shadowed closing");
    expect((await setPlacements(eventId, [{ id: ana, position: 1 }], db)).ok).toBe(true);
    const title = (await listCountingEvents(seasonId, db))[0].title;
    // Typed world: the order counts, so nothing is asked.
    expect(await unscoredCountingEvents(seasonId, db)).toEqual([]);

    await rescored(eventId, ROUND_SCORED);
    const before = await stateOf(seasonId, eventId);
    const result = await setChampionshipStatus(seasonId, "published", "closed", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(askedAbout(title));
    expect(!result.ok && result.unscored).toEqual([{ eventId, title }]);
    expect(await stateOf(seasonId, eventId)).toEqual(before);
    // The typed rows are still there — they are what the old read counted.
    expect(before.typed.map((row) => row.id)).toEqual([ana]);
  });
});
