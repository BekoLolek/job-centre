import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPgliteDatabase, driverFor, games } from "@/db";
import { applyMigrations } from "@/db/migrate";
import { DEFAULT_POINTS_TABLE } from "@/lib/championship-policy";
import { type TestDatabase, freshDatabase, tableNames } from "./helpers";

/**
 * The budget for a test that stands up a WASM Postgres of its own.
 *
 * Sized from a measurement rather than from a guess about contention, which is
 * what `vitest.config.ts` buys by giving this file a project of its own with
 * `fileParallelism: false`. It runs alone, after the parallel groups, so its
 * solo cost is its real cost: measured here at 10.5s for the reopen below, and
 * 6.8s and 4.7s for the two that boot a second PGlite, on a machine that was
 * busy with other work at the time. 30s is roughly three times the worst of
 * those — room for a slower machine or a cold cache, and still short enough
 * that a test which has genuinely hung says so rather than sitting there.
 *
 * The number it replaces was 60s, set at twice a 9.4s solo cost on the
 * assumption that the parallel pool would not cost more than that. It cost
 * seven times as much: the reopen test needed 64.5s under a full run, because
 * it is doing filesystem work on Windows while a dozen workers boot their own
 * WASM Postgres around it. Betting on a contention factor is what the project
 * split removes; this number no longer has to cover one.
 *
 * One constant rather than three literals, so the next person who measures the
 * boot cost changes it in one place.
 */
const PGLITE_BOOT_BUDGET_MS = 30_000;

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

describe("migrations", () => {
  it("apply cleanly to an empty database", async () => {
    expect(await tableNames(ctx.client)).toEqual([
      "accounts",
      "admin_allowlist",
      "applications",
      "audit_log",
      "availability",
      "availability_exceptions",
      "availability_rules",
      "championship_events",
      "championship_placements",
      "championships",
      "confirmations",
      "draft_bids",
      "draft_configs",
      "draft_lots",
      "draft_pool_entries",
      "event_days",
      "event_hosts",
      "event_questions",
      "event_suggestions",
      "event_templates",
      "events",
      "games",
      "host_applications",
      // §7 sketched this as `games` too; the catalogue above already has that
      // name, so the per-match maps are `match_games`.
      "match_games",
      "matches",
      "notification_dm_claims",
      "notification_prefs",
      "notifications",
      "poll_options",
      "poll_votes",
      "polls",
      "profile_fields",
      "profile_values",
      "sessions",
      "settings",
      "stages",
      "suggestion_votes",
      "team_members",
      "teams",
      "user_notes",
      "users",
      "verification_tokens",
    ]);
  });

  it("creates the profile field type as a real Postgres enum", async () => {
    const result = await ctx.client.query<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'profile_field_type'
       order by e.enumsortorder`
    );
    expect(result.rows.map((r) => r.label)).toEqual([
      "select",
      "multiselect",
      "rank",
      "bool",
      "number",
      "text",
    ]);
  });

  it("rejects a profile field type outside the enum", async () => {
    await expect(
      ctx.client.query(
        `insert into profile_fields (key, label, type) values ('bad', 'Bad', 'freeform')`
      )
    ).rejects.toThrow();
  });

  it("records what it applied and does nothing on a second run", async () => {
    const before = await ctx.client.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`
    );
    expect(Number(before.rows[0].count)).toBeGreaterThan(0);

    // Re-running must not throw or duplicate — this is what `npm run db:migrate`
    // does every deploy.
    await applyMigrations(createPgliteDatabase(ctx.client), "pglite");

    const after = await ctx.client.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(await tableNames(ctx.client)).toHaveLength(42);
  });

  it("ships the default points table a new championship starts with", async () => {
    // The column default is spelled out in the migration and the constant lives
    // in the policy module; this is the test that stops the two drifting.
    const result = await ctx.client.query<{ points_table: number[] }>(
      `insert into championships (slug, name) values ('defaults', 'Defaults')
       returning points_table`
    );
    expect(result.rows[0].points_table).toEqual(DEFAULT_POINTS_TABLE);
  });

  it("mints uuid primary keys database-side", async () => {
    const client = new PGlite();
    const db = createPgliteDatabase(client);
    await applyMigrations(db, "pglite");
    const result = await client.query<{ id: string }>(
      `insert into games (key, name) values ('probe', 'Probe') returning id`
    );
    expect(result.rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    await client.close();
    // Booting a second WASM Postgres and replaying every migration into it is
    // seconds of work even with the machine to itself — which this file now
    // has, and which is what makes the budget above a measured number.
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("driver selection", () => {
  it("falls back to PGlite when DATABASE_URL is absent", () => {
    expect(driverFor(undefined)).toBe("pglite");
    // .env.local ships DATABASE_URL as an empty placeholder, so blank must
    // count as unset or local dev would try to dial a nonexistent host.
    expect(driverFor("")).toBe("pglite");
    expect(driverFor("   ")).toBe("pglite");
  });

  it("picks Neon as soon as a connection string exists", () => {
    expect(driverFor("postgresql://user:pw@host/db?sslmode=require")).toBe("neon");
  });
});

describe("the file-backed local database", () => {
  it("creates its directory, migrates, and survives a reopen", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "jobcentre-db-"));
    // Deliberately two levels down: PGlite does not mkdir -p, so createDatabase
    // has to make the parent itself.
    const dataDir = path.join(root, "nested", "pg");

    try {
      // `$client` is the underlying PGlite handle drizzle attaches; the
      // driver-agnostic `Database` type deliberately hides it.
      const first = createDatabase({ url: "", dataDir });
      await applyMigrations(first, "pglite");
      await first.insert(games).values({ key: "persisted", name: "Persisted" });
      await (first as unknown as { $client: PGlite }).$client.close();

      const second = createDatabase({ url: "", dataDir });
      const rows = await second.select().from(games).where(eq(games.key, "persisted"));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Persisted");
      await (second as unknown as { $client: PGlite }).$client.close();
    } finally {
      /*
       * Retries, because this runs on Windows. `close()` resolves when PGlite
       * has let go of its data directory, but the OS can still be holding the
       * handles a moment longer — an antivirus or indexer that opened the
       * files behind us is enough — and `rmSync` then throws EBUSY or EPERM
       * from a `finally` block, failing a test whose assertions all passed.
       * `force` does not cover that: it only forgives a path that is missing.
       */
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("the Phase 5 migration", () => {
  it("gives every member a handle, unique and derived from their name", async () => {
    // A fresh database has no users, so the backfill in 0004 is only ever
    // exercised against rows that existed *before* it — which is the one case
    // that matters and the one a schema-shaped test would miss entirely.
    const client = new PGlite();
    const db = createPgliteDatabase(client);

    const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");

    const run = async (tag: string) => {
      const sql = readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
    };

    for (const tag of ["0000_init", "0001_marvelous_scrambler", "0002_draft", "0003_format"]) {
      await run(tag);
    }

    await client.exec(`insert into users (display_name, name, created_at) values
      ('Beko Lolek', 'bekolek', now() - interval '3 day'),
      ('beko lolek', 'other',   now() - interval '2 day'),
      ('Admin',      'admin',   now() - interval '1 day'),
      (null,         null,      now())`);

    await run("0004_phase5");

    const rows = await client.query<{ display_name: string | null; handle: string }>(
      `select display_name, handle from users order by created_at`
    );
    expect(rows.rows.map((row) => row.handle)).toEqual([
      "beko-lolek",
      // The same name, disambiguated in join order: the member who has been
      // here longest keeps the bare handle.
      "beko-lolek-2",
      // `admin` is reserved, so it is pushed out of the way.
      "admin-player",
      // No name at all still gets something readable.
      "player",
    ]);

    // And the constraint is on, so nothing can collide from here.
    await expect(
      client.query(`update users set handle = 'beko-lolek' where handle = 'player'`)
    ).rejects.toThrow();

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});
