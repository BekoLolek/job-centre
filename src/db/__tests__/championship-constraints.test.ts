import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { championshipEvents, championshipPlacements, championships, events, teams } from "@/db";
import { type TestDatabase, expectRejection, freshDatabase, makeUser } from "./helpers";

/**
 * What Postgres itself guarantees about a season.
 *
 * One of these is load-bearing rather than tidy: **an event belongs to at most
 * one championship** — the last Constraint in `docs/requirements.md` rather
 * than a numbered requirement, and UC-32 1a in the flows. Two admins adding the
 * same event to two seasons at once is a race no screen can see, and an event
 * counting twice would score its players twice.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

async function makeChampionship(
  over: Partial<typeof championships.$inferInsert> = {}
): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(championships)
    .values({ slug: `season-${counter}`, name: `Season ${counter}`, ...over })
    .returning({ id: championships.id });
  return row.id;
}

async function makeEvent(): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(events)
    .values({ slug: `champ-event-${counter}`, title: `Champ event ${counter}` })
    .returning({ id: events.id });
  return row.id;
}

async function makeCountingEvent(
  championshipId: string,
  eventId: string,
  over: Partial<typeof championshipEvents.$inferInsert> = {}
): Promise<string> {
  const [row] = await ctx.db
    .insert(championshipEvents)
    .values({ championshipId, eventId, ...over })
    .returning({ id: championshipEvents.id });
  return row.id;
}

describe("a counting event", () => {
  it("refuses an event that already counts for another championship", async () => {
    const eventId = await makeEvent();
    await makeCountingEvent(await makeChampionship(), eventId);

    await expectRejection(
      async () => makeCountingEvent(await makeChampionship(), eventId),
      /championship_events_event_uniq/
    );
  });

  it("refuses the same event twice in one championship", async () => {
    const championshipId = await makeChampionship();
    const eventId = await makeEvent();
    await makeCountingEvent(championshipId, eventId);

    await expectRejection(
      async () => makeCountingEvent(championshipId, eventId),
      /championship_events_event_uniq/
    );
  });

  it("refuses a weight of zero or less", async () => {
    const championshipId = await makeChampionship();
    await expectRejection(
      async () => makeCountingEvent(championshipId, await makeEvent(), { weight: 0 }),
      /championship_events_weight_positive/
    );
  });
});

describe("a placement", () => {
  it("lets two subjects share a position and leaves the next one empty", async () => {
    const countingEventId = await makeCountingEvent(await makeChampionship(), await makeEvent());
    const rows = await ctx.db
      .insert(championshipPlacements)
      .values([
        { championshipEventId: countingEventId, position: 1, userId: await makeUser(ctx.db) },
        { championshipEventId: countingEventId, position: 1, userId: await makeUser(ctx.db) },
        { championshipEventId: countingEventId, position: 3, userId: await makeUser(ctx.db) },
      ])
      .returning({ position: championshipPlacements.position });

    expect(rows.map((row) => row.position)).toEqual([1, 1, 3]);
  });

  it("refuses the same member twice in one event's order", async () => {
    const countingEventId = await makeCountingEvent(await makeChampionship(), await makeEvent());
    const userId = await makeUser(ctx.db);
    await ctx.db
      .insert(championshipPlacements)
      .values({ championshipEventId: countingEventId, position: 1, userId });

    await expectRejection(
      () =>
        ctx.db
          .insert(championshipPlacements)
          .values({ championshipEventId: countingEventId, position: 2, userId }),
      /championship_placements_event_user_uniq/
    );
  });

  it("refuses the same team twice in one event's order", async () => {
    const eventId = await makeEvent();
    const countingEventId = await makeCountingEvent(await makeChampionship(), eventId);
    const [team] = await ctx.db
      .insert(teams)
      .values({ eventId, name: "Reds" })
      .returning({ id: teams.id });
    await ctx.db
      .insert(championshipPlacements)
      .values({ championshipEventId: countingEventId, position: 1, teamId: team.id });

    await expectRejection(
      () =>
        ctx.db
          .insert(championshipPlacements)
          .values({ championshipEventId: countingEventId, position: 2, teamId: team.id }),
      /championship_placements_event_team_uniq/
    );
  });

  it("refuses a place with nobody in it, and one with two subjects", async () => {
    const eventId = await makeEvent();
    const countingEventId = await makeCountingEvent(await makeChampionship(), eventId);
    const [team] = await ctx.db
      .insert(teams)
      .values({ eventId, name: "Blues" })
      .returning({ id: teams.id });

    await expectRejection(
      () =>
        ctx.db
          .insert(championshipPlacements)
          .values({ championshipEventId: countingEventId, position: 1 }),
      /championship_placements_one_subject/
    );
    await expectRejection(
      async () =>
        ctx.db.insert(championshipPlacements).values({
          championshipEventId: countingEventId,
          position: 1,
          userId: await makeUser(ctx.db),
          teamId: team.id,
        }),
      /championship_placements_one_subject/
    );
  });

  it("refuses a position below first", async () => {
    const countingEventId = await makeCountingEvent(await makeChampionship(), await makeEvent());
    await expectRejection(
      async () =>
        ctx.db.insert(championshipPlacements).values({
          championshipEventId: countingEventId,
          position: 0,
          userId: await makeUser(ctx.db),
        }),
      /championship_placements_position_positive/
    );
  });
});

describe("a championship", () => {
  it("refuses a second open season with the same name, and allows a finished one", async () => {
    await makeChampionship({ name: "Winter 2026", status: "published" });

    await expectRejection(
      () => makeChampionship({ name: "Winter 2026" }),
      /championships_open_name_uniq/
    );

    // Last winter is on the record and keeps its name; this winter may reuse it
    // once that one is closed.
    await ctx.db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.name, "Winter 2026"));
    await expect(makeChampionship({ name: "Winter 2026" })).resolves.toBeTypeOf("string");
  });

  it("refuses a season that ends before it starts", async () => {
    await expectRejection(
      () => makeChampionship({ runsFrom: "2026-09-01", runsTo: "2026-03-01" }),
      /championships_months_ordered/
    );
  });

  it("refuses a run that is not whole months", async () => {
    // A season runs March to November, not March 3rd to November 17th.
    await expectRejection(
      () => makeChampionship({ runsFrom: "2026-03-03", runsTo: "2026-11-01" }),
      /championships_months_are_first/
    );
    await expectRejection(
      () => makeChampionship({ runsFrom: "2026-03-01", runsTo: "2026-11-17" }),
      /championships_months_are_first/
    );
    await expect(
      makeChampionship({ runsFrom: "2026-03-01", runsTo: "2026-11-01" })
    ).resolves.toBeTypeOf("string");
  });

  it("refuses a negative taking-part value and a best-of-none", async () => {
    await expectRejection(
      () => makeChampionship({ participationPoints: -1 }),
      /championships_participation_positive/
    );
    await expectRejection(
      () => makeChampionship({ countBest: 0 }),
      /championships_count_best_positive/
    );
  });
});
