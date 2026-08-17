import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, matchGames, matches, stages, teams } from "@/db";
import { type TestDatabase, expectRejection, freshDatabase } from "./helpers";

/**
 * What Postgres itself guarantees about the Phase 4 tables.
 *
 * `src/lib/format.ts` maintains these too, and its own tests check that it
 * does. These are the second line — and two of them are load-bearing rather
 * than tidy: a match cannot name a team from another event, and a series cannot
 * have an even number of games. The first is the mistake a stale admin form
 * would otherwise make silently; the second would produce a series nobody can
 * win.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

async function makeEvent(): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(events)
    .values({ slug: `format-event-${counter}`, title: `Format event ${counter}` })
    .returning({ id: events.id });
  return row.id;
}

async function makeTeam(eventId: string): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(teams)
    .values({ eventId, name: `Team ${counter}` })
    .returning({ id: teams.id });
  return row.id;
}

async function makeStage(
  eventId: string,
  over: Partial<typeof stages.$inferInsert> = {}
): Promise<string> {
  const [row] = await ctx.db
    .insert(stages)
    .values({ eventId, kind: "double_elim", ...over })
    .returning({ id: stages.id });
  return row.id;
}

async function makeMatch(
  stageId: string,
  eventId: string,
  over: Partial<typeof matches.$inferInsert> = {}
): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(matches)
    .values({ stageId, eventId, slot: over.slot ?? `slot-${counter}`, ...over })
    .returning({ id: matches.id });
  return row.id;
}

describe("stages", () => {
  it("accepts every format the engine knows", async () => {
    const eventId = await makeEvent();
    for (const kind of [
      "round_robin",
      "single_elim",
      "double_elim",
      "swiss",
      "group_playoff",
    ] as const) {
      await expect(makeStage(eventId, { kind })).resolves.toBeTruthy();
    }
  });

  it("refuses a format outside the enum", async () => {
    const eventId = await makeEvent();
    await expectRejection(
      () => ctx.client.query(`insert into stages (event_id, kind) values ($1, 'ladder')`, [eventId]),
      /invalid input value|stage_kind/i
    );
  });

  it("stores its config as jsonb without double-parsing a scalar", async () => {
    const eventId = await makeEvent();
    const id = await makeStage(eventId, { config: { bestOf: 3, bracketReset: false, note: "1234567890123456789" } });
    const [row] = await ctx.db.select().from(stages).where(eq(stages.id, id));
    expect(row.config).toEqual({ bestOf: 3, bracketReset: false, note: "1234567890123456789" });
  });

  it("goes with its event", async () => {
    const eventId = await makeEvent();
    await makeStage(eventId);
    await ctx.db.delete(events).where(eq(events.id, eventId));
    expect(await ctx.db.select().from(stages).where(eq(stages.eventId, eventId))).toHaveLength(0);
  });
});

describe("matches", () => {
  it("cannot share a slot within one stage", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    await makeMatch(stageId, eventId, { slot: "gf" });
    await expectRejection(
      () => makeMatch(stageId, eventId, { slot: "gf" }),
      /matches_stage_slot_uniq/
    );
  });

  it("may share a slot across two stages of the same event", async () => {
    const eventId = await makeEvent();
    const first = await makeStage(eventId);
    const second = await makeStage(eventId, { sort: 1 });
    await makeMatch(first, eventId, { slot: "gf" });
    await expect(makeMatch(second, eventId, { slot: "gf" })).resolves.toBeTruthy();
  });

  it("refuses a team from another event — the whole point of the redundant event_id", async () => {
    const mine = await makeEvent();
    const theirs = await makeEvent();
    const stageId = await makeStage(mine);
    const intruder = await makeTeam(theirs);
    await expectRejection(
      () => makeMatch(stageId, mine, { teamAId: intruder }),
      /matches_team_a_event_fk/
    );
  });

  it("refuses an override naming a team from another event", async () => {
    const mine = await makeEvent();
    const theirs = await makeEvent();
    const stageId = await makeStage(mine);
    const intruder = await makeTeam(theirs);
    await expectRejection(
      () => makeMatch(stageId, mine, { winnerOverrideId: intruder }),
      /matches_winner_override_event_fk/
    );
  });

  it("refuses a stage from another event", async () => {
    const mine = await makeEvent();
    const theirs = await makeEvent();
    const stageId = await makeStage(theirs);
    await expectRejection(
      () => makeMatch(stageId, mine, { slot: "x" }),
      /matches_stage_event_fk/
    );
  });

  it("refuses an even series length", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    await expect(makeMatch(stageId, eventId, { bestOf: 5 })).resolves.toBeTruthy();
    await expectRejection(
      () => makeMatch(stageId, eventId, { bestOf: 4 }),
      /matches_best_of_odd/
    );
    await expectRejection(
      () => makeMatch(stageId, eventId, { bestOf: 0 }),
      /matches_best_of_odd/
    );
  });

  it("refuses a team playing itself", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const teamId = await makeTeam(eventId);
    await expectRejection(
      () => makeMatch(stageId, eventId, { teamAId: teamId, teamBId: teamId }),
      /matches_distinct_teams/
    );
  });

  it("refuses a duration that is not a duration", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    await expectRejection(
      () => makeMatch(stageId, eventId, { durationMin: 0 }),
      /matches_duration_positive/
    );
  });

  it("refuses to delete a team that has played, but lets the event go", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const teamId = await makeTeam(eventId);
    await makeMatch(stageId, eventId, { teamAId: teamId });

    await expectRejection(
      () => ctx.db.delete(teams).where(eq(teams.id, teamId)),
      /matches_team_a_event_fk/
    );

    // The whole event still goes in one statement, results and all — the teams
    // and the matches disappear together, so nothing is left orphaned.
    await ctx.db.delete(events).where(eq(events.id, eventId));
    expect(await ctx.db.select().from(matches).where(eq(matches.eventId, eventId))).toHaveLength(0);
  });

  it("goes with its stage", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const matchId = await makeMatch(stageId, eventId);
    await ctx.db.delete(stages).where(eq(stages.id, stageId));
    expect(await ctx.db.select().from(matches).where(eq(matches.id, matchId))).toHaveLength(0);
  });
});

describe("match_games", () => {
  it("is called match_games, because `games` is the admin catalogue", async () => {
    const result = await ctx.client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('games', 'match_games')
       order by table_name`
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(["games", "match_games"]);
  });

  it("cannot have two games at the same position in a series", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const matchId = await makeMatch(stageId, eventId, { bestOf: 3 });
    await ctx.db.insert(matchGames).values({ matchId, index: 0, mode: "convoy" });
    await expectRejection(
      () => ctx.db.insert(matchGames).values({ matchId, index: 0, mode: "domination" }),
      /match_games_match_index_uniq/
    );
  });

  it("refuses a negative position or a negative score", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const matchId = await makeMatch(stageId, eventId);
    await expectRejection(
      () => ctx.db.insert(matchGames).values({ matchId, index: -1 }),
      /match_games_index_positive/
    );
    await expectRejection(
      () => ctx.db.insert(matchGames).values({ matchId, index: 1, scoreA: -1 }),
      /match_games_scores_positive/
    );
  });

  it("takes any mode name, since modes belong to the game and not to an enum", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const matchId = await makeMatch(stageId, eventId);
    await expect(
      ctx.db.insert(matchGames).values({ matchId, index: 0, mode: "escort" })
    ).resolves.toBeTruthy();
  });

  it("goes with its match", async () => {
    const eventId = await makeEvent();
    const stageId = await makeStage(eventId);
    const matchId = await makeMatch(stageId, eventId);
    await ctx.db.insert(matchGames).values({ matchId, index: 0 });
    await ctx.db.delete(matches).where(eq(matches.id, matchId));
    expect(
      await ctx.db.select().from(matchGames).where(eq(matchGames.matchId, matchId))
    ).toHaveLength(0);
  });
});
