import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  applications,
  championships,
  events,
  games,
  teamMembers,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  currentSeason,
  finishedSeasons,
  publicSeason,
  seasonPage,
} from "@/lib/championship-season";
import {
  addCountingEvent,
  createChampionship,
  getChampionship,
  setCountingEvent,
} from "@/lib/championships";
import { setPlacements } from "@/lib/championship-results";

/*
 * UC-34 and UC-35 3-4 — the season as a visitor reads it — against a real
 * in-memory Postgres.
 *
 * Everything is written through the production write layer and read back
 * through `seasonPage`, which is the read the page makes. Nothing is asserted
 * against a stored total, because the season stores none: the standings, the
 * movement and a finished season's winner are all functions of the recorded
 * places, and that is exactly what these tests pin.
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

async function season(
  status: ChampionshipStatusValue = "published",
  scoring: { pointsTable?: number[]; participationPoints?: number; countBest?: number } = {}
): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Season ${counter}`, ...scoring }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

/** A counting event on a season, played at the given hour so the order is fixed. */
async function night(
  seasonId: string,
  title: string,
  startsAt: Date | null,
  over: { gameId?: string } = {}
): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({
      slug: `night-${counter}`,
      title,
      status: "complete",
      startsAt,
      gameId: over.gameId,
    })
    .returning({ id: events.id });
  const added = await addCountingEvent(seasonId, row.id, db);
  if (!added.ok) throw new Error(added.error);
  return row.id;
}

async function accepted(eventId: string, displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
  return userId;
}

/** Record a finishing order, first place first. */
async function finished(eventId: string, order: string[]): Promise<void> {
  const saved = await setPlacements(
    eventId,
    order.map((id, index) => ({ id, position: index + 1 })),
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

async function page(seasonId: string) {
  const row = await getChampionship(seasonId, db);
  if (!row) throw new Error("no such season");
  return seasonPage(row, db);
}

/* ------------------------------------------------------------------ */
/* UC-34 1, 1a — which season, and whether there is one               */
/* ------------------------------------------------------------------ */

describe("which season the public sees", () => {
  /*
   * First in the file on purpose: an empty `championships` table is a fact
   * about the whole database, and this is the only point at which the shared
   * one has that shape. It asserts the emptiness before leaning on it, so a
   * reordering says what went wrong rather than failing somewhere obscure —
   * and it stays one test rather than one per status, because every step of it
   * depends on nothing else having published a season yet.
   */
  it("offers nothing while every season is hidden or finished", async () => {
    // UC-34 1a: no published season, so no navigation item — the page decides
    // that by getting null back from here.
    expect(await db.select().from(championships)).toEqual([]);
    expect(await currentSeason(db)).toBeNull();

    const draft = await season("hidden");
    expect(await currentSeason(db)).toBeNull();

    await db
      .update(championships)
      .set({ status: "published" })
      .where(eq(championships.id, draft));
    expect((await currentSeason(db))?.id).toBe(draft);

    await db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.id, draft));
    expect(await currentSeason(db)).toBeNull();
  });

  it("is the newest published one", async () => {
    const older = await season("published");
    const newer = await season("published");

    const current = await currentSeason(db);

    expect(current?.id).toBe(newer);
    expect(current?.id).not.toBe(older);
  });
});

/* ------------------------------------------------------------------ */
/* R-189 in public — a guessed URL                                    */
/* ------------------------------------------------------------------ */

describe("a hidden season", () => {
  it("is not there for a visitor who guesses its slug", async () => {
    const hidden = await season("hidden");
    const row = await getChampionship(hidden, db);
    if (!row) throw new Error("no such season");

    expect(await publicSeason(row.slug, { isAdmin: false }, db)).toBeNull();
  });

  it("is there for an admin, who is the person still writing it", async () => {
    const hidden = await season("hidden");
    const row = await getChampionship(hidden, db);
    if (!row) throw new Error("no such season");

    expect((await publicSeason(row.slug, { isAdmin: true }, db))?.id).toBe(hidden);
  });

  it("does not hide a published or a finished one", async () => {
    for (const status of ["published", "closed"] as const) {
      const id = await season(status);
      const row = await getChampionship(id, db);
      if (!row) throw new Error("no such season");
      expect((await publicSeason(row.slug, { isAdmin: false }, db))?.id, status).toBe(id);
    }
  });

  it("answers nothing for a slug nobody has ever used", async () => {
    expect(await publicSeason("no-such-season", { isAdmin: true }, db)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-34 2, 2a, 2d — the standings                                    */
/* ------------------------------------------------------------------ */

describe("the standings", () => {
  it("orders by points, and matches the recorded places exactly", async () => {
    const id = await season("published");
    const one = await night(id, "Among Us", new Date("2026-03-01T19:00:00Z"));
    const ana = await accepted(one, "Ana");
    const ben = await accepted(one, "Ben");
    const cal = await accepted(one, "Cal");
    await finished(one, [ben, ana, cal]);

    const { standings } = await page(id);

    expect(standings.map((row) => [row.name, row.position, row.points])).toEqual([
      ["Ben", 1, 25],
      ["Ana", 2, 18],
      ["Cal", 3, 15],
    ]);
  });

  it("shows two players level when the tie rule cannot separate them", async () => {
    // UC-34 2a. Both won one night and came second in the other, so points,
    // firsts and seconds all match — they are genuinely level.
    const id = await season("published");
    const one = await night(id, "Fall Guys", new Date("2026-03-01T19:00:00Z"));
    const two = await night(id, "Codenames", new Date("2026-03-08T19:00:00Z"));
    const ana = await makeUser(db, { displayName: "Ana" });
    const ben = await makeUser(db, { displayName: "Ben" });
    for (const eventId of [one, two]) {
      for (const userId of [ana, ben]) {
        await db.insert(applications).values({ eventId, userId, status: "accepted" });
      }
    }
    await finished(one, [ana, ben]);
    await finished(two, [ben, ana]);

    const { standings } = await page(id);

    expect(standings.map((row) => row.position)).toEqual([1, 1]);
    expect(standings.every((row) => row.level)).toBe(true);
    expect(new Set(standings.map((row) => row.points))).toEqual(new Set([43]));
  });

  it("separates two level on points by most firsts", async () => {
    const id = await season("published", { pointsTable: [10, 7, 5, 4] });
    const one = await night(id, "Overwatch", new Date("2026-03-01T19:00:00Z"));
    const two = await night(id, "Rivals", new Date("2026-03-08T19:00:00Z"));
    const ana = await makeUser(db, { displayName: "Ana" });
    const ben = await makeUser(db, { displayName: "Ben" });
    const cal = await makeUser(db, { displayName: "Cal" });
    const dee = await makeUser(db, { displayName: "Dee" });
    for (const eventId of [one, two]) {
      for (const userId of [ana, ben, cal, dee]) {
        await db.insert(applications).values({ eventId, userId, status: "accepted" });
      }
    }
    // Ana: 1st then 4th = 14. Ben: 2nd then 2nd = 14. Ana has the first, so
    // she is ahead of him and neither is shown level.
    await finished(one, [ana, ben, cal, dee]);
    await finished(two, [cal, ben, dee, ana]);

    const { standings } = await page(id);

    expect(standings.map((row) => [row.name, row.position, row.points])).toEqual([
      ["Cal", 1, 15],
      ["Ana", 2, 14],
      ["Ben", 3, 14],
      ["Dee", 4, 9],
    ]);
    expect(standings.every((row) => row.level)).toBe(false);
  });

  it("says how many of how many results count", async () => {
    // UC-34 2d. Three nights, best two count: the third is played, not counted.
    const id = await season("published", { countBest: 2 });
    const nights = [
      await night(id, "Night A", new Date("2026-03-01T19:00:00Z")),
      await night(id, "Night B", new Date("2026-03-08T19:00:00Z")),
      await night(id, "Night C", new Date("2026-03-15T19:00:00Z")),
    ];
    const ana = await makeUser(db, { displayName: "Ana" });
    for (const eventId of nights) {
      await db.insert(applications).values({ eventId, userId: ana, status: "accepted" });
      await finished(eventId, [ana]);
    }

    const [row] = (await page(id)).standings;

    expect([row.counted, row.played]).toEqual([2, 3]);
    expect(row.points).toBe(50);
    expect(row.results.filter((result) => !result.counted)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-34 4 — where the points came from                               */
/* ------------------------------------------------------------------ */

describe("a player's season", () => {
  it("breaks the total down event by event, in the order they were played", async () => {
    const id = await season("published");
    const [amongUs] = await db
      .insert(games)
      .values({ key: `among-us-${(counter += 1)}`, name: "Among Us" })
      .returning({ id: games.id });

    const first = await night(id, "Week two", new Date("2026-03-08T19:00:00Z"));
    const second = await night(id, "Week one", new Date("2026-03-01T19:00:00Z"), {
      gameId: amongUs.id,
    });

    const ana = await makeUser(db, { displayName: "Ana" });
    for (const eventId of [first, second]) {
      await db.insert(applications).values({ eventId, userId: ana, status: "accepted" });
    }
    await finished(first, [ana]);
    await finished(second, [ana]);

    const { standings, counted } = await page(id);

    // Played order, not the alphabetical order `listCountingEvents` gives.
    expect(counted.map((event) => event.title)).toEqual(["Week one", "Week two"]);
    expect(counted.map((event) => event.gameName)).toEqual(["Among Us", null]);
    expect(standings[0].results.map((result) => result.eventId)).toEqual([second, first]);
    expect(standings[0].results.map((result) => result.position)).toEqual([1, 1]);
  });

  it("carries a team's place for everybody on the team", async () => {
    const id = await season("published");
    const eventId = await night(id, "Rivals night", new Date("2026-04-01T19:00:00Z"));
    const ana = await accepted(eventId, "Ana");
    const ben = await accepted(eventId, "Ben");
    const [red] = await db
      .insert(teams)
      .values({ eventId, name: "Rivals Red" })
      .returning({ id: teams.id });
    for (const userId of [ana, ben]) {
      await db.insert(teamMembers).values({ teamId: red.id, eventId, userId });
    }
    await finished(eventId, [red.id]);

    const { standings, counted } = await page(id);

    expect(standings.map((row) => [row.name, row.points])).toEqual([
      ["Ana", 25],
      ["Ben", 25],
    ]);
    // The winner reads as the team, which is what the night was won by.
    expect(counted[0].winners).toEqual(["Rivals Red"]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-34 2c — movement at the last event                              */
/* ------------------------------------------------------------------ */

describe("movement", () => {
  it("is how far the last counted event moved each player", async () => {
    const id = await season("published", { pointsTable: [10, 6, 4] });
    const one = await night(id, "Night one", new Date("2026-03-01T19:00:00Z"));
    const two = await night(id, "Night two", new Date("2026-03-08T19:00:00Z"));
    const ana = await makeUser(db, { displayName: "Ana" });
    const ben = await makeUser(db, { displayName: "Ben" });
    const cal = await makeUser(db, { displayName: "Cal" });
    for (const eventId of [one, two]) {
      for (const userId of [ana, ben, cal]) {
        await db.insert(applications).values({ eventId, userId, status: "accepted" });
      }
    }
    // After night one: Ana 10, Ben 6, Cal 4. After night two: Ana 16, Cal 14,
    // Ben 10 — Ana holds the lead, Cal comes up past Ben, Ben goes down one.
    await finished(one, [ana, ben, cal]);
    await finished(two, [cal, ana, ben]);

    const { standings, movedAt } = await page(id);

    expect(movedAt?.title).toBe("Night two");
    expect(standings.map((row) => [row.name, row.position, row.moved])).toEqual([
      ["Ana", 1, 0],
      ["Cal", 2, 1],
      ["Ben", 3, -1],
    ]);
  });

  it("is nothing at all when only one event has counted", async () => {
    const id = await season("published");
    const one = await night(id, "The only night", new Date("2026-03-01T19:00:00Z"));
    const ana = await accepted(one, "Ana");
    await finished(one, [ana]);

    const { standings, movedAt } = await page(id);

    expect(movedAt).toBeNull();
    expect(standings[0].moved).toBeNull();
  });

  it("leaves a player who first appeared at that event unmoved rather than risen", async () => {
    const id = await season("published");
    const one = await night(id, "Night one", new Date("2026-03-01T19:00:00Z"));
    const two = await night(id, "Night two", new Date("2026-03-08T19:00:00Z"));
    const ana = await accepted(one, "Ana");
    await db.insert(applications).values({ eventId: two, userId: ana, status: "accepted" });
    const new_ = await accepted(two, "Newcomer");
    await finished(one, [ana]);
    await finished(two, [new_, ana]);

    const { standings } = await page(id);

    // Ana was first before the night and is first after it, so she held
    // station; the newcomer has nowhere to have moved from.
    const newcomer = standings.find((row) => row.name === "Newcomer");
    expect([newcomer?.position, newcomer?.moved]).toEqual([2, null]);
    expect(standings.find((row) => row.name === "Ana")?.moved).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* UC-34 6, 2e — the season's events                                  */
/* ------------------------------------------------------------------ */

describe("the season's events", () => {
  it("splits them into the ones that counted and the ones still to come", async () => {
    const id = await season("published");
    const played = await night(id, "Played", new Date("2026-03-01T19:00:00Z"));
    await night(id, "Still to come", new Date("2026-09-01T19:00:00Z"));
    const ana = await accepted(played, "Ana");
    await finished(played, [ana]);

    const { counted, toCome } = await page(id);

    expect(counted.map((event) => [event.title, event.winners])).toEqual([["Played", ["Ana"]]]);
    expect(toCome.map((event) => event.title)).toEqual(["Still to come"]);
  });

  it("scores nobody for an event nobody has recorded a result on", async () => {
    // UC-34 2e. The event has accepted applicants, so the taking-part points
    // would otherwise be handed out for a night that has not been played.
    const id = await season("published", { participationPoints: 1 });
    const soon = await night(id, "Not yet played", new Date("2026-09-01T19:00:00Z"));
    await accepted(soon, "Ana");

    const { standings, counted, toCome } = await page(id);

    expect(standings).toEqual([]);
    expect(counted).toEqual([]);
    expect(toCome.map((event) => event.title)).toEqual(["Not yet played"]);
  });

  it("puts both names up when first place was shared", async () => {
    const id = await season("published");
    const eventId = await night(id, "A dead heat", new Date("2026-03-01T19:00:00Z"));
    const ana = await accepted(eventId, "Ana");
    const ben = await accepted(eventId, "Ben");
    const saved = await setPlacements(
      eventId,
      [
        { id: ana, position: 1 },
        { id: ben, position: 1 },
      ],
      db
    );
    if (!saved.ok) throw new Error(saved.error);

    const { counted } = await page(id);

    expect(new Set(counted[0].winners)).toEqual(new Set(["Ana", "Ben"]));
  });

  /*
   * R-177 on the public page. The flag is the page's only warning that the
   * table it prints further down is not the one these points came from, and
   * it has to reach both places a night is described: the events list, and the
   * line in a player's breakdown, which `StandingsTable` looks up by event id.
   */
  it("marks a night that scored off its own points table, counted or still to come", async () => {
    const id = await season("published");
    const own = await night(id, "Its own table", new Date("2026-03-01T19:00:00Z"));
    const seasons = await night(id, "The season's table", new Date("2026-03-08T19:00:00Z"));
    const later = await night(id, "Not played yet", new Date("2026-09-01T19:00:00Z"));
    for (const eventId of [own, later]) {
      const set = await setCountingEvent(eventId, { pointsTable: [50, 30] }, db);
      if (!set.ok) throw new Error(set.error);
    }

    const ana = await accepted(own, "Ana");
    await db.insert(applications).values({ eventId: seasons, userId: ana, status: "accepted" });
    await finished(own, [ana]);
    await finished(seasons, [ana]);

    const { counted, toCome, standings } = await page(id);

    // The events list — both lists, because a night still to come already
    // carries the table it will be scored with.
    expect(counted.map((event) => [event.title, event.ownTable])).toEqual([
      ["Its own table", true],
      ["The season's table", false],
    ]);
    expect(toCome.map((event) => [event.title, event.ownTable])).toEqual([
      ["Not played yet", true],
    ]);

    // The breakdown: every line is looked up in that same list by event id, so
    // the flag is there for the row that needs it — and the points prove the
    // marking is not decorative, 50 off the event's table against 25 off the
    // season's for the same first place.
    const byId = new Map(counted.map((event) => [event.eventId, event]));
    expect(
      standings[0].results.map((result) => [
        byId.get(result.eventId)?.ownTable,
        result.points,
      ])
    ).toEqual([
      [true, 50],
      [false, 25],
    ]);
  });

  it("leaves a night whose own table was cleared on the season's", async () => {
    // `setCountingEvent` stores an emptied table as null, and `resultsForEvent`
    // falls back when it has no rows: one way of saying "use the season's", and
    // the flag has to agree with it rather than with the column being present.
    const id = await season("published");
    const eventId = await night(id, "Changed its mind", new Date("2026-03-01T19:00:00Z"));
    for (const pointsTable of [[50, 30], []]) {
      const set = await setCountingEvent(eventId, { pointsTable }, db);
      if (!set.ok) throw new Error(set.error);
    }

    const ana = await accepted(eventId, "Ana");
    await finished(eventId, [ana]);

    const { counted, standings } = await page(id);

    expect(counted[0].ownTable).toBe(false);
    // And it really is the season's table paying: 25 for a first, not 50.
    expect(standings[0].points).toBe(25);
  });

  it("says nothing about a season with no counting events at all", async () => {
    const id = await season("published");

    const { standings, counted, toCome, movedAt } = await page(id);

    expect([standings, counted, toCome]).toEqual([[], [], []]);
    expect(movedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-35 3-4 — past seasons                                           */
/* ------------------------------------------------------------------ */

describe("finished seasons", () => {
  /** This season's line in the list, or undefined when it is not on it. */
  async function listed(seasonId: string) {
    const row = await getChampionship(seasonId, db);
    if (!row) throw new Error("no such season");
    return (await finishedSeasons(db)).find((entry) => entry.slug === row.slug);
  }

  it("lists a season once it is closed, with whoever took it", async () => {
    const id = await season("published");
    const eventId = await night(id, "The last night", new Date("2026-11-01T19:00:00Z"));
    const ana = await accepted(eventId, "Ana");
    const ben = await accepted(eventId, "Ben");
    await finished(eventId, [ana, ben]);

    // Still running: not a past season yet.
    expect(await listed(id)).toBeUndefined();

    await db.update(championships).set({ status: "closed" }).where(eq(championships.id, id));

    const row = await getChampionship(id, db);
    expect(await listed(id)).toEqual({
      slug: row?.slug,
      name: row?.name,
      runsFrom: null,
      runsTo: null,
      winners: ["Ana"],
    });
  });

  it("names nobody for a season that closed with nothing recorded", async () => {
    const id = await season("closed");

    expect((await listed(id))?.winners).toEqual([]);
  });
});

/* The rules in words moved to `championship-policy.test.ts` with the function
   that states them — they are a fact about the arithmetic, not about the read. */
