import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftBids,
  draftConfigs,
  draftLots,
  draftPoolEntries,
  events,
  teamMembers,
  teams,
} from "@/db";
import { type TestDatabase, expectRejection, freshDatabase, makeUser } from "./helpers";

/**
 * What Postgres itself guarantees about the Phase 3 tables.
 *
 * `src/lib/draft.ts` maintains these invariants too, and its own tests check
 * that it does. These are the second line: if a future change to that module
 * gets the money wrong, or an admin screen writes a row directly, the database
 * still refuses. Two of them are load-bearing rather than tidy — nobody on two
 * teams, and at most one player on the block — because both are races a screen
 * cannot see and only a constraint can actually stop.
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
    .values({ slug: `draft-event-${counter}`, title: `Draft event ${counter}` })
    .returning({ id: events.id });
  return row.id;
}

async function makeTeam(
  eventId: string,
  over: { name?: string; captainUserId?: string | null; balanceStart?: number } = {}
): Promise<string> {
  counter += 1;
  const [row] = await ctx.db
    .insert(teams)
    .values({
      eventId,
      name: over.name ?? `Team ${counter}`,
      captainUserId: over.captainUserId ?? null,
      balanceStart: over.balanceStart ?? 1000,
    })
    .returning({ id: teams.id });
  return row.id;
}

async function makeLot(
  eventId: string,
  playerUserId: string,
  over: Partial<typeof draftLots.$inferInsert> = {}
): Promise<string> {
  const [row] = await ctx.db
    .insert(draftLots)
    .values({ eventId, playerUserId, ...over })
    .returning({ id: draftLots.id });
  return row.id;
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/* ------------------------------------------------------------------ */

describe("teams", () => {
  it("refuses two teams with the same name in one event", async () => {
    const eventId = await makeEvent();
    await makeTeam(eventId, { name: "Alpha" });
    await expectRejection(
      () => ctx.db.insert(teams).values({ eventId, name: "Alpha" }),
      /teams_event_name_uniq/
    );
  });

  it("lets two events both have an Alpha", async () => {
    const first = await makeEvent();
    const second = await makeEvent();
    await makeTeam(first, { name: "Alpha" });
    await expect(makeTeam(second, { name: "Alpha" })).resolves.toBeTruthy();
  });

  it("refuses one person captaining two teams in the same event", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    await makeTeam(eventId, { captainUserId: userId });
    await expectRejection(
      () => ctx.db.insert(teams).values({ eventId, name: "Second", captainUserId: userId }),
      /teams_event_captain_uniq/
    );
  });

  it("lets any number of teams sit without a captain", async () => {
    const eventId = await makeEvent();
    await makeTeam(eventId);
    await makeTeam(eventId);
    const rows = await ctx.db.select().from(teams).where(eq(teams.eventId, eventId));
    expect(rows.filter((row) => row.captainUserId === null)).toHaveLength(2);
  });

  it("refuses a negative starting balance", async () => {
    const eventId = await makeEvent();
    await expectRejection(
      () => ctx.db.insert(teams).values({ eventId, name: "Broke", balanceStart: -1 }),
      /teams_balance_start_positive/
    );
  });

  it("keeps a team when its captain's account is deleted", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    const teamId = await makeTeam(eventId, { captainUserId: userId });

    await ctx.client.query("delete from users where id = $1", [userId]);
    const [row] = await ctx.db.select().from(teams).where(eq(teams.id, teamId));
    expect(row.captainUserId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Rosters                                                            */
/* ------------------------------------------------------------------ */

describe("team_members", () => {
  it("refuses a roster row whose event is not its team's", async () => {
    const first = await makeEvent();
    const second = await makeEvent();
    const teamId = await makeTeam(first);
    const userId = await makeUser(ctx.db);

    // The composite key is the whole point of carrying `event_id` here: it
    // makes the redundant column provably the team's own.
    await expectRejection(
      () => ctx.db.insert(teamMembers).values({ teamId, eventId: second, userId }),
      /team_members_team_event_fk|foreign key/
    );
  });

  it("refuses the same player on two teams in one event", async () => {
    const eventId = await makeEvent();
    const alpha = await makeTeam(eventId);
    const bravo = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);

    await ctx.db.insert(teamMembers).values({ teamId: alpha, eventId, userId, price: 100 });
    await expectRejection(
      () => ctx.db.insert(teamMembers).values({ teamId: bravo, eventId, userId, price: 50 }),
      /team_members_event_user_uniq/
    );
  });

  it("lets the same player be on a team in each of two events", async () => {
    const first = await makeEvent();
    const second = await makeEvent();
    const userId = await makeUser(ctx.db);

    await ctx.db
      .insert(teamMembers)
      .values({ teamId: await makeTeam(first), eventId: first, userId });
    await expect(
      ctx.db.insert(teamMembers).values({ teamId: await makeTeam(second), eventId: second, userId })
    ).resolves.toBeTruthy();
  });

  it("refuses a captain who cost something", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);

    // §14: a captain fills a slot and is never bought.
    await expectRejection(
      () =>
        ctx.db
          .insert(teamMembers)
          .values({ teamId, eventId, userId, price: 10, isCaptain: true }),
      /team_members_captain_is_free/
    );
  });

  it("refuses a negative price", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);
    await expectRejection(
      () => ctx.db.insert(teamMembers).values({ teamId, eventId, userId, price: -5 }),
      /team_members_price_positive/
    );
  });

  it("takes the roster with the team", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(teamMembers).values({ teamId, eventId, userId });

    await ctx.db.delete(teams).where(eq(teams.id, teamId));
    const rows = await ctx.db.select().from(teamMembers).where(eq(teamMembers.eventId, eventId));
    expect(rows).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The pool                                                           */
/* ------------------------------------------------------------------ */

describe("draft_pool_entries", () => {
  it("keeps a player in exactly one pool", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    await ctx.db.insert(draftPoolEntries).values({ eventId, userId, kind: "main" });

    await expectRejection(
      () => ctx.db.insert(draftPoolEntries).values({ eventId, userId, kind: "reserve" }),
      /draft_pool_entries_event_user_uniq/
    );

    // Moving between pools is an update of one column, which is the reason
    // these are rows rather than two ordered arrays.
    await ctx.db
      .update(draftPoolEntries)
      .set({ kind: "reserve" })
      .where(eq(draftPoolEntries.userId, userId));
    const [row] = await ctx.db
      .select()
      .from(draftPoolEntries)
      .where(eq(draftPoolEntries.userId, userId));
    expect(row.kind).toBe("reserve");
  });
});

/* ------------------------------------------------------------------ */
/* Lots                                                               */
/* ------------------------------------------------------------------ */

describe("draft_lots", () => {
  it("allows only one open lot per event", async () => {
    const eventId = await makeEvent();
    const first = await makeUser(ctx.db);
    const second = await makeUser(ctx.db);
    await makeLot(eventId, first);

    await expectRejection(
      () => ctx.db.insert(draftLots).values({ eventId, playerUserId: second }),
      /draft_lots_one_open_per_event/
    );
  });

  it("allows any number of settled lots", async () => {
    const eventId = await makeEvent();
    for (let index = 0; index < 3; index += 1) {
      await makeLot(eventId, await makeUser(ctx.db), {
        status: "discarded",
        closedAt: new Date(),
      });
    }
    const rows = await ctx.db.select().from(draftLots).where(eq(draftLots.eventId, eventId));
    expect(rows).toHaveLength(3);
  });

  it("refuses an award with no winner or no price", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);

    await expectRejection(
      () =>
        ctx.db
          .insert(draftLots)
          .values({ eventId, playerUserId: userId, status: "awarded", price: 100 }),
      /draft_lots_award_complete/
    );
    await expectRejection(
      () =>
        ctx.db
          .insert(draftLots)
          .values({ eventId, playerUserId: userId, status: "awarded", winnerTeamId: teamId }),
      /draft_lots_award_complete/
    );
  });

  it("refuses a winner from another event", async () => {
    const mine = await makeEvent();
    const theirs = await makeEvent();
    const stranger = await makeTeam(theirs);
    const userId = await makeUser(ctx.db);

    await expectRejection(
      () =>
        ctx.db.insert(draftLots).values({
          eventId: mine,
          playerUserId: userId,
          status: "awarded",
          winnerTeamId: stranger,
          price: 10,
        }),
      /draft_lots_winner_event_fk|foreign key/
    );
  });

  it("refuses a negative price", async () => {
    const eventId = await makeEvent();
    const playerUserId = await makeUser(ctx.db);
    await expectRejection(
      () =>
        ctx.db
          .insert(draftLots)
          .values({ eventId, playerUserId, status: "discarded", price: -1 }),
      /draft_lots_price_positive/
    );
  });

  it("insists a voided lot carries the moment it was voided, and vice versa", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);

    await expectRejection(
      () =>
        ctx.db.insert(draftLots).values({ eventId, playerUserId: userId, status: "voided" }),
      /draft_lots_voided_stamped/
    );
    await expectRejection(
      () =>
        ctx.db.insert(draftLots).values({
          eventId,
          playerUserId: userId,
          status: "discarded",
          voidedAt: new Date(),
        }),
      /draft_lots_voided_stamped/
    );
  });

  it("keeps the winner and the price on a voided lot, so the undo leaves a trace", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const userId = await makeUser(ctx.db);
    const lotId = await makeLot(eventId, userId, {
      status: "awarded",
      winnerTeamId: teamId,
      price: 250,
      closedAt: new Date(),
    });

    await ctx.db
      .update(draftLots)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(draftLots.id, lotId));

    const [row] = await ctx.db.select().from(draftLots).where(eq(draftLots.id, lotId));
    expect(row).toMatchObject({ status: "voided", winnerTeamId: teamId, price: 250 });
  });

  it("refuses to delete a team that has won a lot", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    await makeLot(eventId, await makeUser(ctx.db), {
      status: "awarded",
      winnerTeamId: teamId,
      price: 40,
      closedAt: new Date(),
    });

    // `setTeams` refuses this too, with a sentence. This is the backstop, and
    // it is what stops a price being erased by a delete nobody thought about.
    await expectRejection(
      () => ctx.db.delete(teams).where(eq(teams.id, teamId)),
      /foreign key|draft_lots_winner_event_fk/
    );
  });
});

describe("draft_bids", () => {
  it("keeps one bid per team per lot", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const lotId = await makeLot(eventId, await makeUser(ctx.db));

    await ctx.db.insert(draftBids).values({ lotId, teamId, amount: 100 });
    await expectRejection(
      () => ctx.db.insert(draftBids).values({ lotId, teamId, amount: 200 }),
      /draft_bids_lot_team_uniq/
    );
  });

  it("refuses a negative bid", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const lotId = await makeLot(eventId, await makeUser(ctx.db));
    await expectRejection(
      () => ctx.db.insert(draftBids).values({ lotId, teamId, amount: -1 }),
      /draft_bids_amount_positive/
    );
  });

  it("takes the bids with the lot", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const lotId = await makeLot(eventId, await makeUser(ctx.db));
    await ctx.db.insert(draftBids).values({ lotId, teamId, amount: 10 });

    await ctx.db.delete(draftLots).where(eq(draftLots.id, lotId));
    expect(await ctx.db.select().from(draftBids).where(eq(draftBids.lotId, lotId))).toHaveLength(0);
  });
});

describe("draft_configs", () => {
  it("holds one row per event", async () => {
    const eventId = await makeEvent();
    await ctx.db.insert(draftConfigs).values({ eventId });
    await expectRejection(
      () => ctx.db.insert(draftConfigs).values({ eventId }),
      /draft_configs_event_id_unique/
    );
  });

  it("refuses rules that cannot mean anything", async () => {
    const eventId = await makeEvent();
    await expectRejection(
      () => ctx.db.insert(draftConfigs).values({ eventId, rosterTarget: 0 }),
      /draft_configs_roster_target_positive/
    );
    await expectRejection(
      () => ctx.db.insert(draftConfigs).values({ eventId, minIncrement: 0 }),
      /draft_configs_increment_positive/
    );
    await expectRejection(
      () => ctx.db.insert(draftConfigs).values({ eventId, bidTimerSeconds: 0 }),
      /draft_configs_timer_positive/
    );
    await expectRejection(
      () => ctx.db.insert(draftConfigs).values({ eventId, defaultBalance: -1 }),
      /draft_configs_balance_positive/
    );
  });
});

/* ------------------------------------------------------------------ */
/* Cascades                                                           */
/* ------------------------------------------------------------------ */

describe("deleting an event", () => {
  it("takes its whole draft with it, awarded lots and all", async () => {
    const eventId = await makeEvent();
    const teamId = await makeTeam(eventId);
    const captain = await makeUser(ctx.db);
    const player = await makeUser(ctx.db);

    await ctx.db.insert(draftConfigs).values({ eventId });
    await ctx.db.insert(draftPoolEntries).values({ eventId, userId: player });
    await ctx.db
      .insert(teamMembers)
      .values({ teamId, eventId, userId: captain, isCaptain: true });
    const lotId = await makeLot(eventId, player, {
      status: "awarded",
      winnerTeamId: teamId,
      price: 70,
      closedAt: new Date(),
    });
    await ctx.db.insert(draftBids).values({ lotId, teamId, amount: 70 });

    await ctx.db.delete(events).where(eq(events.id, eventId));

    expect(await ctx.db.select().from(teams).where(eq(teams.eventId, eventId))).toHaveLength(0);
    expect(
      await ctx.db.select().from(teamMembers).where(eq(teamMembers.eventId, eventId))
    ).toHaveLength(0);
    expect(
      await ctx.db.select().from(draftLots).where(eq(draftLots.eventId, eventId))
    ).toHaveLength(0);
    expect(await ctx.db.select().from(draftBids).where(eq(draftBids.lotId, lotId))).toHaveLength(0);
    expect(
      await ctx.db.select().from(draftPoolEntries).where(eq(draftPoolEntries.eventId, eventId))
    ).toHaveLength(0);
    expect(
      await ctx.db.select().from(draftConfigs).where(eq(draftConfigs.eventId, eventId))
    ).toHaveLength(0);
  });
});
