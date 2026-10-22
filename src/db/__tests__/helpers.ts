import { PGlite } from "@electric-sql/pglite";
import { type Database, createPgliteDatabase, eventHosts, users } from "@/db";
import { applyMigrations } from "@/db/migrate";

/**
 * A throwaway Postgres for one test file.
 *
 * PGlite with no data directory is entirely in memory, so nothing touches
 * ./data/pg and each file starts from an empty database — but it is still real
 * Postgres 17, so constraints, cascades and jsonb behave exactly as they will
 * on Neon.
 */
export type TestDatabase = { db: Database; client: PGlite; close: () => Promise<void> };

export async function freshDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.waitReady;
  const db = createPgliteDatabase(client);
  await applyMigrations(db, "pglite");
  return { db, client, close: () => client.close() };
}

/**
 * `db`, except that the **first transaction it opens** runs `between` to
 * completion first.
 *
 * Sequenced rather than raced. Two managers acting inside the same second is
 * not something a timer can be trusted to reproduce, and a test that had to
 * *win* a race to see the bug would pass by luck on the days it did not. This
 * pins the interleave exactly: everything the write under test could have read
 * before it opened its transaction is stale, because `between` has already
 * committed.
 *
 * Only the first. The nested call `between` makes re-enters the real handle, so
 * it opens its own transaction normally, and every transaction after it goes
 * straight through.
 *
 * It does **not** flatten the transaction. `between` runs before
 * `target.transaction(run)` is called at all, so the connection is still free
 * when it needs it, and the write under test then gets a real transaction with
 * a real `BEGIN` — which is what makes these tests say something about a
 * decision taken *inside* it. The flattening helpers in `archive-lock.test.ts`
 * and `waivers.test.ts` fire mid-transaction and have to give that up; see the
 * note below.
 *
 * ## Why the other sequencing helpers are not here
 *
 * Six more live beside the tests that use them, and the question a reader of
 * this file will ask is why they were not merged in too. Task 58 in
 * `docs/plan.md` has the long answer; the short one is that they are not
 * variations of one idea, and the thing that differs is the thing that matters:
 * **where the interruption fires.**
 *
 * - `insertingAfter` — three hand-written copies (`hosting.test.ts`,
 *   `championship-events.test.ts`, `waivers.test.ts`). Each flattens the
 *   transaction and hardcodes one builder chain, and the three chains differ:
 *   `.values().onConflictDoNothing()`, `.select().returning()`, and
 *   `.values().onConflictDoNothing().returning()` behind a second nested proxy.
 * - `writingAfter` (`events.test.ts`) — the same device on `update`, aimed at
 *   `.set().where().returning()`.
 * - `completing` / `completingBeforeTheLock` (`archive-lock.test.ts`) —
 *   flattens, proxies all four builders recursively, is aimed by a **regex over
 *   `toSQL()`**, hardcodes its action, and reports whether it `fired()`.
 *
 * Parameterising "where it fires" across those produces a configurable proxy
 * framework harder to read than any of the six, so they are deliberately left
 * as they are. Only the `committingAfter`s were merged, and only because all
 * six were **byte-identical**: there was nothing to parameterise but the handle.
 *
 * `waivers.test.ts` is the evidence rather than the exception. Task 56 moved
 * `waiveEntryRule` into a transaction, the insert its `insertingAfter` aimed at
 * moved onto the `tx`, and the proxy began intercepting the *audit* insert
 * instead — a different chain, which threw inside `recordAudit`'s own catch and
 * failed the test on an empty audit log rather than on anything about two
 * managers. The aim is the part that drifts, which is precisely the part a
 * shared helper could not hold.
 */
export function committingAfter(db: Database, between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) => {
        const first = pending;
        pending = null;
        if (first) await first();
        return target.transaction(run);
      };
    },
  });
}

/**
 * What UC-09 2 requires before an event may be published — a day with a start
 * time and a sign-up window — spread into `createEvent` by any test that
 * publishes. Wide enough, 2000 to 2100, never to get in the way of the test.
 */
export const PUBLISHABLE = {
  signupOpensAt: new Date("2000-01-01T00:00:00Z"),
  signupClosesAt: new Date("2100-01-01T00:00:00Z"),
  days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
};

/** Insert a member and hand back their id. */
export async function makeUser(
  db: Database,
  over: { discordId?: string; displayName?: string; email?: string } = {}
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [row] = await db
    .insert(users)
    .values({
      discordId: over.discordId ?? `discord-${suffix}`,
      displayName: over.displayName ?? `Member ${suffix}`,
      name: over.displayName ?? `Member ${suffix}`,
      email: over.email ?? `${suffix}@example.test`,
    })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Make somebody the host of an event.
 *
 * The one grant (R-86), written straight in. In the site it is only ever
 * written by approving a host application (UC-21 3/4) — `src/lib/hosting.ts`
 * has no add-a-host helper any more, because the co-host helpers it used to
 * export had no caller outside tests, and a permission nothing in the site can
 * reach is a permission nobody has thought about. A fixture is what the tests
 * wanted from them, so the fixture lives here with the other fixtures.
 *
 * ## Why the conflict is targeted
 *
 * At the primary key, which is what `approveHostApplication` does and for the
 * same reason (R-86 / UC-21 5a). A bare `DO NOTHING` forgives *every* unique
 * violation on the table, and since drizzle/0025 that includes
 * `event_hosts_one_host_per_event` — so a fixture asking for a second host on
 * one event would silently get one row and no error, which is exactly the state
 * the index exists to refuse. A fixture that hides the rule it is set up under
 * is worse than one that fails. What stays forgiven is the same grant written
 * twice, which is the pair the key is on and a real no-op.
 */
export async function makeHost(
  db: Database,
  eventId: string,
  userId: string
): Promise<void> {
  await db
    .insert(eventHosts)
    .values({ eventId, userId })
    .onConflictDoNothing({ target: [eventHosts.eventId, eventHosts.userId] });
}

/**
 * Assert a query is rejected by Postgres for the stated reason.
 *
 * drizzle re-throws with a generic "Failed query: …" message and hangs the real
 * Postgres error off `cause`, so a plain `rejects.toThrow(/constraint/)` passes
 * for the wrong reasons — or fails even though the constraint fired. This walks
 * the cause chain and matches against every message in it.
 */
export async function expectRejection(
  run: () => Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected a rejection matching ${pattern}, but the query succeeded.`);
  }

  const messages: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const error = current as { message?: string; cause?: unknown; detail?: string };
    if (error.message) messages.push(error.message);
    if (error.detail) messages.push(error.detail);
    current = error.cause;
  }

  const combined = messages.join("\n");
  if (!pattern.test(combined)) {
    throw new Error(`Rejection did not match ${pattern}. Got:\n${combined}`);
  }
}

/** Table names in the public schema, alphabetical. */
export async function tableNames(client: PGlite): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`
  );
  return result.rows.map((row) => row.table_name);
}
