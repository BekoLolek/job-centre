import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  championshipEvents,
  championshipPlacements,
  championships,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type ChampionshipStanding,
  type CountingEventInput,
  scoreChampionship,
} from "@/lib/championship-policy";
import {
  addCountingEvent,
  championshipOfEvent,
  championshipsToAddTo,
  createChampionship,
  getChampionship,
  listCountingEvents,
  removeCountingEvent,
  setCountingEvent,
} from "@/lib/championships";
import { scoringInputFor } from "@/lib/championship-results";

/*
 * UC-32 — which events count, and for how much — against a real in-memory
 * Postgres. Everything here goes through the write layer rather than the
 * actions, so the rules are tested where they live; who is allowed to press the
 * button is `src/app/admin/events/__tests__/championship.test.ts`'s.
 *
 * The scoring assertions go through `scoreChampionship`, because that is the
 * whole point of the two settings under test: a season stores no total, so
 * "counts at double" and "stops counting" are only ever statements about what
 * the stored rows score to when somebody asks.
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

/** A season in the given status, with a name the open-name index has not seen. */
async function seasonIn(
  status: ChampionshipStatusValue = "published",
  scoring: { pointsTable?: number[]; participationPoints?: number } = {}
): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Counting season ${counter}`, ...scoring }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

/** An event nothing else has used, in the given status. */
async function anEvent(title = "Rivals night", status: "draft" | "complete" = "draft") {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `counts-${counter}`, title, status })
    .returning({ id: events.id });
  return row.id;
}

/** Record one member's finish in a counting event, as Task 41's editor will. */
async function place(eventId: string, position: number): Promise<string> {
  const counting = await championshipOfEvent(eventId, db);
  if (!counting) throw new Error("that event counts towards nothing");
  const userId = await makeUser(db);
  await db
    .insert(championshipPlacements)
    .values({ championshipEventId: counting.id, position, userId });
  return userId;
}

/**
 * The season's standings, worked out from what is stored — nothing else.
 *
 * The counting events and their weights come from the write layer under test;
 * the places come off `scoringInputFor`, which is the one mapping from stored
 * rows to what scoring takes. Reading them any other way here would let this
 * file keep passing while the mapping the standings are really built from
 * drifted underneath it. Task 42's public page makes the same two reads, which
 * is exactly why removing an event needs no re-scoring step: there is no total
 * to correct.
 */
async function standings(championshipId: string): Promise<ChampionshipStanding[]> {
  const season = await getChampionship(championshipId, db);
  if (!season) throw new Error("no such season");

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

/**
 * A handle that runs `between` after the write layer has read, but before its
 * insert lands — `writingAfter` in `events.test.ts`, for an insert.
 *
 * Sequenced rather than raced: the window it pins is one statement wide, and a
 * test that had to *win* a race to see it would be a test that passes by luck.
 */
function insertingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "insert") return Reflect.get(target, property, receiver);
      return (table: Parameters<Database["insert"]>[0]) => ({
        select: (query: unknown) => ({
          returning: async () => {
            const run = pending;
            pending = null;
            if (run) await run();
            const builder = target.insert(table) as unknown as {
              select: (of: unknown) => { returning: () => Promise<unknown[]> };
            };
            return builder.select(query).returning();
          },
        }),
      });
    },
  });
}

/** What one member scored across the season. */
function pointsFor(rows: ChampionshipStanding[], userId: string): number {
  return rows.find((row) => row.userId === userId)?.points ?? 0;
}

/* ------------------------------------------------------------------ */
/* UC-32 1: which seasons are offered, and to whom                    */
/* ------------------------------------------------------------------ */

describe("the seasons an event may be added to", () => {
  it("offers an admin the hidden ones as well as the published", async () => {
    // UC-31 2 is a rule about who may *see* a season being set up, and an
    // admin is who it lets see one.
    const hidden = await seasonIn("hidden");
    const published = await seasonIn("published");

    const offered = await championshipsToAddTo({ isAdmin: true }, db);

    expect(offered.map((row) => row.id)).toEqual(expect.arrayContaining([hidden, published]));
  });

  it("offers a host the published ones only", async () => {
    // UC-31 2: "only admins can see it". A dropdown of every draft season on
    // every host's event editor is exactly what that excludes.
    const hidden = await seasonIn("hidden");
    const published = await seasonIn("published");

    const offered = await championshipsToAddTo({ isAdmin: false }, db);

    expect(offered.map((row) => row.id)).toContain(published);
    expect(offered.map((row) => row.id)).not.toContain(hidden);
  });

  it("offers a finished season to nobody", async () => {
    // UC-35 2b: it takes no new events, so offering it offers a refusal.
    const closed = await seasonIn("closed");

    const toAdmin = await championshipsToAddTo({ isAdmin: true }, db);
    const toHost = await championshipsToAddTo({ isAdmin: false }, db);

    expect(toAdmin.map((row) => row.id)).not.toContain(closed);
    expect(toHost.map((row) => row.id)).not.toContain(closed);
  });

  it("still tells a host which season their own event is in, hidden or not", async () => {
    // The other half of the rule: browsing everybody else's unpublished
    // seasons is not theirs, knowing what their own event counts towards is.
    const hidden = await seasonIn("hidden");
    const eventId = await anEvent();
    expect((await addCountingEvent(hidden, eventId, db)).ok).toBe(true);

    const counting = await championshipOfEvent(eventId, db);

    expect(counting?.season.id).toBe(hidden);
    expect(counting?.season.status).toBe("hidden");
  });
});

/* ------------------------------------------------------------------ */
/* UC-32 1-2: adding one                                              */
/* ------------------------------------------------------------------ */

describe("adding an event to a championship", () => {
  it("counts it at weight 1", async () => {
    // UC-32 1-2.
    const seasonId = await seasonIn();
    const eventId = await anEvent();

    const result = await addCountingEvent(seasonId, eventId, db);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.weight).toBe(1);
    expect((await championshipOfEvent(eventId, db))?.season.id).toBe(seasonId);
  });

  it("lists it among the season's events", async () => {
    // The outcome UC-32 states.
    const seasonId = await seasonIn();
    const eventId = await anEvent("Jackbox evening");

    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);

    expect((await listCountingEvents(seasonId, db)).map((row) => row.title)).toEqual([
      "Jackbox evening",
    ]);
  });

  it("refuses an event that already counts towards another season, naming it", async () => {
    // UC-32 1a.
    const first = await seasonIn();
    const second = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(first, eventId, db)).ok).toBe(true);
    const name = (await getChampionship(first, db))?.name;

    const result = await addCountingEvent(second, eventId, db);

    expect(result).toEqual({
      ok: false,
      error: `This event already counts towards "${name}". Take it out of that season first.`,
    });
    expect((await listCountingEvents(second, db))).toEqual([]);
  });

  it("takes a completed event and scores its places straight away", async () => {
    // UC-32 1b: the event is over, so the places are recorded the moment it is in.
    const seasonId = await seasonIn();
    const eventId = await anEvent("Last month's tournament", "complete");

    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    const winner = await place(eventId, 1);

    expect(pointsFor(await standings(seasonId), winner)).toBe(25);
  });

  it("refuses an event that no longer exists", async () => {
    const seasonId = await seasonIn();

    const result = await addCountingEvent(seasonId, crypto.randomUUID(), db);

    expect(result).toEqual({ ok: false, error: "That event no longer exists." });
  });

  it("refuses a season that no longer exists", async () => {
    const eventId = await anEvent();

    const result = await addCountingEvent(crypto.randomUUID(), eventId, db);

    expect(result).toEqual({ ok: false, error: "That championship no longer exists." });
  });

  it("lets only one of two seasons take the same event at the same moment", async () => {
    /*
     * R-196 is the column's, not the screen's: both calls read nothing in the
     * way and both insert. Postgres refuses the loser on
     * `championship_events_event_uniq`, and without the catch around the insert
     * that refusal reaches the browser as "Could not reach the server" — which
     * invites a retry that will fail identically.
     */
    const first = await seasonIn();
    const second = await seasonIn();
    const eventId = await anEvent();

    const [one, two] = await Promise.all([
      addCountingEvent(first, eventId, db),
      addCountingEvent(second, eventId, db),
    ]);

    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    const loser = one.ok ? two : one;
    expect(!loser.ok && loser.error).toMatch(/already counts towards "Counting season \d+"\./);
    expect(await db.select().from(championshipEvents).where(eq(championshipEvents.eventId, eventId)))
      .toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-32 3-4: what it is worth                                        */
/* ------------------------------------------------------------------ */

describe("the weight", () => {
  it("scores that event's places at double when it is 2", async () => {
    // UC-32 3-4.
    const seasonId = await seasonIn();
    const eventId = await anEvent("Whole-day tournament");
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    const winner = await place(eventId, 1);

    const result = await setCountingEvent(eventId, { weight: 2 }, db);

    expect(result.ok).toBe(true);
    expect(pointsFor(await standings(seasonId), winner)).toBe(50);
  });

  it.each([0, -1, 2.5])("refuses a weight of %s, changing nothing", async (weight) => {
    // UC-32 3b.
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);

    const result = await setCountingEvent(eventId, { weight }, db);

    expect(result).toEqual({
      ok: false,
      error: "The weight has to be a whole number of 1 or more.",
    });
    expect((await championshipOfEvent(eventId, db))?.weight).toBe(1);
  });

  it("refuses a weight for an event that counts towards nothing", async () => {
    const eventId = await anEvent();

    const result = await setCountingEvent(eventId, { weight: 2 }, db);

    expect(result).toEqual({
      ok: false,
      error: "This event does not count towards a championship.",
    });
  });
});

describe("an event's own points table", () => {
  it("is used instead of the season's, still multiplied by the weight", async () => {
    // UC-32 3a.
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    const winner = await place(eventId, 1);

    const result = await setCountingEvent(eventId, { pointsTable: [40, 30], weight: 2 }, db);

    expect(result.ok).toBe(true);
    expect(pointsFor(await standings(seasonId), winner)).toBe(80);
  });

  it("goes back to the season's when it is cleared", async () => {
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    const winner = await place(eventId, 1);
    expect((await setCountingEvent(eventId, { pointsTable: [40] }, db)).ok).toBe(true);

    const result = await setCountingEvent(eventId, { pointsTable: null }, db);

    expect(result.ok && result.data.pointsTable).toBeNull();
    expect(pointsFor(await standings(seasonId), winner)).toBe(25);
  });

  it("refuses a table that goes up as you finish lower", async () => {
    // The season's own rule (UC-31 3b), asked of the event's table.
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);

    const result = await setCountingEvent(eventId, { pointsTable: [10, 12] }, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "2nd place is worth more than 1st: the table must not go up as you finish lower."
    );
    expect((await championshipOfEvent(eventId, db))?.pointsTable).toBeNull();
  });

  it("refuses a table whose last place is worth less than taking part", async () => {
    // UC-31 4a read from the other end: the season's participation points floor
    // this table too, so a table below them would pay better for not finishing.
    const seasonId = await seasonIn("published", { pointsTable: [10, 5], participationPoints: 5 });
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);

    const result = await setCountingEvent(eventId, { pointsTable: [8, 2] }, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "Taking part cannot be worth more than last place in the table, which is 2."
    );
  });
});

/* ------------------------------------------------------------------ */
/* UC-32 4a: taking one out                                           */
/* ------------------------------------------------------------------ */

describe("removing an event from a championship", () => {
  it("stops counting it and re-scores the season", async () => {
    // UC-32 4a. Nothing is re-computed and nothing is stored: the standings are
    // a function of the rows, and one of the rows has gone.
    const seasonId = await seasonIn();
    const kept = await anEvent("Kept");
    const dropped = await anEvent("Dropped");
    expect((await addCountingEvent(seasonId, kept, db)).ok).toBe(true);
    expect((await addCountingEvent(seasonId, dropped, db)).ok).toBe(true);
    const member = await place(kept, 1);
    await db
      .insert(championshipPlacements)
      .values({
        championshipEventId: (await championshipOfEvent(dropped, db))?.id ?? "",
        position: 1,
        userId: member,
      });
    expect(pointsFor(await standings(seasonId), member)).toBe(50);

    const result = await removeCountingEvent(dropped, db);

    expect(result.ok).toBe(true);
    expect(pointsFor(await standings(seasonId), member)).toBe(25);
    expect((await listCountingEvents(seasonId, db)).map((row) => row.title)).toEqual(["Kept"]);
  });

  it("takes the places recorded in it away with it", async () => {
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    const added = await addCountingEvent(seasonId, eventId, db);
    await place(eventId, 1);

    expect((await removeCountingEvent(eventId, db)).ok).toBe(true);

    const left = await db
      .select()
      .from(championshipPlacements)
      .where(eq(championshipPlacements.championshipEventId, added.ok ? added.data.id : ""));
    expect(left).toEqual([]);
    expect(await championshipOfEvent(eventId, db)).toBeNull();
  });

  it("refuses an event that counts towards nothing", async () => {
    const eventId = await anEvent();

    const result = await removeCountingEvent(eventId, db);

    expect(result).toEqual({
      ok: false,
      error: "This event does not count towards a championship.",
    });
  });

  it("frees the event to count towards another season", async () => {
    const first = await seasonIn();
    const second = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(first, eventId, db)).ok).toBe(true);

    expect((await removeCountingEvent(eventId, db)).ok).toBe(true);

    expect((await addCountingEvent(second, eventId, db)).ok).toBe(true);
    expect((await championshipOfEvent(eventId, db))?.season.id).toBe(second);
  });
});

/* ------------------------------------------------------------------ */
/* The lock on a finished season (UC-35 2b)                           */
/* ------------------------------------------------------------------ */

const LOCKED = "This championship is finished - reopen it to change it";

describe("a closed season", () => {
  it("takes no new counting event", async () => {
    const seasonId = await seasonIn("closed");
    const eventId = await anEvent();

    const result = await addCountingEvent(seasonId, eventId, db);

    expect(result).toEqual({ ok: false, error: LOCKED });
    expect(await listCountingEvents(seasonId, db)).toEqual([]);
  });

  it("takes no event into a season closed between the check and the write", async () => {
    /*
     * The lock is read first, for the sentence, and carried into the insert's
     * own `where`, for the truth. Closing a season is what freezes standings
     * people are about to read, so an event landing in it a moment afterwards
     * would change a season that had promised to stop changing.
     */
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    const close = () =>
      db.update(championships).set({ status: "closed" }).where(eq(championships.id, seasonId));

    const result = await addCountingEvent(seasonId, eventId, insertingAfter(close));

    expect(result).toEqual({ ok: false, error: LOCKED });
    expect(await championshipOfEvent(eventId, db)).toBeNull();
    expect(await listCountingEvents(seasonId, db)).toEqual([]);
  });

  it("takes no change to what one of its events is worth", async () => {
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    await db.update(championships).set({ status: "closed" }).where(eq(championships.id, seasonId));

    const result = await setCountingEvent(eventId, { weight: 3 }, db);

    expect(result).toEqual({ ok: false, error: LOCKED });
    expect((await championshipOfEvent(eventId, db))?.weight).toBe(1);
  });

  it("lets none of its events be taken out", async () => {
    const seasonId = await seasonIn();
    const eventId = await anEvent();
    expect((await addCountingEvent(seasonId, eventId, db)).ok).toBe(true);
    await db.update(championships).set({ status: "closed" }).where(eq(championships.id, seasonId));

    const result = await removeCountingEvent(eventId, db);

    expect(result).toEqual({ ok: false, error: LOCKED });
    expect(await championshipOfEvent(eventId, db)).not.toBeNull();
  });
});
