import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "@/db/migrate";
import { HERO_ROLES } from "@/lib/heroes";
import { type TestDatabase, expectRejection, freshDatabase } from "./helpers";

/**
 * Task 144, landed by Task 148 — the stored hand stops being nine (R-270,
 * R-271 / UC-58 7, 7a).
 *
 * The replacement took two deploys, because a push to main applies migrations
 * while the previous build is still serving: drizzle/0036 added
 * `hero_hands_per_role_distinct` beside the CHECK that said nine, and
 * drizzle/0037 dropped the nine. Both are journalled now, so the database
 * every test builds has the new CHECK and nothing else — and a hand of another
 * width can be *inserted*, which is the only way the new CHECK can be shown
 * to be the thing that refuses.
 *
 * Every refusal below names the constraint it expects.
 * `hero-hands-constraints.test.ts` keeps what Postgres guarantees about the
 * row — one hand per pair, the foreign keys, the index — and the shape of the
 * array is this file's.
 *
 * The ids are random uuids rather than `heroes` rows: `hero_ids` carries no
 * foreign key (Postgres cannot reference a table from an array element), and
 * a hand of fifteen would otherwise need fifteen rows to say nothing more.
 */

const ADD = "0036_hero_hands_any_width";
const DROP = "0037_hero_hands_drop_nine";
const OLD = "hero_hands_nine_distinct_per_role";
const NEW = "hero_hands_per_role_distinct";
const ROLES = HERO_ROLES.length;

/** A file's statements, one at a time, as the migrator runs them. */
async function runSql(client: PGlite, file: string): Promise<void> {
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

/** Every migration before `tag`, so that `tag` can be run by hand — and again. */
async function databaseBefore(tag: string): Promise<PGlite> {
  const client = new PGlite();
  const earlier = readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith(".sql") && name.replace(/\.sql$/, "") < tag)
    .sort();
  for (const name of earlier) await runSql(client, path.join(MIGRATIONS_FOLDER, name));
  return client;
}

/** The CHECKs on `hero_hands` and the function behind the new one, as text. */
async function guards(client: PGlite) {
  const checks = await client.query<{ at: string }>(
    `select conname || ' valid=' || convalidated || ' ' || pg_get_constraintdef(oid) as at
       from pg_constraint
      where conrelid = 'hero_hands'::regclass and contype = 'c' order by conname`
  );
  const functions = await client.query<{ at: string }>(
    `select pg_get_functiondef(oid) as at from pg_proc where proname = 'hero_hand_is_well_formed'`
  );
  return { checks: checks.rows.map((row) => row.at), functions: functions.rows.map((row) => row.at) };
}

let counter = 0;

/** An event and a member to hang one hand on. */
async function seat(client: PGlite): Promise<{ eventId: string; userId: string }> {
  counter += 1;
  const event = await client.query<{ id: string }>(
    `insert into events (slug, title) values ($1, $2) returning id`,
    [`width-event-${counter}`, `Width event ${counter}`]
  );
  const user = await client.query<{ id: string }>(
    `insert into users (name, display_name) values ($1, $1) returning id`,
    [`width-player-${counter}`]
  );
  return { eventId: event.rows[0].id, userId: user.rows[0].id };
}

/** Insert a hand of exactly these elements; `null` is written as a NULL element. */
async function insertHand(client: PGlite, ids: readonly (string | null)[]): Promise<string[]> {
  const { eventId, userId } = await seat(client);
  const result = await client.query<{ hero_ids: string[] }>(
    `insert into hero_hands (event_id, user_id, hero_ids) values ($1, $2, $3::uuid[])
     returning hero_ids`,
    [eventId, userId, `{${ids.map((id) => id ?? "null").join(",")}}`]
  );
  return result.rows[0].hero_ids;
}

/** `width` distinct ids for every role, in deal order. */
function hand(width: number): string[] {
  return Array.from({ length: ROLES * width }, () => randomUUID());
}

describe("the function behind the constraint", () => {
  let journalled: TestDatabase;

  beforeAll(async () => {
    journalled = await freshDatabase();
  });

  afterAll(async () => {
    await journalled.close();
  });

  /**
   * The role count is a literal in the CHECK, because a CHECK cannot import a
   * constant. This is the one place it meets `HERO_ROLES`, so a fourth role
   * cannot leave them disagreeing in silence. Read from the live constraint,
   * not from this file's belief.
   */
  it("hands the function the number of roles the code deals", async () => {
    const { checks } = await guards(journalled.client);

    expect(checks[0]).toContain(`${NEW} valid=true`);
    expect(checks[0]).toContain(`hero_hand_is_well_formed(hero_ids, ${ROLES})`);
  });

  it("uses a function Postgres will accept in a CHECK for good: immutable", async () => {
    const result = await journalled.client.query<{ provolatile: string }>(
      `select provolatile from pg_proc where proname = 'hero_hand_is_well_formed'`
    );

    expect(result.rows).toEqual([{ provolatile: "i" }]);
  });
});

describe("running drizzle/0036 over hands that already exist, and again", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = await databaseBefore(ADD);
  });

  afterAll(async () => {
    await client.close();
  });

  /**
   * The migrator applies a file once, so the second pass is by hand. A bare
   * `ADD CONSTRAINT` would stop it at "already exists" — Postgres has no `IF
   * NOT EXISTS` for one — and a file that got through by dropping and
   * re-adding would be the one-deploy replacement this task may not write.
   *
   * The hand is stored **before** the first pass: `VALIDATE` reads every row,
   * so this is also the proof that a deployment with hands in it gets through.
   */
  it("validates over a stored hand, and changes nothing the second time", async () => {
    const stored = await insertHand(client, hand(3));
    const rows = async () =>
      (await client.query<{ at: string }>(`select h::text as at from hero_hands h`)).rows;

    await runSql(client, path.join(MIGRATIONS_FOLDER, `${ADD}.sql`));
    const once = { guards: await guards(client), rows: await rows() };
    await runSql(client, path.join(MIGRATIONS_FOLDER, `${ADD}.sql`));

    expect(once.guards.checks).toHaveLength(2);
    expect(once.guards.checks[1]).toContain(`${NEW} valid=true`);
    expect(once.guards.functions).toHaveLength(1);
    expect(once.rows[0].at).toContain(stored[0]);
    expect({ guards: await guards(client), rows: await rows() }).toEqual(once);
  });
});

describe("running drizzle/0037 over hands that already exist, and again", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = await databaseBefore(DROP);
  });

  afterAll(async () => {
    await client.close();
  });

  /**
   * The second pass is by hand, as above. A bare `DROP CONSTRAINT` — which is
   * what `npm run db:generate` wrote — stops it at "does not exist".
   *
   * The hand is stored before the first pass, while the nine is still there
   * to pass: a drop reads no rows, and the row and the new CHECK are what it
   * must leave exactly as they were.
   */
  it("takes the nine away from a stored hand, and changes nothing the second time", async () => {
    const stored = await insertHand(client, hand(3));
    const rows = async () =>
      (await client.query<{ at: string }>(`select h::text as at from hero_hands h`)).rows;
    const before = { guards: await guards(client), rows: await rows() };

    await runSql(client, path.join(MIGRATIONS_FOLDER, `${DROP}.sql`));
    const once = { guards: await guards(client), rows: await rows() };
    await runSql(client, path.join(MIGRATIONS_FOLDER, `${DROP}.sql`));

    expect(before.guards.checks).toHaveLength(2);
    expect(before.guards.checks[0]).toContain(OLD);
    expect(once.guards.checks).toEqual([before.guards.checks[1]]);
    expect(once.guards.functions).toEqual(before.guards.functions);
    expect(once.rows).toEqual(before.rows);
    expect(once.rows[0].at).toContain(stored[0]);
    expect({ guards: await guards(client), rows: await rows() }).toEqual(once);
  });
});

describe("a stored hand's shape, on the journalled database", () => {
  let journalled: TestDatabase;

  beforeAll(async () => {
    journalled = await freshDatabase();
  });

  afterAll(async () => {
    await journalled.close();
  });

  it("leaves the new constraint as the only one", async () => {
    const { checks } = await guards(journalled.client);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toContain(`${NEW} valid=true`);
  });

  it.each([[1], [2], [3], [5]])("accepts a hand of %i in each role", async (width) => {
    const ids = hand(width);

    expect(await insertHand(journalled.client, ids)).toEqual(ids);
  });

  /**
   * Zero divides evenly by anything, so "a multiple of the role count" alone
   * lets it through — and it has no element to be NULL and no pair to repeat,
   * so nothing else in the function would stop it either.
   */
  it("refuses a hand of none", async () => {
    await expectRejection(() => insertHand(journalled.client, []), new RegExp(NEW));
  });

  it.each([[1], [2], [4], [5], [7], [8], [10]])(
    "refuses %i ids, which the roles do not divide",
    async (length) => {
      const ids = Array.from({ length }, () => randomUUID());

      await expectRejection(() => insertHand(journalled.client, ids), new RegExp(NEW));
    }
  );

  /**
   * `null <> null` is NULL and a CHECK counts NULL as satisfied; a grouped
   * count has the same blind spot from the other side, because one NULL in a
   * block is a group of one. Every real element is distinct. The last row is
   * the nine `hero-hands-constraints.test.ts` used to try against the old
   * CHECK: eight real ids and a NULL in the ninth slot.
   */
  it.each([
    [2, 0],
    [2, 3],
    [2, 5],
    [3, 8],
  ])("refuses a NULL element: width %i, slot %i", async (width, slot) => {
    const ids: (string | null)[] = hand(width);
    ids[slot] = null;

    await expectRejection(() => insertHand(journalled.client, ids), new RegExp(NEW));
  });

  it("answers false, not NULL, for a NULL array — a CHECK would pass NULL", async () => {
    const result = await journalled.client.query<{ answer: boolean | null }>(
      `select hero_hand_is_well_formed(null, ${ROLES}) as answer`
    );

    expect(result.rows).toEqual([{ answer: false }]);
  });

  /**
   * Each role's block in its own right, at three widths. At four the repeat is
   * the block's first and last slot, so a check that only compared neighbours
   * — or only looked at the first block — fails a row of this table. The rows
   * at three are the ones `hero-hands-constraints.test.ts` used to try against
   * the old CHECK.
   */
  it.each([
    [2, "Vanguard", 0, 1],
    [2, "Duelist", 2, 3],
    [2, "Strategist", 4, 5],
    [3, "Vanguard", 0, 1],
    [3, "Duelist", 3, 4],
    [3, "Strategist", 6, 7],
    [4, "Vanguard", 0, 3],
    [4, "Duelist", 4, 7],
    [4, "Strategist", 8, 11],
  ] as const)(
    "refuses one hero twice inside a role: width %i, %s, slots %i and %i",
    async (width, _role, first, second) => {
      const ids = hand(width);
      ids[second] = ids[first];

      await expectRejection(() => insertHand(journalled.client, ids), new RegExp(NEW));
    }
  );

  /**
   * Deadpool. The same id in two roles is a legal hand, and most of the pairs
   * chosen here are **neighbours** — the last of one role and the first of the
   * next — so a block boundary one slot out refuses them.
   */
  it.each([
    [2, 1, 2],
    [2, 3, 4],
    [4, 3, 4],
    [4, 7, 8],
    [3, 0, 8],
  ] as const)(
    "accepts one hero in two roles: width %i, slots %i and %i",
    async (width, first, second) => {
      const ids = hand(width);
      ids[second] = ids[first];

      expect(await insertHand(journalled.client, ids)).toEqual(ids);
    }
  );

  it("accepts one hero in every role, and one hero as the whole of a width-one hand", async () => {
    const wide = hand(2);
    wide[2] = wide[0];
    wide[4] = wide[0];
    const one = randomUUID();

    expect(await insertHand(journalled.client, wide)).toEqual(wide);
    expect(await insertHand(journalled.client, [one, one, one])).toEqual([one, one, one]);
  });
});
