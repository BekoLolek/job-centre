import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type Hero,
  applications,
  events as eventsTable,
  games,
  heroHands,
  heroes as heroesTable,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  HAND_EVENT_GONE,
  HAND_NOT_STORED,
  HAND_NO_GAME,
  HAND_SIZE,
  dealFor,
  handFor,
  handsFor,
  handsOfPlayer,
  playersWithHands,
} from "@/lib/hero-hands";
import { HERO_ROLES, drawableByRole, hasHeroList, listHeroes } from "@/lib/heroes";
import { HEROES_PER_ROLE } from "@/lib/heroes-policy";

/**
 * Storing a hand: dealt once, and it stands (R-212 / UC-39 3a, 3b, 5a, 6a).
 *
 * `heroes-policy.test.ts` proves *which* nine with no database in sight. This
 * file proves the seven things only a real Postgres can answer.
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
 *  - **That the manager's sheet is the players' hands** (R-239 / UC-47 2, 2b,
 *    2c, 2d): `handsFor` returns, for every holder on one event and nobody
 *    from another, exactly what `handFor` returns — retired and renamed heroes
 *    included, Deadpool in every slot he was dealt in, and the same loud
 *    failure on a deleted row.
 *  - **That one player's history is their hands, newest first** (R-244, R-246
 *    / UC-48 2, 4, 4b): `handsOfPlayer` returns every hand that player holds
 *    across every event and nobody else's, in `dealt_at` order rather than
 *    storage order, each naming its event, and agreeing with `handFor` hand for
 *    hand; and `playersWithHands` lists only the members who hold one, most
 *    nights first, from a single statement.
 *  - **That `hasHeroList` answers yes-or-no from one row at most**, and says
 *    yes for a list whose every hero has been retired, because the tab it
 *    gates is about hands already dealt and not about the next draw.
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

/**
 * **Deadpool's** event: every pool is exactly three, and one hero holds all
 * three roles, so the whole of each pool is dealt and that hero lands in all
 * three of a player's role-sets. Nine ids of which seven are distinct.
 *
 * Shared by the single-hand test and the sheet test below, because the sheet
 * has to rebuild the same nine slots from the same seven rows and the only
 * honest way to say so is to deal the same hand.
 */
async function deadpoolFixture(): Promise<Fixture> {
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
  return { eventId: event.id, userId: await makeUser(db), gameId: game.id };
}

/** Three pools of three: two numbers each, six in all. */
const DEADPOOL_SEQUENCE = [0, 0, 0, 0, 0, 0];

/**
 * What all zeroes deal over Deadpool's pools, worked the way `HAND_A` is.
 *
 * `listHeroes` orders by name, so the Vanguard pool is [Alpha, Bravo,
 * Deadpool]; index 2 swaps with `floor(0 * 3) = 0` giving [Deadpool, Bravo,
 * Alpha], index 1 swaps with `floor(0 * 2) = 0` giving [Bravo, Deadpool,
 * Alpha], and the slice of three is the whole pool. The same two swaps on
 * [Charlie, Deadpool, Delta] and [Deadpool, Echo, Foxtrot] give the other two
 * rows. Deadpool sits in a different slot of each — which is what pins that a
 * slot carries the role and the sheet reads the slots in `HERO_ROLES` order.
 */
const DEADPOOL_HAND = {
  Vanguard: ["Bravo", "Deadpool", "Alpha"],
  Duelist: ["Deadpool", "Delta", "Charlie"],
  Strategist: ["Echo", "Foxtrot", "Deadpool"],
};

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

/**
 * This file's database, except that every row a `select` hands back is counted.
 *
 * `hasHeroList` exists because `listHeroes` would read fifty-four rows to
 * answer yes-or-no, and "reads one row at most" is the criterion that makes it
 * worth a function of its own. Asserting on the SQL text would pin `limit 1`
 * as spelling; what matters is how many rows came back, so that is what is
 * counted. Every object a call on the chain returns is wrapped the same way,
 * because `from` returns a new builder and `where`/`limit` return it again,
 * and `await` reaches the builder through its own `then`.
 */
function countingRows(): { database: Database; handedBack: () => number } {
  let handedBack = 0;

  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === "then") {
          const then = Reflect.get(inner, "then", inner) as (
            onFulfilled: (rows: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) => Promise<unknown>;
          return (
            onFulfilled: (rows: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) =>
            then.call(
              inner,
              (rows: unknown[]) => {
                handedBack += rows.length;
                return onFulfilled(rows);
              },
              onRejected
            );
        }
        const value = Reflect.get(inner, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...of: unknown[]) => unknown).apply(inner, args);
          return out !== null && typeof out === "object" ? wrap(out) : out;
        };
      },
    });

  return { database: wrap(db), handedBack: () => handedBack };
}

/**
 * This file's database, except that every `select` it is asked to begin is
 * counted.
 *
 * `playersWithHands` is one grouped statement for `loadAdminGames`' reason
 * (`src/lib/admin-games.ts`): forty members read one at a time would be forty
 * HTTP requests to Neon. `countingRows` above cannot tell that apart — a loop
 * of forty single-row reads and one forty-row read hand back the same number
 * of rows — so this counts statements instead. Only the handle's own `select`
 * is watched, because that is where every read in `hero-hands.ts` begins; a
 * read that reached Postgres some other way would not be counted, which is a
 * reason to keep the module's reads on the one builder rather than a gap to
 * close here.
 */
function countingSelects(): { database: Database; begun: () => number } {
  let begun = 0;
  const database = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select") return value;
      return (...args: unknown[]) => {
        begun += 1;
        return (value as (...of: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { database, begun: () => begun };
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
    const fix = await deadpoolFixture();

    const result = dealt(await dealFor(fix.eventId, fix.userId, fromList(DEADPOOL_SEQUENCE), db));

    for (const role of HERO_ROLES) {
      expect(result.hand.heroes[role].map((hero) => hero.name)).toContain("Deadpool");
    }

    const [row] = await rowsFor(fix);
    expect(row.heroIds).toHaveLength(HAND_SIZE);
    expect(new Set(row.heroIds).size).toBe(7);

    // And the read rebuilds nine slots from the seven rows it fetched.
    const held = await handFor(fix.eventId, fix.userId, db);
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

/* ------------------------------------------------------------------ */
/* Every hand for one event (R-239, R-242 / UC-47 2, 2b, 2c, 2d)      */
/* ------------------------------------------------------------------ */

describe("every hand for one event", () => {
  /**
   * UC-47 2: the sheet, keyed by who holds each hand, and **only this event's**.
   *
   * The shared player draws on both events, and the second event has a player
   * of its own, so each half of the filter is caught separately: a read keyed
   * on the wrong column would put the shared player's second hand where the
   * first should be, and a read with no event filter at all would bring the
   * third player onto a sheet they were never dealt on.
   */
  it("lists each hand under its holder, and nothing dealt on another event", async () => {
    const fix = await fixture();
    const other = await makeUser(db);
    const elsewhere = await fixture();
    const stranger = await makeUser(db);
    const mine = dealt(await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db));
    const theirs = dealt(await dealFor(fix.eventId, other, fromList(SEQUENCE_B), db));
    await dealFor(elsewhere.eventId, fix.userId, fromList(SEQUENCE_B), db);
    await dealFor(elsewhere.eventId, stranger, fromList(SEQUENCE_A), db);

    const sheet = await handsFor(fix.eventId, db);

    expect(Object.keys(sheet).sort()).toEqual([fix.userId, other].sort());
    expect(names(sheet[fix.userId])).toEqual(HAND_A);
    expect(names(sheet[other])).toEqual(HAND_B);
    expect(sheet[fix.userId].dealtAt).toEqual(mine.hand.dealtAt);
    expect(sheet[other].dealtAt).toEqual(theirs.hand.dealtAt);
  });

  /**
   * The two readers cannot drift: the sheet's hand for a player *is* the hand
   * the player's own page reads, asserted whole — rows, slots and `dealtAt`.
   */
  it("agrees with handFor hand for hand over the same event", async () => {
    const fix = await fixture();
    const other = await makeUser(db);
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(fix.eventId, other, fromList(SEQUENCE_B), db);

    const sheet = await handsFor(fix.eventId, db);

    expect(sheet[fix.userId]).toEqual(await handFor(fix.eventId, fix.userId, db));
    expect(sheet[other]).toEqual(await handFor(fix.eventId, other, db));
  });

  it("is empty for an event on which nobody has drawn", async () => {
    const fix = await fixture();
    expect(await handsFor(fix.eventId, db)).toEqual({});
  });

  it("is empty for an id that names no event", async () => {
    expect(await handsFor("00000000-0000-0000-0000-0000000000ff", db)).toEqual({});
  });

  /**
   * UC-47 2d: Deadpool in both slots — three, here — in `HERO_ROLES` order.
   *
   * The exact nine are pinned rather than "contains Deadpool", because the
   * sheet reads nine slots out of seven rows and a read that collapsed the
   * repeat, or put the roles back in the wrong order, would still contain him.
   */
  it("names one hero in every slot it was dealt in, in HERO_ROLES order", async () => {
    const fix = await deadpoolFixture();
    await dealFor(fix.eventId, fix.userId, fromList(DEADPOOL_SEQUENCE), db);

    const sheet = await handsFor(fix.eventId, db);

    expect(names(sheet[fix.userId])).toEqual(DEADPOOL_HAND);
    expect(Object.keys(sheet[fix.userId].heroes)).toEqual([...HERO_ROLES]);
  });

  /**
   * UC-47 2b and 2c together, because they are one claim about one read: a
   * hand is the rows it was dealt, so a retirement leaves the hero named and a
   * rename shows the new name. Both are bare updates for the reason the
   * single-hand tests give — the storage is under test, not Task 77's writes.
   */
  it("still names a retired hero, and a renamed hero under its new name", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await db
      .update(heroesTable)
      .set({ retiredAt: new Date("2026-10-23T12:00:00Z") })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Duelist 3")));
    await db
      .update(heroesTable)
      .set({ name: "Vanguard 2 (reworked)" })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Vanguard 2")));

    const sheet = await handsFor(fix.eventId, db);

    expect(names(sheet[fix.userId])).toEqual({
      Vanguard: ["Vanguard 2 (reworked)", "Vanguard 3", "Vanguard 4"],
      Duelist: HAND_A.Duelist,
      Strategist: HAND_A.Strategist,
    });
    expect(
      sheet[fix.userId].heroes.Duelist.find((hero) => hero.name === "Duelist 3")?.retiredAt
    ).toEqual(new Date("2026-10-23T12:00:00Z"));
  });

  /**
   * The loud failure is reached from the sheet too, and it is the same
   * sentence: the two readers share `unflatten`, and this is what shows it.
   * A sheet that returned a hand of eight where the page throws would be the
   * drift the shared function exists to prevent.
   */
  it("fails loudly when a hand names a deleted hero row, with handFor's error", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await db
      .delete(heroesTable)
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Strategist 4")));

    const fromPage = await handFor(fix.eventId, fix.userId, db).then(
      () => "did not throw",
      (error: Error) => error.message
    );
    const fromSheet = await handsFor(fix.eventId, db).then(
      () => "did not throw",
      (error: Error) => error.message
    );

    expect(fromSheet).toMatch(/no longer in the heroes table/);
    expect(fromSheet).toBe(fromPage);
  });
});

/* ------------------------------------------------------------------ */
/* Every hand one player has been dealt (R-244 / UC-48 4, 4b)         */
/* ------------------------------------------------------------------ */

/** The three columns a hand names its night by, read straight off the row. */
async function eventNamed(eventId: string) {
  const [row] = await db
    .select({ id: eventsTable.id, title: eventsTable.title, slug: eventsTable.slug })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));
  return row;
}

/** Move a stored hand's `dealt_at`, so that storage order and dealt order can differ. */
async function dealtOn(fix: Fixture, at: Date): Promise<void> {
  await db
    .update(heroHands)
    .set({ dealtAt: at })
    .where(and(eq(heroHands.eventId, fix.eventId), eq(heroHands.userId, fix.userId)));
}

describe("every hand one player has been dealt", () => {
  /**
   * UC-48 4: newest first — and **by `dealt_at`, not by the order the rows
   * went in**. Three hands are stored in one order and then dated in another,
   * so a read that returned rows as Postgres happened to find them, or ordered
   * by insertion, would put the middle-dated hand first and fail here. The
   * dates are a week apart, which is the "three weeks running" R-244 asks
   * about.
   */
  it("come back newest first by dealt_at, whatever order they were stored in", async () => {
    const first = await fixture();
    const second = { ...(await fixture()), userId: first.userId };
    const third = { ...(await fixture()), userId: first.userId };
    await dealFor(first.eventId, first.userId, fromList(SEQUENCE_A), db);
    await dealFor(second.eventId, first.userId, fromList(SEQUENCE_B), db);
    await dealFor(third.eventId, first.userId, fromList(SEQUENCE_A), db);
    await dealtOn(first, new Date("2026-10-09T20:00:00Z"));
    await dealtOn(second, new Date("2026-10-02T20:00:00Z"));
    await dealtOn(third, new Date("2026-10-16T20:00:00Z"));

    const history = await handsOfPlayer(first.userId, db);

    expect(history.map((hand) => hand.event.id)).toEqual([
      third.eventId,
      first.eventId,
      second.eventId,
    ]);
    expect(history.map((hand) => hand.dealtAt)).toEqual([
      new Date("2026-10-16T20:00:00Z"),
      new Date("2026-10-09T20:00:00Z"),
      new Date("2026-10-02T20:00:00Z"),
    ]);
  });

  /** UC-48 4: each hand names the night it came from — id, title and slug. */
  it("name the event each hand came from", async () => {
    const fix = await fixture();
    const elsewhere = { ...(await fixture()), userId: fix.userId };
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(elsewhere.eventId, fix.userId, fromList(SEQUENCE_B), db);

    const history = await handsOfPlayer(fix.userId, db);

    const byEvent = Object.fromEntries(history.map((hand) => [hand.event.id, hand]));
    expect(byEvent[fix.eventId].event).toEqual(await eventNamed(fix.eventId));
    expect(byEvent[elsewhere.eventId].event).toEqual(await eventNamed(elsewhere.eventId));
    expect(names(byEvent[fix.eventId])).toEqual(HAND_A);
    expect(names(byEvent[elsewhere.eventId])).toEqual(HAND_B);
  });

  /**
   * Only this player's. Two members draw on the same event, and the read for
   * one of them must not carry the other's hand — a read keyed on the event
   * instead of the member would return both and fail here on length, and one
   * that returned the wrong member's would fail on the nine.
   */
  it("hold nobody else's hand, with two players at one event", async () => {
    const fix = await fixture();
    const other = await makeUser(db);
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(fix.eventId, other, fromList(SEQUENCE_B), db);

    const mine = await handsOfPlayer(fix.userId, db);
    const theirs = await handsOfPlayer(other, db);

    expect(mine).toHaveLength(1);
    expect(names(mine[0])).toEqual(HAND_A);
    expect(theirs).toHaveLength(1);
    expect(names(theirs[0])).toEqual(HAND_B);
  });

  it("is empty for a member who has never drawn", async () => {
    expect(await handsOfPlayer(await makeUser(db), db)).toEqual([]);
  });

  it("is empty for an id that names nobody", async () => {
    expect(await handsOfPlayer("00000000-0000-0000-0000-0000000000ff", db)).toEqual([]);
  });

  /**
   * The third reader cannot drift from the first: for each event, the hand in
   * the history *is* the hand `handFor` reads — rows, slots and `dealtAt`,
   * asserted whole. One of the two is Deadpool's event, so the agreement is
   * over nine slots rebuilt from seven rows and not only over the easy case.
   */
  it("agrees with handFor hand for hand, Deadpool's slots included", async () => {
    const fix = await fixture();
    const deadpool = { ...(await deadpoolFixture()), userId: fix.userId };
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(deadpool.eventId, fix.userId, fromList(DEADPOOL_SEQUENCE), db);

    const history = await handsOfPlayer(fix.userId, db);

    const byEvent = Object.fromEntries(history.map((hand) => [hand.event.id, hand]));
    const bare = ({ heroes, dealtAt }: { heroes: Record<string, Hero[]>; dealtAt: Date }) => ({
      heroes,
      dealtAt,
    });
    expect(bare(byEvent[fix.eventId])).toEqual(await handFor(fix.eventId, fix.userId, db));
    expect(bare(byEvent[deadpool.eventId])).toEqual(
      await handFor(deadpool.eventId, fix.userId, db)
    );
    expect(names(byEvent[deadpool.eventId])).toEqual(DEADPOOL_HAND);
  });

  /**
   * UC-48 4b, the same claim as UC-47 2b and 2c and for the same reason: a
   * hand is the rows it was dealt, so a retirement leaves the hero named and a
   * rename shows the new name. Bare updates, as the sheet's test uses.
   */
  it("still names a retired hero, and a renamed hero under its new name", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await db
      .update(heroesTable)
      .set({ retiredAt: new Date("2026-10-23T12:00:00Z") })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Duelist 3")));
    await db
      .update(heroesTable)
      .set({ name: "Vanguard 2 (reworked)" })
      .where(and(eq(heroesTable.gameId, fix.gameId), eq(heroesTable.name, "Vanguard 2")));

    const [hand] = await handsOfPlayer(fix.userId, db);

    expect(names(hand)).toEqual({
      Vanguard: ["Vanguard 2 (reworked)", "Vanguard 3", "Vanguard 4"],
      Duelist: HAND_A.Duelist,
      Strategist: HAND_A.Strategist,
    });
    expect(hand.heroes.Duelist.find((hero) => hero.name === "Duelist 3")?.retiredAt).toEqual(
      new Date("2026-10-23T12:00:00Z")
    );
  });
});

/* ------------------------------------------------------------------ */
/* Who has been dealt anything at all (R-246 / UC-48 2)               */
/* ------------------------------------------------------------------ */

describe("the players who hold a hand", () => {
  /**
   * UC-48 2: every member who holds at least one hand, with how many nights,
   * and nobody else — proven with a member who **applied** to the event and
   * never drew, since "applied" is the nearest thing to "drew" a picker built
   * on the wrong table would list.
   *
   * This file's database is shared by every test above it, so the list is full
   * of other members' hands by now. The assertions are about the members
   * planted here and about the order of the whole list, not about an exact
   * list.
   */
  it("lists each holder with their count, and not a member who applied and never drew", async () => {
    const fix = await fixture();
    const second = { ...(await fixture()), userId: fix.userId };
    const once = await makeUser(db, { displayName: "Drew once" });
    const never = await makeUser(db, { displayName: "Applied, never drew" });
    await db.insert(applications).values({ eventId: fix.eventId, userId: never, status: "accepted" });
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(second.eventId, fix.userId, fromList(SEQUENCE_B), db);
    await dealFor(fix.eventId, once, fromList(SEQUENCE_B), db);

    const players = await playersWithHands(db);

    const byId = Object.fromEntries(players.map((player) => [player.userId, player]));
    expect(byId[fix.userId].hands).toBe(2);
    expect(byId[once]).toEqual({ userId: once, displayName: "Drew once", hands: 1 });
    expect(byId[never]).toBeUndefined();
  });

  /**
   * R-246: most nights first. Asserted over the whole list rather than the two
   * planted members, because a sort that happened to put these two the right
   * way round by luck of insertion would still be no sort.
   */
  it("puts the player with the most nights first", async () => {
    const fix = await fixture();
    const second = { ...(await fixture()), userId: fix.userId };
    const third = { ...(await fixture()), userId: fix.userId };
    const fourth = { ...(await fixture()), userId: fix.userId };
    const once = await makeUser(db);
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(second.eventId, fix.userId, fromList(SEQUENCE_B), db);
    await dealFor(third.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(fourth.eventId, fix.userId, fromList(SEQUENCE_B), db);
    await dealFor(fix.eventId, once, fromList(SEQUENCE_B), db);

    const players = await playersWithHands(db);

    const counts = players.map((player) => player.hands);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const rank = (userId: string) => players.findIndex((player) => player.userId === userId);
    expect(rank(fix.userId)).toBeLessThan(rank(once));
  });

  /** Two members on the same number of nights come back by name, so the picker holds still. */
  it("breaks a tie on nights by display name", async () => {
    const fix = await fixture();
    const zed = await makeUser(db, { displayName: "Zz tie" });
    const abe = await makeUser(db, { displayName: "Aa tie" });
    await dealFor(fix.eventId, zed, fromList(SEQUENCE_A), db);
    await dealFor(fix.eventId, abe, fromList(SEQUENCE_B), db);

    const players = await playersWithHands(db);

    const rank = (userId: string) => players.findIndex((player) => player.userId === userId);
    expect(rank(abe)).toBeLessThan(rank(zed));
  });

  /**
   * And a tie on display name too — which both name columns being nullable
   * makes possible — is broken by id, so the order is defined for every row.
   * Written straight into `users` rather than through `makeUser`, which always
   * sets both columns and so cannot reach this case. Postgres orders a uuid
   * bytewise, which is the order of its canonical text, so the expectation can
   * be computed from the two ids as strings.
   */
  it("breaks a tie on display name by id, for members with no name at all", async () => {
    const fix = await fixture();
    counter += 1;
    const nameless = await db
      .insert(users)
      .values([{ discordId: `nameless-a-${counter}` }, { discordId: `nameless-b-${counter}` }])
      .returning({ id: users.id });
    const [lower, higher] = nameless.map((row) => row.id).sort();
    await dealFor(fix.eventId, lower, fromList(SEQUENCE_A), db);
    await dealFor(fix.eventId, higher, fromList(SEQUENCE_B), db);

    const players = await playersWithHands(db);

    const rank = (userId: string) => players.findIndex((player) => player.userId === userId);
    expect(rank(lower)).toBeLessThan(rank(higher));
    expect(players[rank(lower)].displayName).toBe("Unknown member");
  });

  /**
   * One statement, however many members hold a hand (`loadAdminGames`' reason).
   * Three holders are planted so that a read per holder would begin at least
   * four selects — the list and then one each — against the one asserted.
   */
  it("is one query, not one per player", async () => {
    const fix = await fixture();
    await dealFor(fix.eventId, fix.userId, fromList(SEQUENCE_A), db);
    await dealFor(fix.eventId, await makeUser(db), fromList(SEQUENCE_B), db);
    await dealFor(fix.eventId, await makeUser(db), fromList(SEQUENCE_A), db);
    const counting = countingSelects();

    const players = await playersWithHands(counting.database);

    expect(players.length).toBeGreaterThanOrEqual(3);
    expect(counting.begun()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Whether a game has a hero list at all                              */
/* ------------------------------------------------------------------ */

describe("hasHeroList", () => {
  it("is true for a game with one hero", async () => {
    const fix = await fixture(1);
    expect(await hasHeroList(fix.gameId, db)).toBe(true);
  });

  it("is false for a game with none", async () => {
    const fix = await fixture(0);
    expect(await hasHeroList(fix.gameId, db)).toBe(false);
  });

  /**
   * Retired heroes count, and this is the test that keeps it so: an event whose
   * game's whole roster has since been retired is exactly the event UC-47 2b is
   * about — what was dealt stays dealt — and a `retired_at is null` added to
   * the probe would pass the two tests above while hiding the hands tab for
   * precisely that event. Exactly one hero, written retired, rather than
   * `fixture(1)`'s three: the claim is about a list with nothing drawable left.
   */
  it("is true for a game whose only hero is retired", async () => {
    counter += 1;
    const [game] = await db
      .insert(games)
      .values({ key: `retired-game-${counter}`, name: `Retired game ${counter}` })
      .returning({ id: games.id });
    await db.insert(heroesTable).values({
      gameId: game.id,
      name: "Vanguard 1",
      roles: ["Vanguard"],
      retiredAt: new Date("2026-10-23T12:00:00Z"),
    });

    expect(await hasHeroList(game.id, db)).toBe(true);
  });

  /**
   * The reason it is a function of its own: `listHeroes` answers the same
   * question by reading the whole roster. Twelve heroes are planted so that a
   * probe which read them all is told apart from one that stopped at the first.
   */
  it("reads one row at most, however long the list is", async () => {
    const fix = await fixture(4);
    const counting = countingRows();

    expect(await hasHeroList(fix.gameId, counting.database)).toBe(true);

    expect(counting.handedBack()).toBe(1);
  });
});
