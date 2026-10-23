import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, games, heroHands, heroes, users } from "@/db";
import { HERO_ROLES } from "@/lib/heroes";
import { HEROES_PER_ROLE } from "@/lib/heroes-policy";
import { type TestDatabase, expectRejection, freshDatabase } from "./helpers";

/**
 * What Postgres itself guarantees about a stored hand (R-212 / UC-39 3b, 4a).
 *
 * One of these is the requirement rather than hygiene. **`hero_hands_event_user
 * _uniq` is R-212**: "my draw happens once and stands" is a claim about a pair,
 * and `src/lib/hero-hands.ts` does not guard its write — it attempts it and
 * reads the conflict as its answer. So if this constraint is not on the table,
 * a second deal does not conflict, `returning()` comes back with a row, and
 * `dealFor` reports a fresh hand over the top of the one already stored. Every
 * test in `hero-hands.test.ts` about two clicks is testing code that this
 * constraint is holding up.
 *
 * The cases that insert through raw SQL do so where the point is a value
 * TypeScript would not let a caller write — a NULL element, eight ids, a
 * repeat inside one role. A guard only the type system holds is not a guard on
 * the database, and `dealFor` is not the only thing that could ever write here.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

type Fixture = { eventId: string; userId: string; heroIds: string[] };

/**
 * An event, a member, and nine distinct hero rows to name.
 *
 * Real `heroes` rows rather than invented uuids, because the tests below are
 * about the shape of the array and a reader should not have to wonder whether a
 * literal uuid is standing in for a hero that exists.
 */
async function fixture(): Promise<Fixture> {
  counter += 1;
  const [game] = await ctx.db
    .insert(games)
    .values({ key: `hand-game-${counter}`, name: `Hand game ${counter}` })
    .returning({ id: games.id });
  const [event] = await ctx.db
    .insert(events)
    .values({
      slug: `hand-event-${counter}`,
      title: `Hand event ${counter}`,
      gameId: game.id,
      status: "draft",
    })
    .returning({ id: events.id });
  const [user] = await ctx.db
    .insert(users)
    .values({
      discordId: `hand-user-${counter}`,
      displayName: `Hand player ${counter}`,
      name: `Hand player ${counter}`,
      email: `hand-${counter}@example.test`,
    })
    .returning({ id: users.id });

  const rows = await ctx.db
    .insert(heroes)
    .values(
      Array.from({ length: 9 }, (_unused, index) => ({
        gameId: game.id,
        name: `Hand hero ${counter}-${index}`,
        roles: ["Duelist" as const],
      }))
    )
    .returning({ id: heroes.id });

  return { eventId: event.id, userId: user.id, heroIds: rows.map((row) => row.id) };
}

/** Insert a hand with this array literal exactly as written, past TypeScript. */
function insertRaw(fix: Fixture, idsLiteral: string): Promise<unknown> {
  return ctx.client.query(
    `insert into hero_hands (event_id, user_id, hero_ids) values ($1, $2, ${idsLiteral})`,
    [fix.eventId, fix.userId]
  );
}

/** `'{a,b,c}'` — an array literal, uncast, so the column coerces it itself. */
function literal(ids: readonly string[]): string {
  return `'{${ids.join(",")}}'`;
}

describe("one hand per participant per event", () => {
  /**
   * R-212, and the reason `dealFor` may attempt its write rather than guard it.
   *
   * The second insert is the *same* nine, which is the case a reader might
   * think the constraint does not need to cover — it does: "dealt once" is
   * about the pair, not about the contents, and a reroll arriving with a hand
   * that happens to match is still a second row.
   */
  it("refuses a second hand for the same (event, user)", async () => {
    const fix = await fixture();
    await ctx.db.insert(heroHands).values({ ...fix });

    await expectRejection(
      () => insertRaw(fix, literal(fix.heroIds)),
      /hero_hands_event_user_uniq|duplicate key/
    );

    expect(
      await ctx.db.select().from(heroHands).where(eq(heroHands.eventId, fix.eventId))
    ).toHaveLength(1);
  });

  it("lets the same member hold a hand at each of two events", async () => {
    const first = await fixture();
    const second = await fixture();
    await ctx.db.insert(heroHands).values({ ...first });
    await ctx.db.insert(heroHands).values({
      eventId: second.eventId,
      userId: first.userId,
      heroIds: second.heroIds,
    });

    const rows = await ctx.db
      .select({ eventId: heroHands.eventId })
      .from(heroHands)
      .where(eq(heroHands.userId, first.userId));
    expect(rows.map((row) => row.eventId).sort()).toEqual(
      [first.eventId, second.eventId].sort()
    );
  });

  it("lets two members each hold a hand at one event", async () => {
    const first = await fixture();
    const second = await fixture();
    await ctx.db.insert(heroHands).values({ ...first });
    await ctx.db.insert(heroHands).values({
      eventId: first.eventId,
      userId: second.userId,
      heroIds: first.heroIds,
    });

    expect(
      await ctx.db.select().from(heroHands).where(eq(heroHands.eventId, first.eventId))
    ).toHaveLength(2);
  });
});

describe("the nine ids", () => {
  it("accepts nine distinct ids", async () => {
    const fix = await fixture();
    const [row] = await ctx.db
      .insert(heroHands)
      .values({ ...fix })
      .returning({ heroIds: heroHands.heroIds, dealtAt: heroHands.dealtAt });
    expect(row.heroIds).toEqual(fix.heroIds);
    expect(row.dealtAt).toBeInstanceOf(Date);
  });

  it("refuses eight, and refuses ten", async () => {
    const short = await fixture();
    await expectRejection(
      () => insertRaw(short, literal(short.heroIds.slice(0, 8))),
      /hero_hands_nine_distinct_per_role/
    );

    const long = await fixture();
    await expectRejection(
      () => insertRaw(long, literal([...long.heroIds, long.heroIds[0]])),
      /hero_hands_nine_distinct_per_role/
    );
  });

  it("refuses an empty array", async () => {
    const fix = await fixture();
    await expectRejection(() => insertRaw(fix, `'{}'`), /hero_hands_nine_distinct_per_role/);
  });

  /**
   * The separate half of the check, and not decoration.
   *
   * `null <> null` is NULL rather than false, and a CHECK counts NULL as
   * satisfied — so a NULL element would pass every inequality in the
   * constraint. `array_position(..., null) is null` is what refuses it, and
   * this is the case that tells the two halves apart: nine elements, all the
   * inequalities true of the ones that are real.
   */
  it("refuses a NULL element even though there are nine of them", async () => {
    const fix = await fixture();
    const withNull = [...fix.heroIds.slice(0, 8), "null"];
    await expectRejection(
      () => insertRaw(fix, `'{${withNull.join(",")}}'`),
      /hero_hands_nine_distinct_per_role/
    );
  });

  it("refuses a NULL array", async () => {
    const fix = await fixture();
    await expectRejection(() => insertRaw(fix, "null"), /null value in column "hero_ids"|not-null/);
  });
});

describe("distinct within a role, repeating across them", () => {
  /**
   * UC-39 4a's first half, in the database: a player's three in a role are
   * distinct from each other, because dealing somebody the same hero twice is a
   * wasted roll.
   *
   * Each role's triple is tested in its own right. A constraint that only
   * checked the first three would pass a test that only looked at the first
   * three, and the three triples are nine separate inequalities that could each
   * be mistyped.
   */
  it.each([
    ["Vanguard", 0],
    ["Duelist", HEROES_PER_ROLE],
    ["Strategist", HEROES_PER_ROLE * 2],
  ])("refuses the same hero twice inside %s", async (_role, offset) => {
    const fix = await fixture();
    const ids = [...fix.heroIds];
    ids[offset + 1] = ids[offset];
    await expectRejection(() => insertRaw(fix, literal(ids)), /hero_hands_nine_distinct_per_role/);
  });

  /**
   * UC-39 4a's other half and UC-40 3c's consequence: **Deadpool**.
   *
   * A hero playable in more than one role may be dealt in more than one of a
   * player's role-sets, so the same id appears twice in the array at positions
   * in different triples. A constraint forbidding a repeat anywhere would
   * refuse a legal hand — which is why this test is here and is not the
   * inverse of the one above.
   */
  it("accepts one hero in two different roles", async () => {
    const fix = await fixture();
    const ids = [...fix.heroIds];
    // The Vanguard slot's hero, dealt again as a Duelist.
    ids[HEROES_PER_ROLE] = ids[0];

    const [row] = await ctx.db
      .insert(heroHands)
      .values({ ...fix, heroIds: ids })
      .returning({ heroIds: heroHands.heroIds });
    expect(row.heroIds[0]).toBe(row.heroIds[HEROES_PER_ROLE]);
  });

  it("accepts one hero in all three roles", async () => {
    const fix = await fixture();
    const ids = [...fix.heroIds];
    ids[HEROES_PER_ROLE] = ids[0];
    ids[HEROES_PER_ROLE * 2] = ids[0];

    const [row] = await ctx.db
      .insert(heroHands)
      .values({ ...fix, heroIds: ids })
      .returning({ heroIds: heroHands.heroIds });
    expect(new Set(row.heroIds).size).toBe(7);
  });
});

describe("a hand's row", () => {
  it("goes when its event goes", async () => {
    const fix = await fixture();
    await ctx.db.insert(heroHands).values({ ...fix });

    await ctx.db.delete(events).where(eq(events.id, fix.eventId));

    expect(
      await ctx.db.select().from(heroHands).where(eq(heroHands.eventId, fix.eventId))
    ).toEqual([]);
  });

  it("goes when its member goes", async () => {
    const fix = await fixture();
    await ctx.db.insert(heroHands).values({ ...fix });

    await ctx.db.delete(users).where(eq(users.id, fix.userId));

    expect(
      await ctx.db.select().from(heroHands).where(eq(heroHands.userId, fix.userId))
    ).toEqual([]);
  });

  it("cannot name an event or a member that is not there", async () => {
    const fix = await fixture();
    await expectRejection(
      () =>
        ctx.client.query(
          `insert into hero_hands (event_id, user_id, hero_ids)
             values (gen_random_uuid(), $1, ${literal(fix.heroIds)})`,
          [fix.userId]
        ),
      /hero_hands_event_id_events_id_fk|foreign key/
    );
    await expectRejection(
      () =>
        ctx.client.query(
          `insert into hero_hands (event_id, user_id, hero_ids)
             values ($1, gen_random_uuid(), ${literal(fix.heroIds)})`,
          [fix.eventId]
        ),
      /hero_hands_user_id_users_id_fk|foreign key/
    );
  });

  /**
   * The check says `9` as a literal because a CHECK constraint cannot import a
   * constant. This is the one place the literal and the code's `HERO_ROLES
   * .length * HEROES_PER_ROLE` can be compared, so a fourth role cannot leave
   * the two disagreeing in silence — the constraint would start refusing every
   * hand the draw deals, and nothing else in the suite would say why.
   *
   * Read out of `information_schema` rather than asserted as arithmetic: the
   * point is the number the live constraint is enforcing, not the number this
   * file believes it wrote.
   */
  it("checks the hand size the code deals", async () => {
    const result = await ctx.client.query<{ check_clause: string }>(
      `select check_clause from information_schema.check_constraints
         where constraint_name = 'hero_hands_nine_distinct_per_role'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].check_clause).toContain(
      `= ${HERO_ROLES.length * HEROES_PER_ROLE}`
    );
  });

  it("is indexed by event, for the read that lists every hand at one", async () => {
    const result = await ctx.client.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'hero_hands'`
    );
    const names = result.rows.map((row) => row.indexname);
    expect(names).toContain("hero_hands_event_idx");
    expect(names).toContain("hero_hands_event_user_uniq");
  });
});
