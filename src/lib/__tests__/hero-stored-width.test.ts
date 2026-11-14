import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handCards, loadDraw } from "@/app/events/[slug]/draw/draw";
import { type Database, games, heroHands, heroes } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { MIGRATIONS_FOLDER } from "@/db/migrate";
import {
  applyToEvent,
  createEvent,
  getEventBySlug,
  publishEvent,
  setApplicationStatus,
  updateEvent,
} from "@/lib/events";
import { dealFor, handFor } from "@/lib/hero-hands";
import { HERO_ROLES } from "@/lib/heroes";

/**
 * Task 144 — a hand dealt at one width stays exactly as dealt (R-271 / UC-58
 * 7, 7a), through the real writes and the real reads.
 *
 * Two databases, for the reason `src/db/__tests__/hero-hands-width.test.ts`
 * gives: `shipped` is every journalled migration, where the nine is still on
 * the table and three is the only width that can be stored; `later` has the
 * drop in `drizzle/later` applied, and is the only place a hand of six can be
 * dealt at all.
 *
 * It lives here rather than beside `draw-page.test.ts` because that folder is
 * another task's while this one is in flight; `loadDraw` needs no session and
 * no render, so nothing is lost by asking it from outside.
 */

let shipped: TestDatabase;
let later: TestDatabase;

beforeAll(async () => {
  shipped = await freshDatabase();
  later = await freshDatabase();
  const drop = readFileSync(path.join(MIGRATIONS_FOLDER, "later", "hero_hands_drop_nine.sql"), "utf8");
  await later.client.exec(drop);
});

afterAll(async () => {
  await shipped.close();
  await later.close();
});

let counter = 0;

type Fixture = { eventId: string; slug: string; userId: string };

/**
 * An event that deals `width` in each role, a game holding `pool` heroes in
 * each, and a member with a seat — reached through the real writes, as
 * `draw-page.test.ts` reaches it.
 */
async function fixture(db: Database, width: number, pool: number): Promise<Fixture> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({ key: `stored-width-${counter}`, name: `Stored width ${counter}` })
    .returning({ id: games.id });
  await db.insert(heroes).values(
    HERO_ROLES.flatMap((role) =>
      Array.from({ length: pool }, (_unused, index) => ({
        gameId: game.id,
        name: `${role} ${index + 1} of ${counter}`,
        roles: [role],
      }))
    )
  );

  const created = await createEvent(
    {
      title: `Stored width ${counter}`,
      gameId: game.id,
      capacity: 8,
      ...PUBLISHABLE,
      config: { eventShape: { heroesPerRole: width } },
    },
    db
  );
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);

  const userId = await makeUser(db, { displayName: `Width player ${counter}` });
  const applied = await applyToEvent(created.data.id, userId, {}, db);
  if (!applied.ok) throw new Error(applied.error);
  const decided = await setApplicationStatus(applied.data.id, "accepted", {}, db);
  if (!decided.ok) throw new Error(decided.error);

  return { eventId: created.data.id, slug: created.data.slug, userId };
}

async function setWidth(db: Database, eventId: string, width: number): Promise<void> {
  const saved = await updateEvent(eventId, { config: { eventShape: { heroesPerRole: width } } }, db);
  if (!saved.ok) throw new Error(saved.error);
}

/** The stored array itself, so "unchanged" is asked of the row and not of a read of it. */
async function storedIds(db: Database, eventId: string): Promise<string[]> {
  const [row] = await db.select().from(heroHands).where(eq(heroHands.eventId, eventId));
  return row.heroIds;
}

async function deal(db: Database, fix: Fixture) {
  const dealt = await dealFor(fix.eventId, fix.userId, undefined, db);
  if (!dealt.ok) throw new Error(dealt.error);
  return dealt.hand;
}

/** A generator that must never be reached: a second deal would call it. */
function thrower(): number {
  throw new Error("something dealt when a hand was already held");
}

async function payloadFor(db: Database, fix: Fixture) {
  const event = await getEventBySlug(fix.slug, {}, db);
  if (!event) throw new Error("no event");
  return loadDraw(event, fix.userId, handFor, db);
}

describe("a hand dealt at one width, after the event's number changes (R-271)", () => {
  it.each([[1], [5]])("is the same nine when three becomes %i", async (width) => {
    const fix = await fixture(shipped.db, 3, 6);
    const dealt = await deal(shipped.db, fix);
    const ids = await storedIds(shipped.db, fix.eventId);

    await setWidth(shipped.db, fix.eventId, width);

    expect(ids).toHaveLength(9);
    expect(await storedIds(shipped.db, fix.eventId)).toEqual(ids);
    expect(await handFor(fix.eventId, fix.userId, shipped.db)).toEqual(dealt);
    expect(await dealFor(fix.eventId, fix.userId, thrower, shipped.db)).toEqual({
      ok: true,
      hand: dealt,
      alreadyHeld: true,
    });
  });

  it("is the same six when two becomes three, once a six can be stored", async () => {
    const fix = await fixture(later.db, 2, 6);
    const dealt = await deal(later.db, fix);
    const ids = await storedIds(later.db, fix.eventId);

    await setWidth(later.db, fix.eventId, 3);

    expect(ids).toHaveLength(6);
    expect(await storedIds(later.db, fix.eventId)).toEqual(ids);
    expect(await handFor(fix.eventId, fix.userId, later.db)).toEqual(dealt);
    expect(await dealFor(fix.eventId, fix.userId, thrower, later.db)).toEqual({
      ok: true,
      hand: dealt,
      alreadyHeld: true,
    });
  });
});

describe("the draw page, for somebody who already holds a hand", () => {
  /**
   * Found by Task 142's review. The pools hold four in each role: enough for
   * the three this hand was dealt at, too thin for the five the event asks
   * for now. The thinness is a fact about the **next** deal, and this player
   * is not getting one — so it must not stand between them and their nine.
   */
  it("shows the nine they hold when the event now asks for more than the list can deal", async () => {
    const fix = await fixture(shipped.db, 3, 4);
    const dealt = await deal(shipped.db, fix);

    await setWidth(shipped.db, fix.eventId, 5);
    const payload = await payloadFor(shipped.db, fix);

    expect(payload).toMatchObject({ kind: "ready", hand: handCards(dealt.heroes) });
  });

  /**
   * The screen's sentence counts the hand ("9 were decided and written down"),
   * so beside a stored hand the count is the hand's own and not the event's.
   */
  it.each([[1], [5]])(
    "says three in each role beside a stored nine, though the event now says %i",
    async (width) => {
      const fix = await fixture(shipped.db, 3, 6);
      await deal(shipped.db, fix);

      await setWidth(shipped.db, fix.eventId, width);
      const payload = await payloadFor(shipped.db, fix);

      expect(payload).toMatchObject({ kind: "ready", perRole: 3 });
    }
  );

  it("shows a stored six as six, two in each role, though the event now says three", async () => {
    const fix = await fixture(later.db, 2, 6);
    const dealt = await deal(later.db, fix);

    await setWidth(later.db, fix.eventId, 3);
    const payload = await payloadFor(later.db, fix);

    expect(payload).toMatchObject({ kind: "ready", perRole: 2, hand: handCards(dealt.heroes) });
    expect(handCards(dealt.heroes)).toHaveLength(6);
  });

  /**
   * The other side of the same line: with no hand the thinness check is still
   * asked, at the event's width, and nothing is dealt to find out.
   */
  it("still refuses a thin list to somebody who holds nothing", async () => {
    const fix = await fixture(shipped.db, 5, 4);

    const payload = await payloadFor(shipped.db, fix);

    expect(payload.kind).toBe("too_thin");
    expect(await handFor(fix.eventId, fix.userId, shipped.db)).toBeNull();
  });
});
