import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration.
 *
 * `db:generate` only diffs ./src/db/schema.ts against the snapshots in
 * ./drizzle and never touches a database, so it works with no environment at
 * all. `db:migrate` and `db:studio` do connect, and follow the same rule as
 * src/db/index.ts: DATABASE_URL if it is set, otherwise the local PGlite
 * database under ./data/pg.
 */

const url = process.env.DATABASE_URL?.trim();

export default url
  ? defineConfig({
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      dbCredentials: { url },
      strict: true,
      verbose: true,
    })
  : defineConfig({
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: { url: "./data/pg" },
      strict: true,
      verbose: true,
    });
