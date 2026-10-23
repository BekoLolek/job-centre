import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type Hero,
  events as eventsTable,
  games,
  heroHands,
  heroes as heroesTable,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  HAND_EVENT_GONE,
  HAND_NOT_STORED,
  HAND_NO_GAME,
  HAND_SIZE,
  dealFor,
  handFor,
} from "@/lib/hero-hands";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { HEROES_PER_ROLE } from "@/lib/heroes-policy";

/**
 * Storing a hand: dealt once, and it stands (R-212 / UC-39 3a, 3b, 5a, 6a).
 *
 * `heroes-policy.test.ts` proves *which* nine with no database in sight. This
 * file proves the four things only a real Postgres can answer.
 *
 *  - **That the nine the policy returned are the nine that land**, in the order
 *    that makes position mean a role, and that they come back out that way.
 *  - **That a second click deals nothing.** Proved by handing the second call a
 *    generator that throws: a deal that rolls at all fails the test, which is
 *    the only way to tell "returned the stored hand" from "dealt an identical
 *    one".
 *  - **That two clicks in the same instant store one hand**, sequenced rather
 *    than raced, with the two callers dealing *different* nines so that "both
 *    see the same hand" is a claim about the code and not about luck.
 *  - **That every refusal leaves no hand at all** — UC-39 5a, and
 *    `docs/decisions/004-refusals-inside-transactions.md` inverted: a stored
 *    hand reported as not stored would be the same lie the other way round.
 *
 * ## No seed sweep
 *
 * Every draw here is a pinned sequence through `fromList`, and the expected
 * nine are written out. `docs/plan.md`'s Plan hygiene has the measurement:
 * `seeded`'s first output spans only 0.2361-0.3519 for every seed 0-299, so
 * `floor(x * 4)` is only ever 0 or 1 and a 300-seed sweep explores two of four
 * first swaps — a sweep of exactly that shape survived a deleted guard in Task
 * 74. A sequence this file wrote down cannot do that.
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

/* ------------------------------------------------------------------ */
/* Generators                                                         */
/* ------------------------------------------------------------------ */

/** The numbers, in order, and a throw if the draw wants more than were given. */
function fromList(draws: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (index >= draws.length) {
      throw new Error("the deal asked for more numbers than the test gave it");
    }
    return draws[index++];
  };
}

/** A generator that must never be reached. */
function thrower(): () => number {
  return () => {
    throw new Error("the deal rolled when it should not have dealt at all");
  };
}

/**
 * Two sequences over a four-hero pool, and the nine each one deals.
 *
 * `shuffled` is Fisher-Yates from the back and skips the last iteration, so a
 * pool of four burns exactly three numbers and the three roles burn nine in
 * `HERO_ROLES` order — Vanguard, then Duelist, then Strategist. Both the role
 * order and the count are what these literals are pinning: a change to either
 * moves the hand, which is the point.
 *
 * Worked for `A`'s Duelist triple, since one of them should be: the pool is
 * [D1, D2, D3, D4]; `0.9` puts `floor(0.9 * 4) = 3` so slot 3 swaps with
 * itself; `0.5` puts `floor(0.5 * 3) = 1` so slot 2 swaps with slot 1, giving
 * [D1, D3, D2, D4]; `0.1` puts `floor(0.1 * 2) = 0` so slot 1 swaps with slot
 * 0, giving [D3, D1, D2, D4]. The first three are the hand, and D4 is the hero
 * the slice drops — which is why the pools are four and not three.
 */
const SEQUENCE_A = [0, 0, 0, 0.9, 0.5, 0.1, 0.5, 0.9, 0.5];
const HAND_A = {
  Vanguard: ["Vanguard 2", "Vanguard 3", "Vanguard 4"],
  Duelist: ["Duelist 3", "Duelist 1", "Duelist 2"],
  Strategist: ["Strategist 1", "Strategist 2", "Strategist 4"],
};

/** All zeroes: every pool of four rotates to [2, 3, 4]. A different nine. */
const SEQUENCE_B = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const HAND_B = {
  Vanguard: ["Vanguard 2", "Vanguard 3", "Vanguard 4"],
  Duelist: ["Duelist 2", "Duelist 3", "Duelist 4"],
  Strategist: ["Strategist 2", "Strategist 3", "Strategist 4"],
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

let counter = 0;

type Fixture = { eventId: string; userId: string; gameId: string };

/**
 * An event whose game has `perRole` heroes in each role, and one member.
 *
 * Four per role by default rather than the three the draw needs, so the slice
 * has something to drop: a hand of three from a pool of three is the same set
 * whatever the shuffle did, and an ordering bug would be invisible in the one
 * assertion that matters most.
 */
async function fixture(perRole = 4): Promise<Fixture> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({ key: `hand-game-${counter}`, name: `Hand game ${counter}` })
    .returning({ id: games.id });

  if (perRole > 0) {
    await db.insert(heroesTable).values(
      HERO_ROLES.flatMap((role) =>
        Array.from({ length: perRole }, (_unused, index) => ({
          gameId: game.id,
          name: `${role} ${index + 1}`,
          roles: [role],
        }))
      )
    );
  }

  const [event] = await db
    .insert(eventsTable)
    .values({
      slug: `hand-event-${counter}`,
      title: `Hand event ${counter}`,
      gameId: game.id,
      status: "published",
    })
    .returning({ id: eventsTable.id });

  return { eventId: event.id, userId: await makeUser(db), gameId: game.id };
}

/** The hand as three lists of names, which is what the expectations are written in. */
function names(hand: { heroes: Record<string, Hero[]> }): Record<string, string[]> {
  return Object.fromEntries(
    HERO_ROLES.map((role) => [role, hand.heroes[role].map((hero) => hero.name)])
  );
}

async function rowsFor(fix: Fixture) {
  return db
    .select()
    .from(heroHands)
    .where(and(eq(heroHands.eventId, fix.eventId), eq(heroHands.userId, fix.userId)));
}

function dealt(result: Awaited<ReturnType<typeof dealFor>>) {
  if (!result.ok) throw new Error(`expected a hand, got: ${result.error}`);
  return result;
}

function refusal(result: Awaited<ReturnType<typeof dealFor>>): string {
  if (result.ok) throw new Error("expected a refusal, got a hand");
  return result.error;
}

/* ------------------------------------------------------------------ */
/* Sequencing                                                         */
/* ------------------------------------------------------------------ */

/**
 * This file's database, except that the **first** insert it is asked for runs
 * `between` to completion before the statement is issued.
 *
 * Sequenced rather than raced, for the reason `committingAfter` in
 * `src/db/__tests__/helpers.ts` gives: two devices clicking inside the same
 * second is not something a timer can be trusted to reproduce, and a test that
 * had to *win* a race would pass by luck on the days it did not. This pins the
 * interleave exactly — the call under test has already read "no hand" and
 * already shuffled a roster when the other one writes, which is the whole of
 * UC-39 3b.
 *
 * `insertingAfter` in `waivers.test.ts` is the same device and has to flatten a
 * transaction to reach its target; this one does not, because **`dealFor` opens
 * no transaction at all** — it makes one write and every refusal precedes it,
 * so there is nothing for a rollback to undo. If a transaction ever appears in
 * that function, this helper stops firing and that is the signal to re-read
 * `docs/decisions/004`, not to add a flatten here.
 *
 * ## It forwards whichever chain it is handed
 *
 * The six helpers like this one in the repo each hardcode one builder chain,
 * and Task 58's note says the aim is the part that drifts. This one does not
 * hardcode, and the reason is mutation evidence rather than taste: aimed only
 * at `.values().onConflictDoNothing().returning()`, deleting the
 * `onConflictDoNothing` from `dealFor` failed these tests with
 * `returning is not a function` — the proxy breaking, not the database
 * refusing. The guard under test is "a second row conflicts", so the test has
 * to let the mutated chain reach Postgres and produce the real unique
 * violation. So `values()` offers both continuations, replays whatever was
 * called on the real handle, and `between` runs before the statement either
 * way.
 *
 * Only the first insert. `between` re-enters the real handle, so its own insert
 * goes straight through.
 */
function insertingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;

  type ValuesBuilder = {
    onConflictDoNothing: (on: unknown) => { returning: () => Promise<unknown[]> };
    returning: () => Promise<unknown[]>;
  };

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "insert" || pending === null) {
        return Reflect.get(target, property, receiver);
      }
      return (table: Parameters<Database["insert"]>[0]) => ({
        values: (values: unknown) => {
          /** `between` first, then the same chain on the real handle. */
          const replay = async (
            continue_: (builder: ValuesBuilder) => Promise<unknown[]>
          ) => {
            const run = pending;
            pending = null;
            if (run) await run();
            const real = target.insert(table) as unknown as {
              values: (of: unknown) => ValuesBuilder;
            };
            return continue_(real.values(values));
          };

          return {
            onConflictDoNothing: (config: unknown) => ({
              returning: () =>
                replay((builder) => builder.onConflictDoNothing(config).returning()),
            }),
            returning: () => replay((builder) => builder.returning()),
          };
        },
      });
    },
  });
}

/**
 * This file's database, except that an insert into `hero_hands` silently writes
 * nothing and reports no row.
 *
 * UC-39 5a is "the storing write fails", and a write that reports success while
 * storing nothing is the worst shape of that — a real failure would throw and
 * be visible. This is the quiet one, and it is what the `HAND_NOT_STORED`
 * branch exists for.
 */
function storingNothing(): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "insert") return Reflect.get(target, property, receiver);
      // `dealFor` makes exactly one insert, so there is nothing else to spare.
      // Both continuations, for `insertingAfter`'s reason: a chain this proxy
      // did not anticipate must fail as a lost row, not as a missing method.
      return () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
          returning: async () => [],
        }),
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* The hand that lands                                                */
/* ------------------------------------------------------------------ */

describe("HAND_SIZE", () => {
  /**
   * The constraint `hero_hands_nine_distinct_per_role` says `9` as a literal,
   * because a CHECK cannot import a constant.
   * `hero-hands-constraints.test.ts` reads the live clause and compares it to
   * this arithmetic; this is the arithmetic.
   */
  it("is three roles at three each", () => {
    expect(HAND_SIZE).toBe(9);
    expect(HAND_SIZE).toBe(HERO_ROLES.length * HEROES_PER_ROLE);
  });
});

describe("the nine that are stored", () => {
  it("are the nine a known sequence deals, grouped by role", async () => {
    const fix = await fixture();

    const first = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db));

    expect(first.alreadyHeld).toBe(false);
    expect(names(first.hand)).toEqual(HAND_A);
    expect(first.hand.dealtAt).toBeInstanceOf(Date);
  });

  it("read back out of the database as the same nine, by role", async () => {
    const fix = await fixture();
    const first = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db));

    const held = await handFor(fix.eventId, fix.userId, db);

    expect(held).not.toBeNull();
    expect(names(held as NonNullable<typeof held>)).toEqual(HAND_A);
    expect(held?.dealtAt).toEqual(first.hand.dealtAt);
  });

  /**
   * The storage shape itself, asserted against the row rather than inferred
   * from the round trip.
   *
   * A flatten and an unflatten that are wrong the *same* way round-trip
   * perfectly and would pass every other test in this file — nine ids read back
   * into the wrong three lists is exactly that bug. So the order in the column
   * is pinned here: positions 1-3 Vanguard, 4-6 Duelist, 7-9 Strategist, which
   * is what makes a slot mean a role.
   */
  it("are one array of ids in HERO_ROLES order, three to a role", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);

    const [row] = await rowsFor(fix);
    const catalogue = await listHeroes(fix.gameId, db);
    const idOf = (name: string) =>
      (catalogue.find((hero) => hero.name === name) as Hero).id;

    expect(row.heroIds).toEqual([
      ...HAND_A.Vanguard.map(idOf),
      ...HAND_A.Duelist.map(idOf),
      ...HAND_A.Strategist.map(idOf),
    ]);
    expect(row.heroIds).toHaveLength(HAND_SIZE);
  });

  /**
   * The one way a stored hand can stop making sense, and it says so.
   *
   * Nothing in the site deletes a hero — `retireHero` writes `retired_at` and
   * the row stays — so this is reached by deleting the row underneath, which is
   * what a hard `delete` of a `games` row would do by cascade. There is no such
   * path in the site and this is not asking for one; what is asserted is that
   * if it ever happened, the read is **loud**. A hand of eight returned as
   * though it were whole would show the player a gap they could not tell from
   * what they were dealt, and nothing would be recorded anywhere.
   */
  it("fails loudly when a hand names a hero row that was deleted", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);

    await db
      .delete(heroesTable)
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Strategist 4")));

    await expect(handFor(fix.eventId, fix.userId, db)).rejects.toThrow(
      /no longer in the heroes table/
    );
  });

  it("is no hand at all before anybody deals", async () => {
    const fix = await fixture();
    expect(await handFor(fix.eventId, fix.userId, db)).toBeNull();
    expect(await rowsFor(fix)).toEqual([]);
  });

  /**
   * Ids rather than names, which is the whole reason the column holds uuids.
   *
   * A hero is identified by `(game, name)` — Task 73 declined a stable key
   * column — so a hand that stored names would lose a hero the first time an
   * admin corrected a spelling. The rename here is a bare `update` rather than
   * `renameHero`: what is being tested is the storage, and routing through
   * Task 77's write would make this test fail for that function's reasons too.
   */
  it("survive a rename, because they are ids", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    const [row] = await rowsFor(fix);

    await db
      .update(heroesTable)
      .set({ name: "Vanguard 2 (reworked)" })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Vanguard 2")));

    const held = await handFor(fix.eventId, fix.userId, db);

    expect(names(held as NonNullable<typeof held>).Vanguard).toEqual([
      "Vanguard 2 (reworked)",
      "Vanguard 3",
      "Vanguard 4",
    ]);
    // The same nine rows, untouched: a rename is not a redeal.
    expect((await rowsFor(fix))[0].heroIds).toEqual(row.heroIds);
  });

  /**
   * UC-40 4a, and the criterion in Task 75's own list: a hero retired after a
   * hand was dealt still shows in that hand. What was dealt was dealt.
   *
   * Both halves are asserted, because the first alone would pass if the
   * retirement had not actually taken: the hand keeps the hero **and** the
   * draw stops offering it.
   */
  it("keep a hero retired after the deal", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);

    await db
      .update(heroesTable)
      .set({ retiredAt: new Date("2026-10-23T12:00:00Z") })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Duelist 3")));

    const held = await handFor(fix.eventId, fix.userId, db);

    expect(names(held as NonNullable<typeof held>)).toEqual(HAND_A);
    expect(
      held?.heroes.Duelist.find((hero) => hero.name === "Duelist 3")?.retiredAt
    ).toEqual(new Date("2026-10-23T12:00:00Z"));

    // And the retirement was real: the pool it came from no longer offers it.
    const pools = drawableByRole(await listHeroes(fix.gameId, db));
    expect(pools.Duelist.map((hero) => hero.name)).not.toContain("Duelist 3");
  });

  /**
   * **Deadpool**, who is why position carries the role and a `role` column
   * would have been wrong.
   *
   * Every pool here is exactly three and one hero holds all three roles, so the
   * whole of each pool is dealt and that hero lands in all three of the
   * player's role-sets. The array then holds nine ids of which seven are
   * distinct — a legal hand that a constraint forbidding any repeat would have
   * refused, and nine slots that `handFor` has to rebuild from seven rows.
   */
  it("store one hero in several roles, nine slots from seven rows", async () => {
    counter += 1;
    const [game] = await db
      .insert(games)
      .values({ key: `dp-game-${counter}`, name: `Deadpool game ${counter}` })
      .returning({ id: games.id });
    await db.insert(heroesTable).values([
      { gameId: game.id, name: "Alpha", roles: ["Vanguard"] },
      { gameId: game.id, name: "Bravo", roles: ["Vanguard"] },
      { gameId: game.id, name: "Charlie", roles: ["Duelist"] },
      { gameId: game.id, name: "Delta", roles: ["Duelist"] },
      { gameId: game.id, name: "Echo", roles: ["Strategist"] },
      { gameId: game.id, name: "Foxtrot", roles: ["Strategist"] },
      { gameId: game.id, name: "Deadpool", roles: ["Vanguard", "Duelist", "Strategist"] },
    ]);
    const [event] = await db
      .insert(eventsTable)
      .values({
        slug: `dp-event-${counter}`,
        title: `Deadpool event ${counter}`,
        gameId: game.id,
        status: "published",
      })
      .returning({ id: eventsTable.id });
    const userId = await makeUser(db);

    // Three pools of three: two numbers each, six in all.
    const result = dealt(await dealFor(event.id, userId, fromList([0, 0, 0, 0, 0, 0]), db));

    for (const role of HERO_ROLES) {
      expect(result.hand.heroes[role].map((hero) => hero.name)).toContain("Deadpool");
    }

    const [row] = await db
      .select()
      .from(heroHands)
      .where(and(eq(heroHands.eventId, event.id), eq(heroHands.userId, userId)));
    expect(row.heroIds).toHaveLength(HAND_SIZE);
    expect(new Set(row.heroIds).size).toBe(7);

    // And the read rebuilds nine slots from the seven rows it fetched.
    const held = await handFor(event.id, userId, db);
    expect(
      HERO_ROLES.flatMap((role) => (held as NonNullable<typeof held>).heroes[role])
    ).toHaveLength(HAND_SIZE);
  });
});

/* ------------------------------------------------------------------ */
/* Dealt once (R-212 / UC-39 3a, 6a)                                  */
/* ------------------------------------------------------------------ */

describe("a second deal", () => {
  /**
   * UC-39 3a. The second call is handed a generator that **throws on its first
   * number**, which is the only way to tell "returned the stored hand" from
   * "dealt a fresh one that happened to match": an identical hand is exactly
   * what a reroll over a three-of-three pool would produce, and no assertion on
   * the nine could separate the two.
   */
  it("deals nothing at all and returns the stored hand", async () => {
    const fix = await fixture();
    const first = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db));

    const second = dealt(await dealFor(fix.eventId, fix.userId, thrower(), db));

    expect(second.alreadyHeld).toBe(true);
    expect(names(second.hand)).toEqual(HAND_A);
    expect(second.hand.dealtAt).toEqual(first.hand.dealtAt);
    expect(await rowsFor(fix)).toHaveLength(1);
  });

  /**
   * And a third, with a sequence that would have dealt something else.
   *
   * The generator is never reached, so the sequence is inert — the assertion is
   * that the hand is still `HAND_A` and not `HAND_B`, which is what a reroll
   * that ignored the stored row would have produced.
   */
  it("cannot reroll even when handed a different sequence", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);

    const again = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_B), db));

    expect(names(again.hand)).toEqual(HAND_A);
    expect(names(again.hand)).not.toEqual(HAND_B);
    expect(again.alreadyHeld).toBe(true);
    expect(await rowsFor(fix)).toHaveLength(1);
  });

  /** UC-39 6a: coming back later shows the hand, and there is nothing to click. */
  it("is not needed to see the hand again — handFor is the read", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);

    expect(names((await handFor(fix.eventId, fix.userId, db)) as { heroes: Record<string, Hero[]> }))
      .toEqual(HAND_A);
    expect(await rowsFor(fix)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Two devices, one instant (UC-39 3b)                                */
/* ------------------------------------------------------------------ */

describe("two deals at the same instant", () => {
  /**
   * The criterion most likely to pass for the wrong reason, so each half of it
   * is asserted separately.
   *
   * A test that runs two deals and finds one row also passes if **neither**
   * dealt. So: both calls must come back with a hand, the nine must be the
   * *same* nine, exactly one row must exist, and exactly one caller must report
   * `alreadyHeld`.
   *
   * And the two callers deal **different** sequences, which is what makes
   * "both see the same nine" a claim about the code. With one sequence the
   * assertion would hold even if each caller had simply kept its own draw. The
   * stored hand is the winner's `HAND_B`, and the loser is asserted to have
   * discarded `HAND_A` — its own perfectly good draw — rather than returning
   * it.
   *
   * The interleave is pinned by `insertingAfter`, not raced: the `SEQUENCE_A`
   * caller has read "no hand" and shuffled its roster, and the `SEQUENCE_B`
   * caller then runs start to finish and commits before the first one's insert
   * is issued.
   */
  it("store one hand, and both callers get the same nine", async () => {
    const fix = await fixture();

    let winner: Awaited<ReturnType<typeof dealFor>> | null = null;
    const sequenced = insertingAfter(async () => {
      winner = await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_B), db);
    });

    const loser = await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), sequenced);

    // Both dealt — neither refused, which is the vacuous pass to rule out.
    const won = dealt(winner as NonNullable<typeof winner>);
    const lost = dealt(loser);

    // Exactly one row.
    expect(await rowsFor(fix)).toHaveLength(1);

    // The same nine, and they are the winner's.
    expect(names(lost.hand)).toEqual(names(won.hand));
    expect(names(won.hand)).toEqual(HAND_B);

    // The loser discarded its own draw rather than reporting it.
    expect(names(lost.hand)).not.toEqual(HAND_A);

    // Exactly one of them is told the hand was already there.
    expect([won.alreadyHeld, lost.alreadyHeld].filter(Boolean)).toHaveLength(1);
    expect(won.alreadyHeld).toBe(false);
    expect(lost.alreadyHeld).toBe(true);

    // And the row holds the winner's nine, not a blend of the two.
    const [row] = await rowsFor(fix);
    const catalogue = await listHeroes(fix.gameId, db);
    const idOf = (name: string) => (catalogue.find((hero) => hero.name === name) as Hero).id;
    expect(row.heroIds).toEqual([
      ...HAND_B.Vanguard.map(idOf),
      ...HAND_B.Duelist.map(idOf),
      ...HAND_B.Strategist.map(idOf),
    ]);
  });

  /**
   * The same interleave for two *different* members, which must not collide.
   *
   * The constraint is on the pair, so a bug that keyed the claim on the event
   * alone would store one hand and hand the second player the first one's. This
   * is what tells "one hand per participant per event" from "one hand per
   * event".
   */
  it("do not collide when they are two different members", async () => {
    const fix = await fixture();
    const other = await makeUser(db);

    let second: Awaited<ReturnType<typeof dealFor>> | null = null;
    const sequenced = insertingAfter(async () => {
      second = await dealFor(fix.eventId, other, fromList(SEQUENCE_B), db);
    });

    const first = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), sequenced));
    const theirs = dealt(second as NonNullable<typeof second>);

    expect(first.alreadyHeld).toBe(false);
    expect(theirs.alreadyHeld).toBe(false);
    expect(names(first.hand)).toEqual(HAND_A);
    expect(names(theirs.hand)).toEqual(HAND_B);

    const rows = await db
      .select({ userId: heroHands.userId })
      .from(heroHands)
      .where(eq(heroHands.eventId, fix.eventId));
    expect(rows.map((row) => row.userId).sort()).toEqual([fix.userId, other].sort());
  });
});

/* ------------------------------------------------------------------ */
/* Nothing stored is nothing dealt (UC-39 5a)                         */
/* ------------------------------------------------------------------ */

describe("a store that writes nothing", () => {
  /**
   * UC-39 5a: "a hand that was never stored is not a hand" — nothing is shown
   * as drawn and the participant may click again.
   *
   * The second half is the one that matters and the one a weaker test would
   * leave out: refusing is only correct if the player can still get a hand
   * afterwards. A refusal that also left a row would be
   * `docs/decisions/004`'s bug in its inverted form — stored, and reported as
   * not stored.
   */
  it("refuses, leaves no hand, and the member may deal again", async () => {
    const fix = await fixture();

    const blocked = await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), storingNothing());

    expect(refusal(blocked)).toBe(HAND_NOT_STORED);
    expect(await rowsFor(fix)).toEqual([]);
    expect(await handFor(fix.eventId, fix.userId, db)).toBeNull();

    const retry = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_B), db));
    expect(retry.alreadyHeld).toBe(false);
    expect(names(retry.hand)).toEqual(HAND_B);
    expect(await rowsFor(fix)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Every refusal comes first (decision 004, UC-39 2a)                 */
/* ------------------------------------------------------------------ */

describe("a refusal", () => {
  /**
   * UC-39 2a, passed through from `drawHand` unaltered so that there is one
   * copy of the sentence. The generator throws on its first number, which is
   * what proves the refusal came **before any draw** rather than after nine
   * were dealt and thrown away.
   */
  it("names every thin role and stores nothing", async () => {
    const fix = await fixture(2);

    const error = refusal(await dealFor(fix.eventId, fix.userId, thrower(), db));

    expect(error).toContain("Vanguard has 2 heroes");
    expect(error).toContain("Duelist has 2 heroes");
    expect(error).toContain("Strategist has 2 heroes");
    expect(await rowsFor(fix)).toEqual([]);
  });

  it("is given for an event with no game, and stores nothing", async () => {
    counter += 1;
    const [event] = await db
      .insert(eventsTable)
      .values({
        slug: `no-game-event-${counter}`,
        title: `No game event ${counter}`,
        status: "published",
      })
      .returning({ id: eventsTable.id });
    const userId = await makeUser(db);

    expect(refusal(await dealFor(event.id, userId, thrower(), db))).toBe(HAND_NO_GAME);
    expect(
      await db.select().from(heroHands).where(eq(heroHands.eventId, event.id))
    ).toEqual([]);
  });

  it("is given for an event that is not there", async () => {
    const userId = await makeUser(db);
    const gone = "00000000-0000-0000-0000-0000000000ff";

    expect(refusal(await dealFor(gone, userId, thrower(), db))).toBe(HAND_EVENT_GONE);
    expect(await db.select().from(heroHands).where(eq(heroHands.userId, userId))).toEqual([]);
  });

  /**
   * Each sentence whole and distinct from the others.
   *
   * A `toContain` on a fragment two refusals shared is how an assertion on this
   * plan went green for the wrong reason — `heroes.ts` carries the same note
   * against its three. These are asserted with `toBe` above; this is the check
   * that no two of them could satisfy each other's assertion.
   */
  it("shares no wording with the other refusals", () => {
    const all = [HAND_EVENT_GONE, HAND_NO_GAME, HAND_NOT_STORED];
    expect(new Set(all).size).toBe(all.length);
    for (const one of all) {
      for (const other of all) {
        if (one !== other) expect(other).not.toContain(one);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Randomness is injected, never called                               */
/* ------------------------------------------------------------------ */

describe("the source of randomness", () => {
  /**
   * Proved rather than asserted, exactly as `heroes-policy.test.ts` proves it:
   * `Math.random` is deleted from the global object and replaced with a
   * thrower, and a whole deal runs against an injected sequence. Nothing in
   * `dealFor`, or in anything it calls, may reach for the global.
   *
   * `dealFor`'s default parameter *is* `Math.random`, which is what the page
   * takes — so this also pins that the default is read at call time rather than
   * captured at import, since a captured reference would survive the swap and
   * the test would pass without proving anything.
   */
  it("is never the global one when a generator is passed", async () => {
    const fix = await fixture();
    const real = Math.random;
    Math.random = () => {
      throw new Error("dealFor reached for the global Math.random");
    };

    try {
      const result = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db));
      expect(names(result.hand)).toEqual(HAND_A);
    } finally {
      Math.random = real;
    }
  });

  it("is the global one when none is passed, and that is the only caller that omits it", async () => {
    const fix = await fixture();
    const real = Math.random;
    let asked = 0;
    Math.random = () => {
      asked += 1;
      return 0;
    };

    try {
      // Positional: the real signature is (eventId, userId, random?, database?).
      const result = dealt(await dealFor(fix.eventId, fix.userId, undefined, db));
      expect(asked).toBe(9);
      expect(names(result.hand)).toEqual(HAND_B);
    } finally {
      Math.random = real;
    }
  });
});
