/**
 * The one database handle (docs/platform-plan.md §3.1).
 *
 * ## Why there are two drivers
 *
 * The plan settles on Neon Postgres in production. But Neon needs a cloud
 * account, and nothing in this repo should require one to be runnable. So the
 * module picks its driver at import time:
 *
 *   DATABASE_URL set    -> Neon serverless driver (`@neondatabase/serverless`)
 *   DATABASE_URL unset  -> PGlite, real Postgres compiled to WASM, persisted
 *                          under ./data/pg (already gitignored)
 *
 * PGlite is not a mock or an emulator — it is Postgres 17, so jsonb, generated
 * uuids, `nulls not distinct` unique constraints and cascade deletes all behave
 * exactly as they will on Neon. The same migrations apply to both.
 *
 * ## Pointing it at Neon later
 *
 * Set DATABASE_URL and nothing else changes. Vercel's Neon integration injects
 * it automatically; locally, put it in .env.local. Removing it drops straight
 * back to the local file-backed database.
 *
 * ## Why callers never branch
 *
 * Both drivers return subclasses of drizzle's `PgDatabase`, so `Database` below
 * is their common supertype, resolved with this schema's relations. Callers get
 * `db.select()`, `db.insert()`, `db.query.users` and so on with identical types
 * whichever driver is live — and note the returns below need no casts, so this
 * is a real structural guarantee rather than an assertion papering over a
 * mismatch. The only place the difference is visible is `migrate.ts`, which has
 * to pick a matching migrator.
 *
 * Transactions: this uses the WebSocket `Pool`, not the HTTP driver. HTTP has no
 * interactive transactions at all — `db.transaction()` throws — and Phase 2 needs
 * them for real: deciding accepted-vs-waitlisted from a count and then inserting
 * has to be atomic, or two people take the last seat. That is a race that would
 * only ever show up in production, on the one night it matters.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Schema = typeof schema;

/**
 * The stable, driver-agnostic database type. Annotate anything that takes a db
 * with this rather than with `PgliteDatabase` or `NeonHttpDatabase`.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

export type DriverKind = "neon" | "pglite";

/** Where the local PGlite database lives. Gitignored via the `/data` rule. */
export const LOCAL_DATA_DIR = "./data/pg";

/** Which driver a given environment selects. Exported so migrate.ts can match. */
export function driverFor(url: string | undefined = process.env.DATABASE_URL): DriverKind {
  return url && url.trim() ? "neon" : "pglite";
}

/**
 * Build a handle. Exported mainly for tests, which pass an in-memory PGlite
 * client, and for scripts that want an explicit connection.
 */
export function createDatabase(options: { url?: string; dataDir?: string } = {}): Database {
  const url = options.url ?? process.env.DATABASE_URL;

  if (driverFor(url) === "neon") {
    return drizzleNeon(new Pool({ connectionString: url as string }), { schema });
  }

  const dataDir = path.resolve(options.dataDir ?? LOCAL_DATA_DIR);
  // PGlite creates its own directory but not the parent, so `./data/pg` fails
  // on a clean checkout until `./data` exists.
  mkdirSync(path.dirname(dataDir), { recursive: true });
  return drizzlePglite(new PGlite(dataDir), { schema });
}

/** Wrap an already-constructed PGlite client. Used by the test suite. */
export function createPgliteDatabase(client: PGlite): Database {
  return drizzlePglite(client, { schema });
}

let instance: Database | undefined;

/** The live handle, built on first use. */
export function getDatabase(): Database {
  return (instance ??= createDatabase());
}

/**
 * The database.
 *
 * Deliberately a lazy proxy rather than an eagerly-constructed handle: merely
 * importing this module — for a type, or from a test that supplies its own
 * client — must not spin up a WASM Postgres or create ./data/pg as a side
 * effect. The first property access builds the real handle; methods are bound
 * to it so `this` is never the proxy.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const real = getDatabase() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, property, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  has(_target, property) {
    return property in (getDatabase() as unknown as object);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getDatabase() as unknown as object);
  },
});
