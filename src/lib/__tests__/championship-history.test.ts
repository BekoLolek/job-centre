import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  applications,
  championships,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { playerSeasons, seasonOfEvent } from "@/lib/championship-season";
import { addCountingEvent, createChampionship } from "@/lib/championships";
import { setPlacements } from "@/lib/championship-results";

/*
 * UC-36 4-5 — a player's championships, and where they finished in each, as a
 * visitor reads them off the profile.
 *
 * Nothing is asserted against a stored position, because there is no column
 * holding one: every figure here is `scoreChampionship` re-run over the
 * recorded places, exactly as the season's own page runs it. The last test in
 * the first block is the one that proves it — a correction to a night changes
 * a finished season's profile line with no write anywhere near the profile.
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
  scoring: { countBest?: number } = {}
): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `History ${counter}`, ...scoring }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

async function night(seasonId: string, startsAt: Date): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({
      slug: `history-${counter}`,
      title: `History night ${counter}`,
      status: "complete",
      startsAt,
    })
    .returning({ id: events.id });
  const added = await addCountingEvent(seasonId, row.id, db);
  if (!added.ok) throw new Error(added.error);
  return row.id;
}

async function accepted(eventId: string, userId: string): Promise<void> {
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
}

async function finished(eventId: string, order: string[]): Promise<void> {
  const saved = await setPlacements(
    eventId,
    order.map((id, index) => ({ id, position: index + 1 })),
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

async function slugOf(seasonId: string): Promise<string> {
  const [row] = await db
    .select({ slug: championships.slug })
    .from(championships)
    .where(eq(championships.id, seasonId));
  return row.slug;
}

async function close(seasonId: string): Promise<void> {
  await db.update(championships).set({ status: "closed" }).where(eq(championships.id, seasonId));
}

/* ------------------------------------------------------------------ */
/* UC-36 5 — the seasons, and where they finished                     */
/* ------------------------------------------------------------------ */

describe("a player's seasons", () => {
  it("gives a finished season's final position, and says it is final", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, new Date("2028-01-01T18:00:00Z"));
    const winner = await makeUser(db, { displayName: "Winner" });
    const second = await makeUser(db, { displayName: "Second" });
    await accepted(eventId, winner);
    await accepted(eventId, second);
    await finished(eventId, [winner, second]);
    await close(seasonId);

    const [mine] = await playerSeasons(second, db);

    expect(mine.position).toBe(2);
    expect(mine.points).toBe(18);
    expect(mine.level).toBe(false);
    expect(mine.finished).toBe(true);
    expect(mine.played).toBe(1);
    expect(mine.counted).toBe(1);
  });

  it("marks a season still being played as unfinished", async () => {
    // The difference between a result and a scoreboard: a running season's
    // position is where somebody stands, not where they came.
    const seasonId = await season();
    const eventId = await night(seasonId, new Date("2028-02-01T18:00:00Z"));
    const player = await makeUser(db, { displayName: "Still Playing" });
    await accepted(eventId, player);
    await finished(eventId, [player]);

    const [mine] = await playerSeasons(player, db);

    expect(mine.finished).toBe(false);
    expect(mine.position).toBe(1);
  });

  it("shows a shared position as level rather than picking one", async () => {
    const seasonId = await season();
    const one = await night(seasonId, new Date("2028-03-01T18:00:00Z"));
    const two = await night(seasonId, new Date("2028-03-08T18:00:00Z"));
    const ada = await makeUser(db, { displayName: "Level Ada" });
    const bo = await makeUser(db, { displayName: "Level Bo" });
    for (const eventId of [one, two]) {
      await accepted(eventId, ada);
      await accepted(eventId, bo);
    }
    await finished(one, [ada, bo]);
    await finished(two, [bo, ada]);

    const [mine] = await playerSeasons(ada, db);

    // A first and a second each — level on points and on countback (R-181).
    expect(mine.position).toBe(1);
    expect(mine.level).toBe(true);
  });

  it("says how many of their results count, of how many they played", async () => {
    const seasonId = await season("published", { countBest: 1 });
    const one = await night(seasonId, new Date("2028-04-01T18:00:00Z"));
    const two = await night(seasonId, new Date("2028-04-08T18:00:00Z"));
    const player = await makeUser(db, { displayName: "Best Of One" });
    for (const eventId of [one, two]) {
      await accepted(eventId, player);
      await finished(eventId, [player]);
    }

    const [mine] = await playerSeasons(player, db);

    expect(mine.played).toBe(2);
    expect(mine.counted).toBe(1);
  });

  it("follows a correction to a night played years ago", async () => {
    /*
     * The reason nothing here is stored. A closed season is frozen by refusing
     * writes, not by writing down a total — so an admin who reopens it, fixes
     * a place and closes it again changes what this profile says, with no
     * write anywhere near the profile.
     */
    const seasonId = await season();
    const eventId = await night(seasonId, new Date("2028-05-01T18:00:00Z"));
    const ada = await makeUser(db, { displayName: "Corrected Ada" });
    const bo = await makeUser(db, { displayName: "Corrected Bo" });
    await accepted(eventId, ada);
    await accepted(eventId, bo);
    await finished(eventId, [ada, bo]);
    expect((await playerSeasons(bo, db))[0].position).toBe(2);

    await finished(eventId, [bo, ada]);

    expect((await playerSeasons(bo, db))[0].position).toBe(1);
  });

  it("lists the seasons newest first", async () => {
    const player = await makeUser(db, { displayName: "Veteran" });
    const older = await season();
    const newer = await season();
    for (const seasonId of [older, newer]) {
      const eventId = await night(seasonId, new Date("2028-06-01T18:00:00Z"));
      await accepted(eventId, player);
      await finished(eventId, [player]);
    }

    const mine = await playerSeasons(player, db);

    expect(mine.map((row) => row.slug)).toEqual([await slugOf(newer), await slugOf(older)]);
  });
});

/* ------------------------------------------------------------------ */
/* What a profile must never show                                     */
/* ------------------------------------------------------------------ */

describe("what a profile leaves out", () => {
  it("says nothing about a hidden season (R-189)", async () => {
    // A hidden season is an admin's draft. A public profile listing one tells
    // every visitor it exists, which is the one thing the status is for.
    const seasonId = await season("hidden");
    const eventId = await night(seasonId, new Date("2028-07-01T18:00:00Z"));
    const player = await makeUser(db, { displayName: "Secret Season Player" });
    await accepted(eventId, player);
    await finished(eventId, [player]);

    expect(await playerSeasons(player, db)).toEqual([]);
  });

  it("says nothing about a season whose events have no result yet", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, new Date("2028-08-01T18:00:00Z"));
    const player = await makeUser(db, { displayName: "Not Scored Yet" });
    await accepted(eventId, player);

    expect(await playerSeasons(player, db)).toEqual([]);
  });

  it("is empty for somebody who has never played in one", async () => {
    const stranger = await makeUser(db, { displayName: "Stranger" });

    expect(await playerSeasons(stranger, db)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The lookup both announcements share                                */
/* ------------------------------------------------------------------ */

describe("seasonOfEvent", () => {
  it("gives the season row an event counts towards, slug and all", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, new Date("2028-09-01T18:00:00Z"));

    const row = await seasonOfEvent(eventId, db);

    expect(row?.id).toBe(seasonId);
    expect(row?.slug).toBeTruthy();
    expect(row?.status).toBe("published");
  });

  it("gives null for an event that counts towards nothing", async () => {
    counter += 1;
    const [row] = await db
      .insert(events)
      .values({ slug: `lonely-${counter}`, title: "Lonely night", status: "complete" })
      .returning({ id: events.id });

    expect(await seasonOfEvent(row.id, db)).toBeNull();
  });
});
