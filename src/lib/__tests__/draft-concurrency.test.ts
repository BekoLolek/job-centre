import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventConfig,
  draftBids,
  draftLots,
  events,
  teamMembers,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  getTeams,
  openLot,
  placeBid,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setTeams,
  voidLot,
} from "@/lib/draft";
import { applyToEvent, createEvent, publishEvent } from "@/lib/events";

/**
 * Two captains reaching for the same thing at the same moment.
 *
 * A draft has two races in it and they are different shapes:
 *
 *  1. **Two bids at once.** Under a document model — one blob holding
 *     `{captainId: amount}`, read, merged and written back, which is exactly
 *     how the current board stores them — the second write is computed from a
 *     copy that predates the first, so one captain's bid silently vanishes.
 *     That is not a hypothetical: it is the storage model this schema replaces,
 *     and the first control below reproduces it on demand.
 *  2. **Two awards at once.** "Read the lot, check it is open, write the
 *     winner, write the roster row" without a transaction can interleave into a
 *     draft whose lot says one team paid and whose roster says another team has
 *     the player. The second control reproduces that too.
 *
 * ## How this file forces the race rather than pretending to
 *
 * PGlite is a single connection, so two overlapping calls interleave at the
 * *statement* level: `Promise.all` starts A, and while A is awaiting its first
 * query, B's first query is issued. What PGlite does not interleave is
 * transactions — `client.transaction()` holds an exclusive lock for the whole
 * callback, exactly as a second Postgres connection would block on
 * `select … for update`.
 *
 * That combination is what makes the assertions meaningful, but only if the
 * overlap is real. Hence the controls: if the harness were quietly running
 * these in sequence, the controls would come out *correct* and this file would
 * fail rather than pass for the wrong reasons.
 */

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

type Fixture = {
  eventId: string;
  members: string[];
  teamIds: string[];
};

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/**
 * A published event with `teamCount` captained teams and everybody else in the
 * pool. Balances are deliberately small so an over-spend would be obvious.
 */
async function draftReady(teamCount: number, spare: number, balance = 1000): Promise<Fixture> {
  counter += 1;
  const created = await createEvent({ title: `Race ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);
  const eventId = created.data.id;

  const members: string[] = [];
  for (let index = 0; index < teamCount + spare; index += 1) {
    const userId = await makeUser(db);
    const applied = await applyToEvent(eventId, userId, {}, db);
    if (!applied.ok) throw new Error(applied.error);
    members.push(userId);
  }

  unwrap(await setDraftConfig(eventId, { defaultBalance: balance }, db));
  const written = unwrap(
    await setTeams(
      eventId,
      Array.from({ length: teamCount }, (_unused, index) => ({ name: `Team ${index + 1}` })),
      db
    )
  );
  unwrap(
    await setCaptains(
      eventId,
      written.teams.map((team, index) => ({ teamId: team.id, userId: members[index] })),
      db
    )
  );
  unwrap(await setDraftPool(eventId, {}, db));

  return { eventId, members, teamIds: written.teams.map((team) => team.id) };
}

async function bidsOn(lotId: string): Promise<Array<{ teamId: string; amount: number }>> {
  const rows = await db
    .select({ teamId: draftBids.teamId, amount: draftBids.amount })
    .from(draftBids)
    .where(eq(draftBids.lotId, lotId));
  return rows.sort((first, second) => second.amount - first.amount);
}

/* ------------------------------------------------------------------ */
/* Control 1 — the storage model this schema replaces                 */
/* ------------------------------------------------------------------ */

/**
 * Bidding the way the current board does it: one JSON document holding every
 * bid, read whole, merged, written back. `events.config` stands in for the blob
 * — the shape is what matters, not which column it lives in.
 */
async function naiveBlobBid(eventId: string, teamId: string, amount: number): Promise<void> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  const config = event.config as EventConfig & { bids?: Record<string, number> };
  const merged = { ...(config.bids ?? {}), [teamId]: amount };
  await db
    .update(events)
    .set({ config: { ...config, bids: merged } })
    .where(eq(events.id, eventId));
}

describe("the control — proving the race is really being run", () => {
  it("loses a bid when every bid lives in one document", async () => {
    const fixture = await draftReady(2, 1);
    const [a, b] = fixture.teamIds;

    await Promise.all([
      naiveBlobBid(fixture.eventId, a, 120),
      naiveBlobBid(fixture.eventId, b, 450),
    ]);

    const [event] = await db.select().from(events).where(eq(events.id, fixture.eventId));
    const stored = (event.config as { bids?: Record<string, number> }).bids ?? {};

    // Both read the document before either wrote it, so the second write was
    // computed from a copy with no bids in it at all. One captain's bid is
    // simply gone. If these calls had run in sequence there would be two keys
    // here, and every assertion below would prove nothing.
    expect(Object.keys(stored)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Bidding                                                            */
/* ------------------------------------------------------------------ */

describe("placeBid under concurrency", () => {
  it("keeps both bids when two teams bid at the same instant", async () => {
    const fixture = await draftReady(2, 1);
    const [a, b] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    const results = await Promise.all([
      placeBid(lot.id, a, 120, {}, db),
      placeBid(lot.id, b, 450, {}, db),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    expect(await bidsOn(lot.id)).toEqual([
      { teamId: b, amount: 450 },
      { teamId: a, amount: 120 },
    ]);
  });

  it("keeps all five when a whole draft bids at once", async () => {
    const fixture = await draftReady(5, 1);
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[5] }, db));

    const results = await Promise.all(
      fixture.teamIds.map((teamId, index) => placeBid(lot.id, teamId, index * 10, {}, db))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await bidsOn(lot.id)).toHaveLength(5);
  });

  it("turns a double-clicked sealed bid into one bid and one sentence", async () => {
    const fixture = await draftReady(2, 1);
    const [a] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    const results = await Promise.all([
      placeBid(lot.id, a, 100, {}, db),
      placeBid(lot.id, a, 900, {}, db),
    ]);

    // One goes in; the other is told, rather than tripping the unique index or
    // quietly overwriting a bid the captain thought was final.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.error).toMatch(/already bid/i);
    expect(await bidsOn(lot.id)).toHaveLength(1);
  });

  it("refuses a bid over the cap however it is timed against another one", async () => {
    // Both teams are inside their own cap, so the roster rule has to be applied
    // per team rather than to whichever transaction happened to be first.
    const fixture = await draftReady(2, 1, 100);
    const [a, b] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));

    const results = await Promise.all([
      placeBid(lot.id, a, 96, {}, db),
      placeBid(lot.id, b, 97, {}, db),
    ]);

    // Five slots left apiece, so four have to stay funded: 96 is the cap.
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(await bidsOn(lot.id)).toEqual([{ teamId: a, amount: 96 }]);
  });
});

/* ------------------------------------------------------------------ */
/* Control 2 — awarding without a transaction                         */
/* ------------------------------------------------------------------ */

/**
 * The version everybody writes first: read the lot, see that it is open, write
 * the winner, write the roster row. No transaction, no lock.
 */
async function naiveAward(lotId: string, teamId: string): Promise<void> {
  const [lot] = await db.select().from(draftLots).where(eq(draftLots.id, lotId));
  if (lot.status !== "open") return;
  const [bid] = await db
    .select()
    .from(draftBids)
    .where(and(eq(draftBids.lotId, lotId), eq(draftBids.teamId, teamId)));

  await db
    .update(draftLots)
    .set({ status: "awarded", winnerTeamId: teamId, price: bid.amount, closedAt: new Date() })
    .where(eq(draftLots.id, lotId));
  await db.insert(teamMembers).values({
    teamId,
    eventId: lot.eventId,
    userId: lot.playerUserId,
    price: bid.amount,
    lotId,
  });
}

describe("the control — awarding outside a transaction", () => {
  it("ends with the lot and the roster disagreeing about who bought the player", async () => {
    const fixture = await draftReady(2, 1);
    const [a, b] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 100, {}, db));
    unwrap(await placeBid(lot.id, b, 200, {}, db));

    // Both saw an open lot before either closed it. One of the roster inserts
    // is refused by the unique index — which is the only reason this is a
    // contradiction rather than a player on two teams.
    await Promise.allSettled([naiveAward(lot.id, a), naiveAward(lot.id, b)]);

    const [settled] = await db.select().from(draftLots).where(eq(draftLots.id, lot.id));
    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.lotId, lot.id));

    expect(settled.status).toBe("awarded");
    expect(rows).toHaveLength(1);
    // The money says one team; the roster says the other.
    expect(settled.winnerTeamId).not.toBe(rows[0].teamId);
  });
});

/* ------------------------------------------------------------------ */
/* Awarding                                                           */
/* ------------------------------------------------------------------ */

describe("awardLot under concurrency", () => {
  it("gives the player to exactly one of two simultaneous awards", async () => {
    const fixture = await draftReady(2, 1);
    const [a, b] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 100, {}, db));
    unwrap(await placeBid(lot.id, b, 200, {}, db));

    const results = await Promise.all([
      awardLot(lot.id, a, {}, db),
      awardLot(lot.id, b, {}, db),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.error).toMatch(/already settled/i);

    const [settled] = await db.select().from(draftLots).where(eq(draftLots.id, lot.id));
    const rows = await db.select().from(teamMembers).where(eq(teamMembers.lotId, lot.id));
    expect(rows).toHaveLength(1);
    // The lot and the roster now agree, which is the whole difference.
    expect(settled.winnerTeamId).toBe(rows[0].teamId);
  });

  it("deducts the price exactly once", async () => {
    const fixture = await draftReady(2, 1);
    const [a] = fixture.teamIds;
    const lot = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(lot.id, a, 350, {}, db));

    // The same admin, clicking twice.
    const results = await Promise.all([
      awardLot(lot.id, a, {}, db),
      awardLot(lot.id, a, {}, db),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);

    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    expect(team?.balance).toBe(650);
    expect(team?.members).toHaveLength(2);
  });

  it("does not let two teams spend on the same player through separate lots", async () => {
    const fixture = await draftReady(2, 2);
    const [a, b] = fixture.teamIds;

    // Only one lot can be open at a time, so two admins spinning at once end
    // with one lot, not two — which is what stops the double sale upstream of
    // any money changing hands.
    const opened = await Promise.all([
      openLot(fixture.eventId, { userId: fixture.members[2] }, db),
      openLot(fixture.eventId, { userId: fixture.members[3] }, db),
    ]);
    expect(opened.filter((result) => result.ok)).toHaveLength(1);

    const lot = opened.find((result) => result.ok);
    if (!lot?.ok) throw new Error("no lot opened");
    unwrap(await placeBid(lot.data.id, a, 10, {}, db));
    unwrap(await placeBid(lot.data.id, b, 20, {}, db));
    unwrap(await awardLot(lot.data.id, b, {}, db));

    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, lot.data.playerUserId));
    expect(rows).toHaveLength(1);
  });

  it("keeps an award and a simultaneous undo from crossing", async () => {
    const fixture = await draftReady(2, 2);
    const [a] = fixture.teamIds;
    const first = unwrap(await openLot(fixture.eventId, { userId: fixture.members[2] }, db));
    unwrap(await placeBid(first.id, a, 300, {}, db));

    const [awarded, undone] = await Promise.all([
      awardLot(first.id, a, {}, db),
      voidLot(first.id, {}, db),
    ]);

    // Whichever order they land in, the balance and the roster agree afterwards.
    const team = (await getTeams(fixture.eventId, db)).find((row) => row.id === a);
    const bought = team?.members.filter((member) => !member.isCaptain) ?? [];
    const spent = bought.reduce((total, member) => total + member.price, 0);
    expect(team?.balanceStart! - spent).toBe(team?.balance);
    expect(awarded.ok || undone.ok).toBe(true);
  });
});
