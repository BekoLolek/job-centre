import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPgliteDatabase, driverFor, games } from "@/db";
import { applyMigrations } from "@/db/migrate";
import { type TestDatabase, freshDatabase, tableNames } from "./helpers";

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
      "applications",
      "audit_log",
      "availability",
      "confirmations",
      "draft_bids",
      "draft_configs",
      "draft_lots",
      "draft_pool_entries",
      "event_days",
      "event_questions",
      "event_templates",
      "events",
      "games",
      // §7 sketched this as `games` too; the catalogue above already has that
      // name, so the per-match maps are `match_games`.
      "match_games",
      "matches",
      "profile_fields",
      "profile_values",
      "sessions",
      "settings",
      "stages",
      "team_members",
      "teams",
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
    expect(await tableNames(ctx.client)).toHaveLength(25);
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
    // seconds of work on its own, and more so with a dozen workers doing the
    // same thing at once. The sibling test below already allows for that.
  }, 30_000);
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
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
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
  }, 30_000);
});
