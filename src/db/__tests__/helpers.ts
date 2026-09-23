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
 */
export async function makeHost(
  db: Database,
  eventId: string,
  userId: string
): Promise<void> {
  await db.insert(eventHosts).values({ eventId, userId }).onConflictDoNothing();
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
