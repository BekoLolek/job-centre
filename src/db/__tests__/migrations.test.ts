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
      // R-59: a manager's decision that one member may enter, or captain,
      // despite this event's rank rule. drizzle/0021.
      "entry_waivers",
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

  /*
   * 0019, and the thing that makes it worth a test of its own: it is two
   * `ALTER TYPE … ADD VALUE` statements, applied inside the one transaction
   * drizzle wraps every pending migration in. Postgres allows adding a value
   * there but refuses to *use* one in the same transaction, so a backfill
   * written into that file would fail the whole deploy rather than just
   * itself — and `freshDatabase()` above would not have got this far.
   */
  it("adds the third “still coming?” answer, appended to the enum", async () => {
    const result = await ctx.client.query<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'confirmation_state'
       order by e.enumsortorder`
    );
    // Appended, not slotted in: `ADD VALUE` with no `BEFORE` appends, and the
    // order members are offered the three in is CONFIRMATION_CHOICES, not this.
    expect(result.rows.map((r) => r.label)).toEqual(["in", "out", "maybe"]);
  });

  it("adds the answer-deadline reminder as a real notification kind", async () => {
    const result = await ctx.client.query<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'notification_kind'
       order by e.enumsortorder`
    );
    // A kind is a preference (R-104), so it has to be a declared value rather
    // than a string a sender invents — a switch nobody can find otherwise.
    expect(result.rows.map((r) => r.label)).toContain("confirmation_due");
  });

  /*
   * 0021. The other two enums above are tested because a kind or an answer has
   * to be a declared value rather than a string a caller invents; the rule a
   * waiver records is the same kind of thing, and more so — it is what decides
   * who may play. `enter` and `captain` are the whole of R-59, and a third
   * spelling arriving from anywhere would be a waiver nothing in the site knows
   * how to read.
   */
  it("creates the waivable rule as a real Postgres enum", async () => {
    const result = await ctx.client.query<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'entry_rule'
       order by e.enumsortorder`
    );
    expect(result.rows.map((r) => r.label)).toEqual(["enter", "captain"]);
  });

  it("rejects a rule outside the enum, in the database", async () => {
    /*
     * Matched on the message, not just on "it threw": the row below also has
     * two foreign keys to satisfy, so a plain `rejects.toThrow()` would pass
     * for a `event_id` that does not exist and tell us nothing about the enum.
     */
    await expect(
      ctx.client.query(
        `insert into entry_waivers (event_id, user_id, rule)
         values (gen_random_uuid(), gen_random_uuid(), 'spectate')`
      )
    ).rejects.toThrow(/invalid input value for enum entry_rule/i);
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
    expect(await tableNames(ctx.client)).toHaveLength(43);
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

describe("the event-days backfill (drizzle/0020)", () => {
  /**
   * An event's dates are its days' from Task 12 on, so an event whose dates
   * only ever lived on the event row would read as one nobody has scheduled:
   * no date on its card, no countdown, no place in what is coming up, no
   * reminder the day before, no deadline on the "still coming?" answer. 0020
   * gives each of them the day it always had.
   *
   * Exercised against rows that existed **before** it, which is the only case
   * that matters and the one a schema-shaped test would miss entirely — the
   * same reason the Phase 5 handle backfill above boots its own database and
   * replays the migrations by hand.
   */
  it("gives every event whose date only lived on the row a day holding it", async () => {
    const client = new PGlite();
    const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { readdirSync } = await import("node:fs");

    const run = async (tag: string) => {
      const sql = readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
    };

    // Every migration up to but not including 0020, in order, so the rows
    // below are written into the schema as it stood before the backfill.
    const earlier = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort()
      .filter((tag) => tag < "0020");
    for (const tag of earlier) await run(tag);

    await client.exec(`insert into events (slug, title, starts_at, ends_at) values
      ('dated',    'Dated',    '2026-05-01T18:00:00Z', '2026-05-03T22:00:00Z'),
      ('undated',  'Undated',  null,                   null),
      ('has-days', 'Has days', '2026-06-01T18:00:00Z', null),
      ('sketched', 'Sketched', '2026-07-10T18:00:00Z', null),
      ('partly',   'Partly',   '2026-07-20T18:00:00Z', null)`);
    await client.exec(`insert into event_days (event_id, day_index, starts_at)
      select id, 0, '2026-06-02T19:00:00Z' from events where slug = 'has-days'`);
    /*
     * The shape the first statement cannot reach, and the reason there is a
     * second one: a start typed on Basics and a day list sketched with no times
     * on it ("Fri / Sat, times to be agreed" — `event_days.starts_at` is
     * nullable precisely for that). "Has any day row" is not "has any dated day
     * row", so this event was skipped and read as one nobody had scheduled.
     */
    await client.exec(`insert into event_days (event_id, day_index, starts_at, label)
      select id, 0, null, 'Friday' from events where slug = 'sketched'`);
    await client.exec(`insert into event_days (event_id, day_index, starts_at, label)
      select id, 1, null, 'Saturday' from events where slug = 'sketched'`);
    // And the one in between: Day 2 has a time, Day 1 does not. It already has
    // a date, so it must be left exactly as it is.
    await client.exec(`insert into event_days (event_id, day_index, starts_at) values
      ((select id from events where slug = 'partly'), 0, null),
      ((select id from events where slug = 'partly'), 1, '2026-07-21T19:00:00Z')`);

    await run("0020_event_days_backfill");

    const rows = await client.query<{
      slug: string;
      day_index: number | null;
      starts_at: Date | null;
    }>(`select e.slug, d.day_index, d.starts_at
        from events e left join event_days d on d.event_id = e.id
        order by e.slug, d.day_index`);

    const byEvent = new Map<string, Array<{ index: number | null; at: string | null }>>();
    for (const row of rows.rows) {
      const bag = byEvent.get(row.slug) ?? [];
      bag.push({
        index: row.day_index,
        at: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
      });
      byEvent.set(row.slug, bag);
    }

    // The one the migration is for: a Day 1 holding the start it always had.
    expect(byEvent.get("dated")).toEqual([{ index: 0, at: "2026-05-01T18:00:00.000Z" }]);

    /*
     * And the two it must leave alone. An event with no start has nothing to
     * backfill *from* — it had no dates before and has none after, which is a
     * supported state — and an event that already has days has already said
     * when it runs, so its own rows are the answer.
     */
    expect(byEvent.get("undated")).toEqual([{ index: null, at: null }]);
    expect(byEvent.get("has-days")).toEqual([{ index: 0, at: "2026-06-02T19:00:00.000Z" }]);

    /*
     * The undated-days event: its *first* day gains the start it always had
     * (an event starts when its first day does, R-24), and the day nobody has
     * agreed a time for still has none. Without this the event would read as
     * dateless — and `confirmationsOpen` would answer true for ever on an
     * event two days away, which is the worst of the things a null start does.
     */
    expect(byEvent.get("sketched")).toEqual([
      { index: 0, at: "2026-07-10T18:00:00.000Z" },
      { index: 1, at: null },
    ]);

    // And the partially dated one, which already answers "when does it run"
    // from its dated day, is untouched — including its undated Day 1.
    expect(byEvent.get("partly")).toEqual([
      { index: 0, at: null },
      { index: 1, at: "2026-07-21T19:00:00.000Z" },
    ]);

    // Deploys re-run every applied migration, so running it twice must change
    // nothing rather than giving "dated" a second Day 1.
    await run("0020_event_days_backfill");
    const after = await client.query<{ total: string }>(
      `select count(*)::text as total from event_days`
    );
    expect(after.rows[0].total).toBe("6");

    /*
     * Idempotency where it actually bites: the manager moves the day the
     * backfill wrote, and the next deploy re-runs the migration. "Ran twice and
     * nothing changed" would pass even if the update rewrote the same value, so
     * this is the assertion that proves the guard — the day stays where the
     * manager put it rather than being pulled back to the dead column.
     */
    await client.exec(`update event_days set starts_at = '2026-08-15T20:00:00Z'
      where day_index = 0
        and event_id = (select id from events where slug = 'sketched')`);
    await run("0020_event_days_backfill");
    const moved = await client.query<{ starts_at: Date }>(
      `select d.starts_at from event_days d
       join events e on e.id = d.event_id
       where e.slug = 'sketched' and d.day_index = 0`
    );
    expect(new Date(moved.rows[0].starts_at).toISOString()).toBe("2026-08-15T20:00:00.000Z");

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});
