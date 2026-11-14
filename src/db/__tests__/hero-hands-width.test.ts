import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "@/db/migrate";
import { HERO_ROLES } from "@/lib/heroes";
import { type TestDatabase, expectRejection, freshDatabase } from "./helpers";

/**
 * Task 144 — the stored hand stops being nine (R-270, R-271 / UC-58 7, 7a).
 *
 * `hero-hands-constraints.test.ts` is the test of the constraint that says
 * nine, and it is untouched: that constraint is **still on the table** after
 * drizzle/0036, on purpose, and those tests still pass against it.
 *
 * This file is about the one that replaces it, and it runs against two
 * databases because the replacement happens in two deploys:
 *
 *  - **`shipped`** is every journalled migration — what a push to main
 *    produces. Both CHECKs are on the table, so a hand must satisfy both, and
 *    the nine still wins. What can be asserted here is that the new one is
 *    there, validated, and that the old one was not taken away.
 *  - **`later`** is that, plus `drizzle/later/hero_hands_drop_nine.sql` — the
 *    drop, written and not journalled. Only here can a hand of another width
 *    be *inserted*, so only here can the new CHECK be the thing that refuses.
 *
 * Every refusal below names the constraint it expects. A row the old CHECK
 * would also have refused proves nothing about the new one unless the old one
 * is gone, which is why none of the width cases run against `shipped`.
 *
 * The ids are random uuids rather than `heroes` rows: `hero_ids` carries no
 * foreign key (Postgres cannot reference a table from an array element), and
 * a hand of fifteen would otherwise need fifteen rows to say nothing more.
 */

const TAG = "0036_hero_hands_any_width";
const LATER = path.join(MIGRATIONS_FOLDER, "later", "hero_hands_drop_nine.sql");
const OLD = "hero_hands_nine_distinct_per_role";
const NEW = "hero_hands_per_role_distinct";
const ROLES = HERO_ROLES.length;

/** A file's statements, one at a time, as the migrator runs them. */
async function runSql(client: PGlite, file: string): Promise<void> {
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
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

describe("what a push to main leaves on the table (drizzle/0036)", () => {
  let shipped: TestDatabase;

  beforeAll(async () => {
    shipped = await freshDatabase();
  });

  afterAll(async () => {
    await shipped.close();
  });

  /**
   * Additive-first (docs/plan.md's risk register). The old CHECK is not in the
   * way of anything an instance of the previous build does, and taking it away
   * is a second deploy — so "tidying" its drop into 0036 is the regression
   * this test is here to refuse.
   */
  it("keeps the old constraint, and adds the new one beside it, validated", async () => {
    const { checks } = await guards(shipped.client);

    expect(checks.map((check) => check.split(" ").slice(0, 2).join(" "))).toEqual([
      `${OLD} valid=true`,
      `${NEW} valid=true`,
    ]);
  });

  it("drops that constraint in no migration the journal will run", () => {
    const journalled = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(path.join(MIGRATIONS_FOLDER, name), "utf8"))
      .join("\n")
      .replace(/^\s*--.*$/gm, "");

    expect(journalled).toContain(OLD);
    expect(journalled).toContain(NEW);
    expect(journalled).not.toMatch(new RegExp(`drop\\s+constraint[^;]*${OLD}`, "i"));
  });

  /**
   * The role count is a literal in the CHECK, because a CHECK cannot import a
   * constant — the same reason the old one says `9`. This is the one place it
   * meets `HERO_ROLES`, so a fourth role cannot leave them disagreeing in
   * silence. Read from the live constraint, not from this file's belief.
   */
  it("hands the function the number of roles the code deals", async () => {
    const { checks } = await guards(shipped.client);

    expect(checks[1]).toContain(`hero_hand_is_well_formed(hero_ids, ${ROLES})`);
  });

  it("uses a function Postgres will accept in a CHECK for good: immutable", async () => {
    const result = await shipped.client.query<{ provolatile: string }>(
      `select provolatile from pg_proc where proname = 'hero_hand_is_well_formed'`
    );

    expect(result.rows).toEqual([{ provolatile: "i" }]);
  });

  /**
   * Until the drop lands a hand must satisfy both, so six is refused — by the
   * nine. Stated so nobody reads 0036 as the moment another width can be
   * stored: it is the moment the *replacement* is in place.
   */
  it("still refuses six, and it is the old constraint that says so", async () => {
    await expectRejection(() => insertHand(shipped.client, hand(2)), new RegExp(OLD));
  });

  it("still accepts the nine every stored hand is", async () => {
    const ids = hand(3);

    expect(await insertHand(shipped.client, ids)).toEqual(ids);
  });
});

describe("running drizzle/0036 over hands that already exist, and again", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    const earlier = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql") && name.replace(/\.sql$/, "") < TAG)
      .sort();
    for (const name of earlier) await runSql(client, path.join(MIGRATIONS_FOLDER, name));
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

    await runSql(client, path.join(MIGRATIONS_FOLDER, `${TAG}.sql`));
    const once = { guards: await guards(client), rows: await rows() };
    await runSql(client, path.join(MIGRATIONS_FOLDER, `${TAG}.sql`));

    expect(once.guards.checks).toHaveLength(2);
    expect(once.guards.checks[1]).toContain(`${NEW} valid=true`);
    expect(once.guards.functions).toHaveLength(1);
    expect(once.rows[0].at).toContain(stored[0]);
    expect({ guards: await guards(client), rows: await rows() }).toEqual(once);
  });
});

describe("once the nine is dropped (drizzle/later, not journalled)", () => {
  let later: TestDatabase;

  beforeAll(async () => {
    later = await freshDatabase();
    // Twice: the drop is as re-runnable as the file it follows.
    await runSql(later.client, LATER);
    await runSql(later.client, LATER);
  });

  afterAll(async () => {
    await later.close();
  });

  it("leaves the new constraint as the only one", async () => {
    const { checks } = await guards(later.client);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toContain(`${NEW} valid=true`);
  });

  it.each([[1], [2], [3], [5]])("accepts a hand of %i in each role", async (width) => {
    const ids = hand(width);

    expect(await insertHand(later.client, ids)).toEqual(ids);
  });

  /**
   * Zero divides evenly by anything, so "a multiple of the role count" alone
   * lets it through — and it has no element to be NULL and no pair to repeat,
   * so nothing else in the function would stop it either.
   */
  it("refuses a hand of none", async () => {
    await expectRejection(() => insertHand(later.client, []), new RegExp(NEW));
  });

  it.each([[1], [2], [4], [5], [7], [8], [10]])(
    "refuses %i ids, which the roles do not divide",
    async (length) => {
      const ids = Array.from({ length }, () => randomUUID());

      await expectRejection(() => insertHand(later.client, ids), new RegExp(NEW));
    }
  );

  /**
   * `null <> null` is NULL and a CHECK counts NULL as satisfied; a grouped
   * count has the same blind spot from the other side, because one NULL in a
   * block is a group of one. Six elements, the five real ones all distinct.
   */
  it.each([[0], [3], [5]])("refuses a NULL element at slot %i of six", async (slot) => {
    const ids: (string | null)[] = hand(2);
    ids[slot] = null;

    await expectRejection(() => insertHand(later.client, ids), new RegExp(NEW));
  });

  it("answers false, not NULL, for a NULL array — a CHECK would pass NULL", async () => {
    const result = await later.client.query<{ answer: boolean | null }>(
      `select hero_hand_is_well_formed(null, ${ROLES}) as answer`
    );

    expect(result.rows).toEqual([{ answer: false }]);
  });

  /**
   * Each role's block in its own right, at two widths. At four the repeat is
   * the block's first and last slot, so a check that only compared neighbours
   * — or only looked at the first block — fails a row of this table.
   */
  it.each([
    [2, "Vanguard", 0, 1],
    [2, "Duelist", 2, 3],
    [2, "Strategist", 4, 5],
    [4, "Vanguard", 0, 3],
    [4, "Duelist", 4, 7],
    [4, "Strategist", 8, 11],
  ] as const)(
    "refuses one hero twice inside a role: width %i, %s, slots %i and %i",
    async (width, _role, first, second) => {
      const ids = hand(width);
      ids[second] = ids[first];

      await expectRejection(() => insertHand(later.client, ids), new RegExp(NEW));
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

      expect(await insertHand(later.client, ids)).toEqual(ids);
    }
  );

  it("accepts one hero in every role, and one hero as the whole of a width-one hand", async () => {
    const wide = hand(2);
    wide[2] = wide[0];
    wide[4] = wide[0];
    const one = randomUUID();

    expect(await insertHand(later.client, wide)).toEqual(wide);
    expect(await insertHand(later.client, [one, one, one])).toEqual([one, one, one]);
  });
});
