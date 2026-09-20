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
import { DEFAULT_POINTS_TABLE, MAX_POINTS_PLACES } from "@/lib/championship-policy";
import {
  createChampionship,
  getChampionship,
  listChampionships,
  setChampionshipStatus,
  unscoredCountingEvents,
  updateChampionship,
} from "@/lib/championships";

/*
 * UC-31 (set a season up) and UC-35 (end it), against a real in-memory
 * Postgres. Everything here goes through the write layer rather than through
 * the actions, so the rules are tested where they live — the actions' own file
 * covers who did it and what the log says.
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

/** A season name nothing else in this file has used — the open-name index is unique. */
function aName(): string {
  counter += 1;
  return `Season ${counter}`;
}

/** A season in the given status, made the way an admin would and then moved. */
async function seasonIn(status: ChampionshipStatusValue): Promise<string> {
  const made = await createChampionship({ name: aName() }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db
      .update(championships)
      .set({ status })
      .where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

/** A counting event on this season, optionally with somebody placed in it. */
async function countingEvent(
  championshipId: string,
  title: string,
  scored: boolean
): Promise<void> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({ slug: `counting-${counter}`, title, status: "complete" })
    .returning({ id: events.id });
  const [row] = await db
    .insert(championshipEvents)
    .values({ championshipId, eventId: event.id })
    .returning({ id: championshipEvents.id });
  if (scored) {
    await db.insert(championshipPlacements).values({
      championshipEventId: row.id,
      position: 1,
      userId: await makeUser(db),
    });
  }
}

/* ------------------------------------------------------------------ */
/* UC-31 1-4: setting one up                                          */
/* ------------------------------------------------------------------ */

describe("creating a championship", () => {
  it("saves it hidden, with the default points table and a slug", async () => {
    // UC-31 1-3.
    const name = aName();

    const result = await createChampionship(
      { name, description: "Two events a month.", runsFrom: "2026-03", runsTo: "2026-11" },
      db
    );

    expect(result.ok).toBe(true);
    const row = result.ok ? result.data : null;
    expect(row?.status).toBe("hidden");
    expect(row?.pointsTable).toEqual(DEFAULT_POINTS_TABLE);
    expect(row?.participationPoints).toBe(0);
    expect(row?.countBest).toBeNull();
    expect(row?.slug).toBe(`season-${name.split(" ")[1]}`);
  });

  it("stores the months as the first of the month", async () => {
    const result = await createChampionship(
      { name: aName(), runsFrom: "2026-03", runsTo: "2026-11" },
      db
    );

    expect(result.ok && result.data.runsFrom).toBe("2026-03-01");
    expect(result.ok && result.data.runsTo).toBe("2026-11-01");
  });

  it("refuses a season with no name, and saves nothing", async () => {
    // UC-31 1a.
    const before = (await listChampionships(db)).length;

    const result = await createChampionship({ name: "   " }, db);

    expect(result).toEqual({ ok: false, error: "Give the championship a name." });
    expect((await listChampionships(db)).length).toBe(before);
  });

  it("refuses a season that ends before it starts, and saves nothing", async () => {
    // UC-31 1a.
    const before = (await listChampionships(db)).length;

    const result = await createChampionship(
      { name: aName(), runsFrom: "2026-11", runsTo: "2026-03" },
      db
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("A season cannot end before it starts.");
    expect((await listChampionships(db)).length).toBe(before);
  });

  it("refuses a second open season with the same name", async () => {
    const name = aName();
    expect((await createChampionship({ name }, db)).ok).toBe(true);

    const again = await createChampionship({ name }, db);

    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toContain(name);
  });

  it("tells the admin who loses a race for a name the same thing", async () => {
    /*
     * Both calls check the name before either inserts, so both pass the check
     * and Postgres refuses the loser. Without the catch around the insert that
     * refusal reaches the browser as an unhandled error and the screen says
     * "Could not reach the server" — which is wrong, and invites a retry that
     * will fail identically.
     */
    const name = aName();

    const [first, second] = await Promise.all([
      createChampionship({ name }, db),
      createChampionship({ name }, db),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(!loser.ok && loser.error).toBe(`There is already a season called "${name}".`);
  });
});

describe("the scoring rules", () => {
  it("saves a points table, what taking part is worth and how many count", async () => {
    // UC-31 3, 3a, 4.
    const id = await seasonIn("hidden");

    const result = await updateChampionship(
      id,
      { pointsTable: [30, 20, 10, 5], participationPoints: 2, countBest: 8 },
      db
    );

    expect(result.ok).toBe(true);
    const row = await getChampionship(id, db);
    expect(row?.pointsTable).toEqual([30, 20, 10, 5]);
    expect(row?.participationPoints).toBe(2);
    expect(row?.countBest).toBe(8);
  });

  it("refuses a place worth more than the one above it", async () => {
    // UC-31 3b.
    const id = await seasonIn("hidden");

    const result = await updateChampionship(id, { pointsTable: [10, 12, 5] }, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "2nd place is worth more than 1st: the table must not go up as you finish lower."
    );
    expect((await getChampionship(id, db))?.pointsTable).toEqual(DEFAULT_POINTS_TABLE);
  });

  it("refuses taking part being worth more than last place", async () => {
    // UC-31 4a.
    const id = await seasonIn("hidden");

    const result = await updateChampionship(
      id,
      { pointsTable: [10, 5, 2], participationPoints: 3 },
      db
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "Taking part cannot be worth more than last place in the table, which is 2."
    );
  });

  it("refuses a place that is not a whole number of points", async () => {
    const id = await seasonIn("hidden");

    const result = await updateChampionship(id, { pointsTable: [10, 2.5, 1] }, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/whole number/);
  });

  it("refuses a points table that is not a list of places", async () => {
    // A server action is a public endpoint; the payload is whatever was sent,
    // and `"abc".entries()` is a TypeError, not a refusal.
    const id = await seasonIn("hidden");

    const result = await updateChampionship(
      id,
      { pointsTable: "abc" as unknown as number[] },
      db
    );

    expect(result).toEqual({
      ok: false,
      error: "The points table has to be a list of places, worth most first.",
    });
  });

  it("refuses a points table longer than the cap", async () => {
    const id = await seasonIn("hidden");

    const result = await updateChampionship(
      id,
      { pointsTable: Array.from({ length: MAX_POINTS_PLACES + 1 }, () => 1) },
      db
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      `A points table cannot have more than ${MAX_POINTS_PLACES} places.`
    );
  });

  it("saves a points table exactly at the cap", async () => {
    const id = await seasonIn("hidden");

    const result = await updateChampionship(
      id,
      { pointsTable: Array.from({ length: MAX_POINTS_PLACES }, () => 1) },
      db
    );

    expect(result.ok).toBe(true);
  });

  it("refuses counting the best zero results", async () => {
    // UC-31 3a, and the column's own check.
    const id = await seasonIn("hidden");

    const result = await updateChampionship(id, { countBest: 0 }, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/1 or more/);
  });
});

/* ------------------------------------------------------------------ */
/* The lifecycle — docs/diagrams/championship-state.md                */
/* ------------------------------------------------------------------ */

const STATUSES: ChampionshipStatusValue[] = ["hidden", "published", "closed"];
const ALLOWED = new Set(["hidden>published", "published>hidden", "published>closed", "closed>published"]);
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => ({ from, to })));

describe("the lifecycle", () => {
  it.each(PAIRS)("$from to $to", async ({ from, to }) => {
    const id = await seasonIn(from);

    const result = await setChampionshipStatus(id, from, to, {}, db);

    expect(result.ok).toBe(ALLOWED.has(`${from}>${to}`));
    expect((await getChampionship(id, db))?.status).toBe(result.ok ? to : from);
  });

  it("refuses a move from a status the season no longer has", async () => {
    const id = await seasonIn("published");

    const result = await setChampionshipStatus(id, "hidden", "published", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("The championship changed meanwhile - reload.");
  });

  it("refuses to publish a season with no name, naming what is missing", async () => {
    counter += 1;
    const [row] = await db
      .insert(championships)
      .values({ slug: `nameless-${counter}`, name: "" })
      .returning({ id: championships.id });

    const result = await setChampionshipStatus(row.id, "hidden", "published", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "This championship cannot be published yet. It still needs a name."
    );
  });

  it("refuses to publish a season with no points table, naming what is missing", async () => {
    const id = await seasonIn("hidden");
    expect((await updateChampionship(id, { pointsTable: [] }, db)).ok).toBe(true);

    const result = await setChampionshipStatus(id, "hidden", "published", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      "This championship cannot be published yet. It still needs a points table."
    );
  });

  it("refuses to reopen onto a name an open season already holds", async () => {
    const name = aName();
    const closed = await seasonIn("closed");
    await db.update(championships).set({ name }).where(eq(championships.id, closed));
    expect((await createChampionship({ name }, db)).ok).toBe(true);

    const result = await setChampionshipStatus(closed, "closed", "published", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(name);
  });
});

/* ------------------------------------------------------------------ */
/* UC-35: ending the season                                           */
/* ------------------------------------------------------------------ */

describe("closing the season", () => {
  it("closes a published season with every counting event scored", async () => {
    // UC-35 1-2.
    const id = await seasonIn("published");
    await countingEvent(id, "Rivals night", true);

    const result = await setChampionshipStatus(id, "published", "closed", {}, db);

    expect(result.ok).toBe(true);
    expect((await getChampionship(id, db))?.status).toBe("closed");
  });

  it("names the counting events with no result and refuses until confirmed", async () => {
    // UC-35 1a.
    const id = await seasonIn("published");
    await countingEvent(id, "Rivals night", true);
    await countingEvent(id, "Jackbox evening", false);

    const result = await setChampionshipStatus(id, "published", "closed", {}, db);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(
      '"Jackbox evening" has no result yet. Close the season anyway?'
    );
    expect(!result.ok && result.unscored).toEqual([
      { eventId: expect.any(String), title: "Jackbox evening" },
    ]);
    expect((await getChampionship(id, db))?.status).toBe("published");
  });

  it("closes once the admin confirms", async () => {
    // UC-35 1a, confirmed.
    const id = await seasonIn("published");
    await countingEvent(id, "Jackbox evening", false);

    const result = await setChampionshipStatus(id, "published", "closed", { confirm: true }, db);

    expect(result.ok).toBe(true);
    expect((await getChampionship(id, db))?.status).toBe("closed");
  });

  it("lists only the counting events with nothing recorded", async () => {
    const id = await seasonIn("published");
    await countingEvent(id, "Scored one", true);
    await countingEvent(id, "Empty one", false);

    const unscored = await unscoredCountingEvents(id, db);

    expect(unscored.map((row) => row.title)).toEqual(["Empty one"]);
  });
});

describe("the lock on a closed season", () => {
  it("refuses an edit while it is closed, with the message UC-35 2b asks for", async () => {
    const id = await seasonIn("closed");

    const result = await updateChampionship(id, { participationPoints: 1 }, db);

    expect(result).toEqual({
      ok: false,
      error: "This championship is finished - reopen it to change it",
    });
    expect((await getChampionship(id, db))?.participationPoints).toBe(0);
  });

  it("lets edits through again once it is reopened", async () => {
    // UC-35 2a.
    const id = await seasonIn("closed");

    const reopened = await setChampionshipStatus(id, "closed", "published", {}, db);
    const edit = await updateChampionship(id, { participationPoints: 1 }, db);

    expect(reopened.ok).toBe(true);
    expect(edit.ok).toBe(true);
    expect((await getChampionship(id, db))?.participationPoints).toBe(1);
  });
});
