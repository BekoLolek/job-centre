/**
 * Applies the SQL migrations in ./drizzle.
 *
 * Run directly (`npm run db:migrate`) it migrates whatever src/db/index.ts
 * would connect to. Imported, `applyMigrations` takes any handle — the test
 * suite hands it an in-memory PGlite database.
 *
 * The migrator is the one place the driver leaks: drizzle ships a separate
 * migrator per driver because each one runs the SQL through its own session.
 * They are loaded dynamically so the unused one is never even parsed.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Database, type DriverKind, driverFor } from "./index";

/** ./drizzle, resolved from this file rather than from the working directory. */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle"
);

export async function applyMigrations(
  database: Database,
  kind: DriverKind = driverFor(),
  migrationsFolder: string = MIGRATIONS_FOLDER
): Promise<void> {
  if (kind === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    // The migrators are typed against their concrete driver class; `database`
    // is the common supertype, so each call site needs one cast.
    await migrate(database as never, { migrationsFolder });
    return;
  }

  const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
  await migrate(database as never, { migrationsFolder });
}

async function main(): Promise<void> {
  const { db } = await import("./index");
  const kind = driverFor();
  const target = kind === "neon" ? "Neon (DATABASE_URL)" : "local PGlite (./data/pg)";
  console.log(`Applying migrations from ${MIGRATIONS_FOLDER} to ${target}…`);
  await applyMigrations(db, kind);
  console.log("Migrations applied.");
}

// `tsx src/db/migrate.ts` runs this; importing the module does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
