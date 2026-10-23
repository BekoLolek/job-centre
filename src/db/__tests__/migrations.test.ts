import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPgliteDatabase, driverFor, games } from "@/db";
import { applyMigrations } from "@/db/migrate";
import { seed } from "@/db/seed";
import { DEFAULT_POINTS_TABLE } from "@/lib/championship-policy";
import { createTemplate } from "@/lib/admin-templates";
import { createEvent } from "@/lib/events";
import { canManageEvent } from "@/lib/hosting";
import { type TestDatabase, expectRejection, freshDatabase, tableNames } from "./helpers";

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
      // R-205, R-206, R-207 / UC-38 5a: which channel announcements have been
      // claimed, one row per kind per event. drizzle/0030 — a second claim
      // table rather than a column on `notification_dm_claims`, because a
      // channel announcement has no recipient.
      "announcement_claims",
      // R-201, R-202: an admin's own wording for one announcement kind, and
      // who it mentions. drizzle/0029 — and it starts empty on every install,
      // because the absence of a row *is* "unedited".
      "announcement_templates",
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
      // R-212 / UC-39 3a, 3b, 5a, 6a: the nine heroes one participant was
      // dealt for one event. drizzle/0032 — one row per (event, user), and the
      // unique constraint on that pair *is* "dealt once and it stands" rather
      // than an index for speed. Empty on every install: nothing has ever dealt
      // a hand, so a backfill could only invent them.
      "hero_hands",
      // R-214 / UC-40: one game's heroes and the roles each may be played in.
      // drizzle/0031 — and it starts empty on every install, because the 54 are
      // the seed's to plant and an admin's to correct, not a migration's.
      "heroes",
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

  /*
   * drizzle/0026, from the schema side: an event's dates are its days'
   * (R-24 / UC-11 2), so `events` has no date of its own to read.
   *
   * The whole column list rather than two `not.toContain`s, because the claim
   * worth pinning is "there is no second place an event's dates could live",
   * and a column added later that happened not to be called `starts_at` would
   * satisfy the narrower assertion. This is also the assertion that three unit
   * tests used to make by writing a row and checking the column came back null:
   * they could only ever prove the column was *empty*, and this proves there is
   * no column.
   */
  it("leaves the events table no dates of its own", async () => {
    const columns = await ctx.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'events'
       order by column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "banner_url",
      "capacity",
      "config",
      "created_at",
      "created_by",
      "created_from_template_id",
      "description",
      "game_id",
      "id",
      "min_rank_to_captain",
      "min_rank_to_enter",
      // The sign-up window is the event's own and stays: it is typed on Basics
      // and is derived from nothing (R-25).
      "signup_closes_at",
      "signup_opens_at",
      "slug",
      "status",
      "title",
      "type",
      "updated_at",
    ]);
  });

  /*
   * And the index that only read one of them. `events_status_starts_at_idx` was
   * `(status, starts_at)`; nothing orders or filters by that column — the
   * soonest-first order is `eventDates` over `event_days`, in TypeScript — so
   * it was two columns of write cost for a query nobody makes.
   *
   * The assertion that earns its place here is the *list*, not the absence.
   * Postgres drops an index with the last column it covers, so 0026's explicit
   * `DROP INDEX` is belt and braces and no test can tell whether it ran. What
   * nothing else would catch is a replacement: Task 50 says a new index must be
   * justified by a query and measured first, and src/db/schema.ts names the one
   * query that would use a plain `status` index and why it is not added on a
   * guess. An index arriving unmeasured fails this.
   */
  it("leaves no index on the dropped date column", async () => {
    const indexes = await ctx.client.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'events'
       order by indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "events_created_from_template_idx",
      "events_game_id_idx",
      "events_pkey",
      "events_slug_unique",
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
    // 47 since drizzle/0032 added `hero_hands`. The list itself is asserted by
    // name in the first test in this file, which is the one to read on a
    // mismatch; this count is here so a second pass that *created* something
    // cannot hide behind a list that was updated to expect it.
    expect(await tableNames(ctx.client)).toHaveLength(47);
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

describe("one host per event (drizzle/0025)", () => {
  /**
   * The constraint, and what it does to the rows it finds.
   *
   * `CREATE UNIQUE INDEX` does not skip the rows that offend it — it fails, and
   * takes the deploy and every later migration with it. `DATABASE_URL` is blank
   * in this working copy by design, so nobody can look at production first and
   * find out whether an event already has two host rows. That is what makes the
   * three fixtures below the point of the test rather than a formality: an
   * event nobody hosts, an event with one host, and the one that would have
   * killed the deploy.
   *
   * Replayed by hand against the schema as it stood at 0024, for the same
   * reason the two backfills above are: a fresh database has no host rows, so
   * applying 0025 to one proves only that the SQL parses.
   */
  it("keeps the earlier grant, tells the member it dropped, and then holds the rule", async () => {
    const client = new PGlite();
    const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");

    const run = async (tag: string) => {
      const sql = readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
    };

    const earlier = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort()
      .filter((tag) => tag < "0025");
    for (const tag of earlier) await run(tag);

    await client.exec(`insert into users (name, display_name) values
      ('alone',   'Alone Ali'),
      ('kept',    'Kept Kiri'),
      ('dropped', 'Dropped Dee'),
      ('later',   'Later Lena')`);
    await client.exec(`insert into events (slug, title) values
      ('nobody',    'Nobody hosts this'),
      ('one-host',  'One host'),
      ('two-hosts', 'Friday REPO night')`);
    /*
     * The two grants are three seconds apart, which is what the race looks like
     * afterwards: two admins on two screens, both approving onto the event one
     * of them had just created.
     */
    await client.exec(`insert into event_hosts (event_id, user_id, granted_at) values
      ((select id from events where slug = 'one-host'),
       (select id from users where name = 'alone'),   '2026-03-01T10:00:00Z'),
      ((select id from events where slug = 'two-hosts'),
       (select id from users where name = 'kept'),    '2026-03-02T19:04:11Z'),
      ((select id from events where slug = 'two-hosts'),
       (select id from users where name = 'dropped'), '2026-03-02T19:04:14Z')`);

    const grants = async () =>
      (
        await client.query<{ slug: string; name: string }>(
          `select e.slug, u.name from event_hosts h
           join events e on e.id = h.event_id
           join users u on u.id = h.user_id
           order by e.slug, u.name`
        )
      ).rows;

    // Before: the shape that fails the CREATE.
    expect(await grants()).toEqual([
      { slug: "one-host", name: "alone" },
      { slug: "two-hosts", name: "dropped" },
      { slug: "two-hosts", name: "kept" },
    ]);

    await run("0025_event_host_one_per_event");

    /*
     * After: the **earlier** of the two grants survives. A host grant is a
     * permission somebody has been using rather than an intention they most
     * recently had — the opposite of drizzle/0018, which kept the newest
     * pending application for exactly that reason. `linkableEvents` stops
     * offering an event the moment it has a host, so the later row was never
     * something an admin was offered, and keeping it would take the event away
     * from whoever has been running it.
     */
    expect(await grants()).toEqual([
      { slug: "one-host", name: "alone" },
      { slug: "two-hosts", name: "kept" },
    ]);

    /*
     * And the member who lost it is told, rather than quietly losing a
     * permission they were notified about when they got it (UC-21 4). The kind
     * is the one their approval used, which is `fixed` in `notify-policy.ts`
     * and so cannot have been muted.
     */
    const told = await client.query<{
      name: string;
      kind: string;
      title: string;
      href: string;
      slug: string | null;
    }>(`select u.name, n.kind, n.title, n.href, e.slug
        from notifications n
        join users u on u.id = n.user_id
        left join events e on e.id = n.event_id`);
    expect(told.rows).toEqual([
      {
        name: "dropped",
        kind: "host_decision",
        title: "You are no longer hosting Friday REPO night",
        href: "/host",
        slug: "two-hosts",
      },
    ]);

    // And the admins are told, under the event, which is where the log gets
    // filtered when somebody asks what happened (R-110 / UC-27 3).
    const logged = await client.query<{
      action: string;
      slug: string;
      summary: string;
      detail: { keptUserId: string; removedUserId: string; removedGrantedAt: string };
    }>(`select a.action, e.slug, a.summary, a.detail
        from audit_log a join events e on e.id = a.event_id`);
    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0].action).toBe("host.grant_superseded");
    expect(logged.rows[0].slug).toBe("two-hosts");
    expect(logged.rows[0].summary).toMatch(/one grant per event \(R-86\)/);

    const ids = new Map(
      (
        await client.query<{ name: string; id: string }>(`select name, id from users`)
      ).rows.map((row) => [row.name, row.id])
    );
    expect(logged.rows[0].detail.keptUserId).toBe(ids.get("kept"));
    expect(logged.rows[0].detail.removedUserId).toBe(ids.get("dropped"));
    // UTC, not the deploy machine's zone: `::text` on a timestamptz renders in
    // the session's TimeZone, and a logged instant that moves with the server
    // is not a logged instant.
    expect(logged.rows[0].detail.removedGrantedAt).toBe("2026-03-02T19:04:14Z");

    /*
     * The acceptance criterion a constraint like this quietly breaks: the host
     * it keeps must still *be* a host. `requireEventManager` is
     * `canManageEvent` plus a redirect, so a grant this migration orphaned
     * would turn a working permission into a bounce to `/me`. Asked of the real
     * permission function, over this throwaway database.
     */
    const db = createPgliteDatabase(client);
    const eventIds = new Map(
      (
        await client.query<{ slug: string; id: string }>(`select slug, id from events`)
      ).rows.map((row) => [row.slug, row.id])
    );
    const twoHosts = eventIds.get("two-hosts") as string;
    expect(
      await canManageEvent({ id: ids.get("kept") as string, isAdmin: false }, twoHosts, db)
    ).toBe(true);
    expect(
      await canManageEvent({ id: ids.get("dropped") as string, isAdmin: false }, twoHosts, db)
    ).toBe(false);
    // And the event the migration had no reason to touch is untouched.
    expect(
      await canManageEvent(
        { id: ids.get("alone") as string, isAdmin: false },
        eventIds.get("one-host") as string,
        db
      )
    ).toBe(true);

    /*
     * Applied twice by hand — which is the only way this file can be applied
     * twice, since a deploy runs every pending migration inside one
     * transaction and rolls the whole thing back. The DELETE leaves both
     * inserts nothing to find, the notification has `ON CONFLICT DO NOTHING`
     * besides, and the index is created `IF NOT EXISTS`, so a second pass must
     * change nothing rather than throw, or write the dropped member a second
     * copy of the same news. (A hand run stopped *before* the DELETE and then
     * resumed is the one case that does double, and only the audit line; the
     * file says so.)
     */
    await run("0025_event_host_one_per_event");
    expect(await grants()).toEqual([
      { slug: "one-host", name: "alone" },
      { slug: "two-hosts", name: "kept" },
    ]);
    expect(
      (
        await client.query<{ total: string }>(
          `select count(*)::text as total from notifications`
        )
      ).rows[0].total
    ).toBe("1");
    expect(
      (await client.query<{ total: string }>(`select count(*)::text as total from audit_log`))
        .rows[0].total
    ).toBe("1");

    // The event nobody hosted is still free, and may still be given a host.
    await client.exec(`insert into event_hosts (event_id, user_id)
      select (select id from events where slug = 'nobody'), id
      from users where name = 'later'`);

    // And from here the rule is the database's, not a read's.
    await expectRejection(
      () =>
        client.query(
          `insert into event_hosts (event_id, user_id)
           select (select id from events where slug = 'nobody'), id
           from users where name = 'dropped'`
        ),
      /event_hosts_one_host_per_event/
    );

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("dropping the dead date columns (drizzle/0026)", () => {
  /**
   * Replaying the migrations by hand, for the same reason the three backfills
   * above do: a fresh database has no events, so applying 0026 to one proves
   * only that the SQL parses. What has to be proved is what it does to the rows
   * drizzle/0020 left behind — and in particular that the day 0020 wrote from
   * the column is still there once the column is gone, which is the one thing
   * this commit could silently destroy.
   */
  const replay = async (client: PGlite, upTo: string, from = "0000") => {
    const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
    const { readFileSync, readdirSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const tags = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort()
      .filter((tag) => tag >= from && tag < upTo);
    for (const tag of tags) {
      const sql = readFileSync(nodePath.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
    }
  };

  const runDrop = async (client: PGlite) => {
    const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const sql = readFileSync(
      nodePath.join(MIGRATIONS_FOLDER, "0026_event_dates_dropped.sql"),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  };

  /** Which of the two date columns are still on the table, alphabetical. */
  const dateColumns = async (client: PGlite) =>
    (
      await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'events' and column_name in ('starts_at', 'ends_at')
         order by column_name`
      )
    ).rows.map((row) => row.column_name);

  const hasOldIndex = async (client: PGlite) =>
    (
      await client.query(
        `select 1 from pg_indexes where tablename = 'events'
           and indexname = 'events_status_starts_at_idx'`
      )
    ).rows.length > 0;

  /** Every day row, as "slug#index=instant", so one assertion covers the lot. */
  const dayRows = async (client: PGlite) =>
    (
      await client.query<{ slug: string; day_index: number | null; at: string | null }>(
        `select e.slug, d.day_index,
                to_char(d.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
         from events e left join event_days d on d.event_id = e.id
         order by e.slug, d.day_index`
      )
    ).rows.map((row) => `${row.slug}#${row.day_index ?? "-"}=${row.at ?? "null"}`);

  const auditTotal = async (client: PGlite) =>
    (await client.query<{ total: string }>(`select count(*)::text as total from audit_log`))
      .rows[0].total;

  it("replays the backfill, then the drop, and the backfilled day survives", async () => {
    const client = new PGlite();
    await replay(client, "0020");

    /*
     * The rows as they were written while the event row *was* the calendar,
     * covering every shape 0020 distinguishes:
     *
     *  - `only-column` has a start and no days at all. 0020's insert gives it
     *    a Day 1 — and that day is the whole point of this test, because after
     *    0026 it is the only record of when the event is on.
     *  - `sketched` has a start and a day list with no times on it. 0020's
     *    second statement dates its first day.
     *  - `partly` has Day 2 dated and Day 1 not. 0020 leaves it alone on
     *    purpose, so its `starts_at` is a start no day says.
     *  - `span` was set up as one start plus one end. 0020 backfills the start
     *    and never touches the end.
     *  - `undated` never had a date at all, which is a supported state.
     */
    await client.exec(`insert into events (slug, title, starts_at, ends_at) values
      ('only-column', 'Only the column', '2026-05-01T18:00:00Z', null),
      ('sketched',    'Times to agree',  '2026-07-10T18:00:00Z', null),
      ('partly',      'Partly dated',    '2026-07-20T18:00:00Z', null),
      ('span',        'Start and end',   '2026-06-01T18:00:00Z', '2026-06-03T22:00:00Z'),
      ('undated',     'Never timed',     null,                   null)`);
    await client.exec(`insert into event_days (event_id, day_index, starts_at, label) values
      ((select id from events where slug = 'sketched'), 0, null, 'Friday'),
      ((select id from events where slug = 'sketched'), 1, null, 'Saturday'),
      ((select id from events where slug = 'partly'),   0, null, null),
      ((select id from events where slug = 'partly'),   1, '2026-07-21T19:00:00Z', null)`);

    // 0020 onwards, on top of the database the fixtures were written into.
    await replay(client, "0026", "0020");

    // Before: both columns, the index, and the days 0020 produced.
    expect(await dateColumns(client)).toEqual(["ends_at", "starts_at"]);
    expect(await hasOldIndex(client)).toBe(true);
    const before = await dayRows(client);
    expect(before).toEqual([
      "only-column#0=2026-05-01T18:00:00Z",
      "partly#0=null",
      "partly#1=2026-07-21T19:00:00Z",
      "sketched#0=2026-07-10T18:00:00Z",
      "sketched#1=null",
      "span#0=2026-06-01T18:00:00Z",
      "undated#-=null",
    ]);

    await runDrop(client);

    // After: no columns, no index — and **every day row exactly as it was**.
    expect(await dateColumns(client)).toEqual([]);
    expect(await hasOldIndex(client)).toBe(false);
    expect(await dayRows(client)).toEqual(before);

    /*
     * And the instants no day row holds are written down rather than deleted.
     * 0020 said this was "the commit that should look at the live rows and
     * decide whether any of them wants real days typed in"; nobody can look at
     * a dropped column, so the two that disagree are logged against their
     * event, which is where an admin filtering the log will look (R-110 /
     * UC-27 3).
     *
     * `only-column` and `sketched` are **not** here, and that is the assertion
     * that makes this mean something: their day rows already hold exactly what
     * their columns held, so there is nothing to record.
     */
    const logged = await client.query<{
      slug: string;
      detail: {
        columnStartsAt: string | null;
        columnEndsAt: string | null;
        firstDatedDay: string | null;
      };
    }>(`select e.slug, a.detail from audit_log a
        join events e on e.id = a.event_id
        where a.action = 'event.dates_column_dropped'
        order by e.slug`);
    expect(logged.rows.map((row) => row.slug)).toEqual(["partly", "span"]);

    // The partially dated event: its column said the 20th, its days say the
    // 21st, and the 21st is what the site reads. Both are in the log.
    expect(logged.rows[0].detail.columnStartsAt).toBe("2026-07-20T18:00:00Z");
    expect(logged.rows[0].detail.firstDatedDay).toBe("2026-07-21T19:00:00Z");

    // And the end 0020 never backfilled, which was nowhere else at all.
    expect(logged.rows[1].detail.columnEndsAt).toBe("2026-06-03T22:00:00Z");

    /*
     * Deploys re-run every applied migration. The block returns the moment the
     * column is gone, so a second pass must change nothing — not throw on a
     * column that no longer exists, and not write a second copy of the log.
     */
    await runDrop(client);
    expect(await dateColumns(client)).toEqual([]);
    expect(await dayRows(client)).toEqual(before);
    expect(await auditTotal(client)).toBe("2");

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);

  /**
   * A start no dated day holds: written down, and **not** a failed deploy.
   *
   * This shape is the one the file used to `RAISE EXCEPTION` over, on the
   * grounds that 0020's two statements leave no such row behind — so a row in
   * it meant something wrote the column afterwards. There is a third cause, and
   * it is an ordinary manager using the Days tab: `setEventDays` writes
   * `startsAt: day.startsAt ?? null`, `dayListProblem` asks for neither a time
   * nor a minimum day count, and an undated day list is the documented "times
   * to be agreed" state. So all three ways in are exercised here:
   *
   *  - `orphan` had the column written after 0020 ran;
   *  - `detimed` is a legacy event whose day 0020 backfilled and whose manager
   *    then cleared the time on it;
   *  - `daysgone` is the same event whose manager deleted the day list.
   *
   * None of them may stop the deploy, because none of them changes anything on
   * screen: nothing in src/ has read either column since Task 12, and
   * `eventDates` already answers `null` for an event with no dated day, so each
   * of these read as undated before the drop and reads as undated after it.
   * Stopping would halt every migration behind it over a state the site
   * supports, and the old HINT's remedy — give them a dated day — would re-date
   * an event somebody deliberately un-dated.
   *
   * What the file must still do is lose nothing: the audit insert covers this
   * shape, so the instant is on the record against its event before the column
   * goes. That is the assertion, and it is the one the exception was for.
   */
  it("records a start no day holds, however it got that way, and drops anyway", async () => {
    const client = new PGlite();
    await replay(client, "0020");

    /*
     * `detimed` and `daysgone` go in *before* 0020 with a start and no days, so
     * 0020's insert backfills a Day 1 for each of them — which is what makes
     * them legacy events rather than fixtures, and what their managers then
     * undo below.
     */
    await client.exec(`insert into events (slug, title, starts_at) values
      ('ordinary', 'Has a dated day',  '2026-04-01T18:00:00Z'),
      ('detimed',  'Times withdrawn',  '2026-08-01T18:00:00Z'),
      ('daysgone', 'Days deleted',     '2026-09-01T18:00:00Z')`);
    await client.exec(`insert into event_days (event_id, day_index, starts_at)
      select id, 0, '2026-04-01T18:00:00Z' from events where slug = 'ordinary'`);

    await replay(client, "0026", "0020");
    expect(await dayRows(client)).toEqual([
      "daysgone#0=2026-09-01T18:00:00Z",
      "detimed#0=2026-08-01T18:00:00Z",
      "ordinary#0=2026-04-01T18:00:00Z",
    ]);

    // The manager's two edits, and the one thing 0020 cannot have left behind.
    await client.exec(`update event_days set starts_at = null
      where event_id = (select id from events where slug = 'detimed')`);
    await client.exec(`delete from event_days
      where event_id = (select id from events where slug = 'daysgone')`);
    await client.exec(`insert into events (slug, title, starts_at)
      values ('orphan', 'Only the column knows', '2026-10-10T18:00:00Z')`);

    await runDrop(client);

    // Dropped, and every day row exactly as its manager left it.
    expect(await dateColumns(client)).toEqual([]);
    expect(await hasOldIndex(client)).toBe(false);
    expect(await dayRows(client)).toEqual([
      "daysgone#-=null",
      "detimed#0=null",
      "ordinary#0=2026-04-01T18:00:00Z",
      "orphan#-=null",
    ]);

    /*
     * And all three instants are on the record, with `firstDatedDay` null —
     * which is the whole point of the row: it says the column held a start and
     * the days held none, so an admin can see what was there and decide.
     *
     * `ordinary` is **not** here, and that is the assertion that makes this mean
     * something: its day holds exactly what its column held, so there is
     * nothing to record.
     */
    const logged = await client.query<{
      slug: string;
      detail: { columnStartsAt: string | null; firstDatedDay: string | null };
    }>(`select e.slug, a.detail from audit_log a
        join events e on e.id = a.event_id
        where a.action = 'event.dates_column_dropped'
        order by e.slug`);
    expect(
      logged.rows.map((row) => [row.slug, row.detail.columnStartsAt, row.detail.firstDatedDay])
    ).toEqual([
      ["daysgone", "2026-09-01T18:00:00Z", null],
      ["detimed", "2026-08-01T18:00:00Z", null],
      ["orphan", "2026-10-10T18:00:00Z", null],
    ]);

    // Replayed: the block returns on the missing column, so nothing is logged
    // twice and nothing throws.
    await runDrop(client);
    expect(await auditTotal(client)).toBe("3");

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

/**
 * Apply the migration files from `from` up to but not including `upTo`.
 *
 * The same loop the two describes above each wrote for themselves, hoisted
 * because three files now need it. Tags rather than filenames, read out of the
 * folder and sorted, so adding a migration needs nothing here.
 */
const replayUpTo = async (client: PGlite, upTo: string, from = "0000") => {
  const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
  const { readFileSync, readdirSync } = await import("node:fs");
  const nodePath = await import("node:path");
  const tags = readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort()
    .filter((tag) => tag >= from && tag < upTo);
  for (const tag of tags) {
    const sql = readFileSync(nodePath.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
};

/** How many audit lines this throwaway database holds, as text. */
const auditCount = async (client: PGlite) =>
  (await client.query<{ total: string }>(`select count(*)::text as total from audit_log`))
    .rows[0].total;

/** One named migration file, statement by statement. */
const runFile = async (client: PGlite, tag: string) => {
  const { MIGRATIONS_FOLDER } = await import("@/db/migrate");
  const { readFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  const sql = readFileSync(nodePath.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
};

describe("a template carries the whole setup (drizzle/0027)", () => {
  /**
   * The claim 0027's comment makes, asked of real rows instead of left as prose.
   *
   * The file has **no data statement at all**, which is unlike 0015, 0018, 0020
   * and 0025, so what has to be proved is the reason: that the four defaults are
   * already what the old behaviour was, and a template written before the
   * columns existed goes on producing exactly the event it produced yesterday.
   *
   * A fresh database proves nothing here — it has no templates — so the row
   * goes in against the schema as it stood at 0026 and the columns arrive
   * underneath it.
   */
  it("leaves a template that predates the columns producing the same event", async () => {
    const client = new PGlite();
    await replayUpTo(client, "0027");

    await client.exec(
      `insert into event_templates (name, type, config, questions)
       values ('Legacy Jackbox', 'social', '{"waitlist": false}'::jsonb, '[]'::jsonb)`
    );

    // The columns are not there yet, which is what makes the row legacy.
    const setupColumns = async () =>
      (
        await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
           where table_name = 'event_templates'
             and column_name in ('capacity', 'min_rank_to_enter', 'min_rank_to_captain', 'days')
           order by column_name`
        )
      ).rows.map((row) => row.column_name);
    expect(await setupColumns()).toEqual([]);

    await runFile(client, "0027_template_setup");

    expect(await setupColumns()).toEqual([
      "capacity",
      "days",
      "min_rank_to_captain",
      "min_rank_to_enter",
    ]);

    /*
     * Inert on the existing row, which is the whole of what the file claims:
     * null is "no cap" and "no threshold" on `events` as well, and `'[]'` is
     * the day list `createEvent` was already writing for a template that named
     * no days.
     */
    const [legacy] = (
      await client.query<{
        capacity: number | null;
        min_rank_to_enter: string | null;
        min_rank_to_captain: string | null;
        days: unknown;
        config: Record<string, unknown>;
      }>(`select capacity, min_rank_to_enter, min_rank_to_captain, days, config
          from event_templates where name = 'Legacy Jackbox'`)
    ).rows;
    expect(legacy.capacity).toBeNull();
    expect(legacy.min_rank_to_enter).toBeNull();
    expect(legacy.min_rank_to_captain).toBeNull();
    expect(legacy.days).toEqual([]);
    // And nothing was moved out of `config` into them, so the settings the old
    // template did carry are untouched.
    expect(legacy.config).toEqual({ waitlist: false });

    /*
     * Asked of the real function, over this throwaway database, exactly as the
     * 0025 test asks `canManageEvent`: "produces the same event as yesterday"
     * is a claim about `createEvent`, and reading the four columns back only
     * proves they are null.
     */
    const db = createPgliteDatabase(client);
    const [{ id: templateId }] = (
      await client.query<{ id: string }>(
        `select id from event_templates where name = 'Legacy Jackbox'`
      )
    ).rows;

    const created = await createEvent({ title: "From a legacy template", templateId }, db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.capacity).toBeNull();
    expect(created.data.minRankToEnter).toBeNull();
    expect(created.data.minRankToCaptain).toBeNull();
    expect(created.data.startsAt).toBeNull();
    expect(
      (
        await client.query(
          `select 1 from event_days where event_id = '${created.data.id}'::uuid`
        )
      ).rows
    ).toEqual([]);
    // The one thing it always did carry is still carried.
    expect(created.data.config.waitlist).toBe(false);

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("an announcement's wording, and no backfill (drizzle/0029)", () => {
  /**
   * The claim 0029's comment makes, asked of the real builders instead of left
   * as prose.
   *
   * The file has **no data statement at all** — like drizzle/0027 and unlike
   * 0015, 0018, 0020 and 0025 — so what has to be proved is its reason: that
   * the absence of a row *is* "unedited", and that every announcement on a
   * deployment that had this migration applied under it goes on posting
   * **byte for byte** what it posted before. A schema-shaped test would only
   * prove the SQL parses.
   *
   * The byte comparison is against the output of the same builders called with
   * no override at all, which is the code path every install was on before
   * this commit — so this is not a golden string somebody typed, it is the two
   * paths asserted equal.
   */
  it("leaves every kind posting exactly what it posted before the table existed", async () => {
    const client = new PGlite();
    await replayUpTo(client, "0029");

    const hasTable = async () =>
      (
        await client.query(
          `select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'announcement_templates'`
        )
      ).rows.length > 0;

    // Not there yet, which is what makes this a deployment rather than a
    // fresh database.
    expect(await hasTable()).toBe(false);

    await runFile(client, "0029_announcement_templates");
    expect(await hasTable()).toBe(true);

    /*
     * **Empty.** The whole of the no-backfill claim: the migration writes no
     * rows, so there is no frozen copy of any kind's sentence anywhere.
     */
    const rows = await client.query<{ total: string }>(
      `select count(*)::text as total from announcement_templates`
    );
    expect(rows.rows[0].total).toBe("0");

    const db = createPgliteDatabase(client);
    const { getAnnouncementTemplates } = await import("@/lib/discord");
    const announce = await import("@/lib/announce");

    // Read through the function the announcers actually use, over the database
    // the migration just created.
    const stored = await getAnnouncementTemplates(db);

    const at = new Date("2026-05-01T18:00:00Z");
    const top = {
      lead: "changed",
      rows: [{ position: 1, name: "Beko Lolek", points: 25, level: false }],
    } as unknown as Parameters<typeof announce.standingsMessage>[0]["top"];

    /*
     * One pair per kind: the message built with what the database says, and the
     * message built with no override at all. The first is what a deployment
     * posts after this migration; the second is what it posted before there was
     * a table to read. `JSON.stringify` because "byte for byte" is a claim
     * about the body Discord receives, key order included.
     */
    const pairs: Array<[string, string, string]> = [
      [
        "event_published",
        JSON.stringify(
          announce.eventPublishedMessage(
            { title: "Friday REPO night", slug: "friday-repo", capacity: 12, startsAt: at },
            stored.event_published
          )
        ),
        JSON.stringify(
          announce.eventPublishedMessage({
            title: "Friday REPO night",
            slug: "friday-repo",
            capacity: 12,
            startsAt: at,
          })
        ),
      ],
      ...(["application_accepted", "application_waitlisted", "application_declined"] as const).map(
        (kind): [string, string, string] => [
          kind,
          JSON.stringify(
            announce.applicationDecidedMessage(
              kind,
              { member: "Beko Lolek", eventTitle: "Friday REPO night", slug: "f", waitlistPosition: 3 },
              stored[kind]
            )
          ),
          JSON.stringify(
            announce.applicationDecidedMessage(kind, {
              member: "Beko Lolek",
              eventTitle: "Friday REPO night",
              slug: "f",
              waitlistPosition: 3,
            })
          ),
        ]
      ),
      [
        "draft_lot_sold",
        JSON.stringify(
          announce.lotSoldMessage(
            { player: "Beko Lolek", team: "Rivals Red", price: 1200, eventTitle: "F", slug: "f" },
            stored.draft_lot_sold
          )
        ),
        JSON.stringify(
          announce.lotSoldMessage({
            player: "Beko Lolek",
            team: "Rivals Red",
            price: 1200,
            eventTitle: "F",
            slug: "f",
          })
        ),
      ],
      [
        "match_result",
        JSON.stringify(
          announce.matchResultMessage(
            {
              label: "Final",
              teamA: "Rivals Red",
              teamB: "Rivals Blue",
              gamesWonA: 2,
              gamesWonB: 1,
              winner: "Rivals Red",
              eventTitle: "F",
              slug: "f",
            },
            stored.match_result
          )
        ),
        JSON.stringify(
          announce.matchResultMessage({
            label: "Final",
            teamA: "Rivals Red",
            teamB: "Rivals Blue",
            gamesWonA: 2,
            gamesWonB: 1,
            winner: "Rivals Red",
            eventTitle: "F",
            slug: "f",
          })
        ),
      ],
      [
        "standings_changed",
        JSON.stringify(
          announce.standingsMessage(
            { seasonName: "Spring 2026", slug: "s", eventTitle: "F", top },
            stored.standings_changed
          )
        ),
        JSON.stringify(
          announce.standingsMessage({ seasonName: "Spring 2026", slug: "s", eventTitle: "F", top })
        ),
      ],
    ];

    for (const [kind, afterMigration, beforeTable] of pairs) {
      expect(afterMigration, `${kind} changed what it posts`).toBe(beforeTable);
      // And the two things that would make it a ping: no mention line at all,
      // and nothing Discord is allowed to honour.
      expect(JSON.parse(afterMigration).content, kind).toBeUndefined();
      expect(JSON.parse(afterMigration).allowed_mentions, kind).toEqual({ parse: [] });
    }

    /*
     * The column that carries the other half of "unedited": `body` is
     * nullable, so a row created only to choose a mention does not freeze one
     * variant of the compiled copy. Asserted against the database rather than
     * the schema file, because a `NOT NULL` added later would silently make
     * that state unreachable.
     */
    const bodyColumn = await client.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default from information_schema.columns
       where table_name = 'announcement_templates' and column_name = 'body'`
    );
    expect(bodyColumn.rows[0].is_nullable).toBe("YES");
    expect(bodyColumn.rows[0].column_default).toBeNull();

    // And the mention defaults are the inert ones: nobody is pinged by a row
    // somebody creates and leaves alone.
    await client.exec(`insert into announcement_templates (kind) values ('event_published')`);
    const [fresh] = (
      await client.query<{ mention_everyone: boolean; mention_role_ids: string[]; version: number }>(
        `select mention_everyone, mention_role_ids, version from announcement_templates`
      )
    ).rows;
    expect(fresh.mention_everyone).toBe(false);
    expect(fresh.mention_role_ids).toEqual([]);
    expect(fresh.version).toBe(1);

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("a claim with no recipient, and no backfill (drizzle/0030)", () => {
  /**
   * The two claims 0030 makes, asked of a real database rather than left as
   * prose: that the table **cannot hold a row that needs a user**, and that it
   * does nothing to an existing deployment.
   *
   * The first is the whole reason the migration exists. `notification_dm_claims`
   * is keyed on a NOT NULL `user_id`, so a channel announcement — which has no
   * recipient at all — has no row shape there. Asserted as the **whole column
   * list** rather than as a `not.toContain("user_id")`, for the same reason the
   * `events` date test above is: a column added later under another name would
   * satisfy the narrow version, and the claim worth pinning is "there is
   * nowhere in this table for a person".
   */
  it("is keyed on the kind and the event, with no column for a person", async () => {
    const client = new PGlite();
    await replayUpTo(client, "0030");

    const hasTable = async () =>
      (
        await client.query(
          `select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'announcement_claims'`
        )
      ).rows.length > 0;

    // Not there yet, which is what makes this a deployment rather than a fresh
    // database.
    expect(await hasTable()).toBe(false);

    /*
     * **Events, inserted before the migration runs.**
     *
     * This is the difference between asserting the no-backfill claim and only
     * appearing to: a migration that did `INSERT … SELECT id FROM events` would
     * insert nothing on an empty database, so "the table is empty afterwards"
     * passes on a fresh replay whatever the file says. A mutation that added
     * exactly that backfill survived this test until these three rows existed.
     *
     * Three events spanning the cases a backfill would have had to guess
     * between: one whose signups close in the future, one whose window has
     * closed, and one with no window at all.
     */
    const [soon] = (
      await client.query<{ id: string }>(
        `insert into events (slug, title, status, signup_closes_at)
         values ('closing-soon', 'Closing soon', 'published', now() + interval '20 hours')
         returning id`
      )
    ).rows;
    await client.exec(
      `insert into events (slug, title, status, signup_closes_at)
       values ('long-gone', 'Long gone', 'complete', now() - interval '40 days')`
    );
    await client.exec(
      `insert into events (slug, title, status) values ('no-window', 'No window', 'draft')`
    );

    await runFile(client, "0030_announcement_claims");
    expect(await hasTable()).toBe(true);

    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'announcement_claims' order by column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "claimed_at",
      "event_id",
      "kind",
    ]);
    // Both halves of the key are NOT NULL, which is what makes the primary key
    // able to deduplicate at all — a nullable member would make every row
    // distinct from every other, since NULL is not equal to NULL.
    expect(columns.rows.filter((row) => row.is_nullable === "NO").map((row) => row.column_name))
      .toEqual(["claimed_at", "event_id", "kind"]);

    const key = await client.query<{ column_name: string }>(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
        where tc.table_name = 'announcement_claims'
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position`
    );
    expect(key.rows.map((row) => row.column_name)).toEqual(["kind", "event_id"]);

    /*
     * **Empty, with three events sitting there.** The no-backfill claim: the
     * migration writes no rows, so the first row on any deployment is written
     * by the first announcement that actually goes out. An inserted claim would
     * be an announcement suppressed before anybody decided to send it — and
     * because the events above exist, a backfill over them fails here instead
     * of being invisible.
     */
    const total = await client.query<{ total: string }>(
      `select count(*)::text as total from announcement_claims`
    );
    expect(total.rows[0].total).toBe("0");
    // Named, so the failure says which deployment state was wrong rather than
    // just "not zero".
    expect(
      (
        await client.query<{ slug: string }>(
          `select e.slug from announcement_claims c join events e on e.id = c.event_id`
        )
      ).rows
    ).toEqual([]);

    /*
     * And the dedupe actually dedupes, asked of the database rather than of the
     * ORM: the same kind for the same event twice is one row, and the same kind
     * for a *different* event is a second. Both halves, because a key that
     * collapsed every event onto one row would satisfy the first on its own.
     */
    const event = soon;
    const [other] = (
      await client.query<{ id: string }>(
        `insert into events (slug, title, status) values ('claimed-2', 'Claimed 2', 'published')
         returning id`
      )
    ).rows;

    await client.exec(
      `insert into announcement_claims (kind, event_id)
       values ('event_starting_soon', '${event.id}')`
    );
    await client.exec(
      `insert into announcement_claims (kind, event_id)
       values ('event_starting_soon', '${event.id}') on conflict do nothing`
    );
    await client.exec(
      `insert into announcement_claims (kind, event_id)
       values ('signups_closing_soon', '${event.id}')`
    );
    await client.exec(
      `insert into announcement_claims (kind, event_id)
       values ('event_starting_soon', '${other.id}')`
    );

    const rows = await client.query<{ kind: string; event_id: string }>(
      `select kind, event_id from announcement_claims order by kind, event_id`
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.filter((row) => row.kind === "event_starting_soon")).toHaveLength(2);

    // A claim naming a kind that no longer exists is accepted and simply never
    // read, which is what lets a kind ship without an `ALTER TYPE`.
    await client.exec(
      `insert into announcement_claims (kind, event_id)
       values ('retired_kind', '${event.id}')`
    );

    // And the one thing it must refuse: a claim for an event that is not there.
    await expect(
      client.exec(
        `insert into announcement_claims (kind, event_id)
         values ('event_starting_soon', '00000000-0000-0000-0000-000000000000')`
      )
    ).rejects.toThrow();

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("one template per name (drizzle/0028)", () => {
  /**
   * The constraint, and what it does to the rows it finds.
   *
   * `CREATE UNIQUE INDEX` does not skip the rows that offend it — it fails, and
   * takes the deploy and every later migration with it. `DATABASE_URL` is blank
   * in this working copy by design, so nobody can look at production first and
   * find out whether two templates already fold onto one name. That is what
   * makes the fixtures the point of the test rather than a formality.
   *
   * Replayed by hand against the schema as it stood at 0027, for the same
   * reason the backfills above are: a fresh database has no templates, so
   * applying 0028 to one proves only that the SQL parses.
   */
  it("keeps the earliest name, suffixes the rest around a name already taken, and then holds the rule", async () => {
    const client = new PGlite();
    await replayUpTo(client, "0028");

    /*
     * Four rows in one conflict group's neighbourhood, chosen so the suffix
     * loop has to actually search rather than land on " 2" first time:
     *
     *  - `Rivals cup` (earliest) — differs from the next two by case and by a
     *    collapsed run, which is exactly the pair the plan said had to be
     *    resolved and exactly what `lower(name)` alone would have missed.
     *  - `RIVALS CUP` and `Rivals  cup` fold onto it.
     *  - `Rivals cup 2` is a *separate, legitimate* template that already holds
     *    the first suffix — a realistic shape, because `duplicateTemplate`
     *    produces precisely those names. It must come out untouched.
     *  - `Jackbox night` conflicts with nothing and must not move.
     */
    await client.exec(`insert into event_templates (name, created_at) values
      ('Rivals cup',    '2026-01-05T10:00:00Z'),
      ('RIVALS CUP',    '2026-02-05T10:00:00Z'),
      ('Rivals  cup',   '2026-03-05T10:00:00Z'),
      ('Rivals cup 2',  '2026-01-06T10:00:00Z'),
      ('Jackbox night', '2026-01-07T10:00:00Z')`);

    const names = async () =>
      (
        await client.query<{ name: string }>(
          `select name from event_templates order by created_at, id`
        )
      ).rows.map((row) => row.name);

    // Before: the shape that fails the CREATE.
    expect(await names()).toEqual([
      "Rivals cup",
      "Rivals cup 2",
      "Jackbox night",
      "RIVALS CUP",
      "Rivals  cup",
    ]);

    await runFile(client, "0028_template_name_unique");

    /*
     * After: the **earliest** row keeps the name, and the two that folded onto
     * it are renamed rather than deleted or deactivated. The same direction as
     * drizzle/0025 and the opposite of drizzle/0018, for 0025's reason — a
     * template name is a label in use (the create-event picker, the audit log,
     * what an admin types) rather than an intention a newer row supersedes.
     *
     * The suffixes are the search working: " 2" was taken by a legitimate
     * template, so the February row took " 3"; the March row then found both
     * " 2" and " 3" taken and took " 4". Nothing was overwritten to get there.
     */
    expect(await names()).toEqual([
      "Rivals cup",
      "Rivals cup 2",
      "Jackbox night",
      "RIVALS CUP 3",
      "Rivals cup 4",
    ]);

    /*
     * And the admins are told, which is the channel this site has for what
     * happened to admin-only data (R-110 / UC-27 3). No notification: a
     * template has no owner to notify, nothing was taken away but a label, and
     * a `notification_kind` is a permanent per-member switch (R-104) that a
     * one-off migration has no business minting. The file says so too.
     */
    const logged = await client.query<{
      action: string;
      subject: string;
      summary: string;
      detail: { wasCalled: string; nowCalled: string; keptName: string; keptId: string };
    }>(`select action, subject, summary, detail from audit_log
        order by detail->>'wasCalled'`);
    expect(logged.rows.map((row) => row.action)).toEqual([
      "template.name_superseded",
      "template.name_superseded",
    ]);
    expect(
      logged.rows.map((row) => [row.detail.wasCalled, row.detail.nowCalled])
    ).toEqual([
      ["RIVALS CUP", "RIVALS CUP 3"],
      ["Rivals  cup", "Rivals cup 4"],
    ]);
    // Every line names the row that kept the name, so the log explains itself.
    for (const row of logged.rows) {
      expect(row.detail.keptName).toBe("Rivals cup");
      expect(row.summary).toMatch(/one template per name \(R-125\)/);
    }
    // The audit line is filed against the template it renamed, which is what
    // `subject` is for — an id, not a name that has since changed.
    const ids = new Map(
      (
        await client.query<{ name: string; id: string }>(`select name, id from event_templates`)
      ).rows.map((row) => [row.name, row.id])
    );
    expect(logged.rows.map((row) => row.subject).sort()).toEqual(
      [ids.get("RIVALS CUP 3"), ids.get("Rivals cup 4")].sort()
    );

    /*
     * Applied twice by hand — the only way this file can be applied twice,
     * since a deploy runs every pending migration inside one transaction and
     * rolls the whole thing back. The rename removed the conflict, so the
     * second pass finds no group with more than one row: nothing is renamed
     * again and no second audit line is written. There is no gap of the kind
     * drizzle/0025 documents, because the audit insert and the rename are one
     * statement rather than two.
     */
    await runFile(client, "0028_template_name_unique");
    expect(await names()).toEqual([
      "Rivals cup",
      "Rivals cup 2",
      "Jackbox night",
      "RIVALS CUP 3",
      "Rivals cup 4",
    ]);
    expect(await auditCount(client)).toBe("2");

    /*
     * And from here the rule is the database's, not a read's — asked with no
     * application code in the way, on every shape the fold is supposed to
     * reach. This is the assertion that the index exists *and* that it folds
     * the way `cleanTemplateName` does: a plain `lower(name)` index would let
     * the last three through.
     */
    for (const name of ["Rivals cup", "RIVALS CUP", "rivals cup", "Rivals  cup", "Rivals\tcup"]) {
      await expectRejection(
        () => client.query(`insert into event_templates (name) values ($1)`, [name]),
        /event_templates_name_uniq/
      );
    }
    // A name that is genuinely different is still free.
    await client.exec(`insert into event_templates (name) values ('Rivals plate')`);

    /*
     * Asked of the real function last, as the 0025 test asks `canManageEvent`:
     * a constraint that broke `createTemplate` for everybody would satisfy
     * every assertion above.
     */
    const db = createPgliteDatabase(client);
    const made = await createTemplate({ name: "Rivals saucer" }, db);
    expect(made.ok).toBe(true);
    const clash = await createTemplate({ name: "rivals   PLATE" }, db);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toMatch(/already called/i);

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});

describe("the hero catalogue, and no roster in the migration (drizzle/0031)", () => {
  /**
   * The claim 0031's comment makes about a deployment that already has games,
   * asked of real rows rather than left as prose: **the table starts empty**,
   * and the 54 heroes are the seed's to plant and an admin's to correct.
   *
   * A fresh database proves nothing here, for the reason drizzle/0030's test
   * spells out at length: a migration that did `INSERT … SELECT id FROM games
   * WHERE key = 'rivals'` would insert nothing into an empty database, so "the
   * table is empty afterwards" passes on a bare replay whatever the file says.
   * So the games go in **before** the migration runs, which is also what makes
   * this a deployment rather than an install.
   */
  it("adds an empty table to a database that already has its games", async () => {
    const client = new PGlite();
    await replayUpTo(client, "0031");

    const hasTable = async () =>
      (
        await client.query(
          `select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'heroes'`
        )
      ).rows.length > 0;

    expect(await hasTable()).toBe(false);

    // The two games the seed makes, as a deployment would already hold them —
    // one of them the very row the roster hangs off.
    await client.exec(
      `insert into games (key, name, rank_ladder) values
         ('rivals', 'Marvel Rivals', '["Bronze III","One Above All"]'::jsonb),
         ('jackbox', 'Jackbox', '[]'::jsonb)`
    );

    await runFile(client, "0031_heroes");
    expect(await hasTable()).toBe(true);

    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'heroes' order by column_name`
    );
    // The whole column list, not a `toContain`: the claim worth pinning is that
    // there is no second place a hero's role could live — a single `role`
    // column added beside `roles` is exactly the drift this table exists to
    // prevent, and it would satisfy any narrower assertion.
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "created_at",
      "game_id",
      "id",
      "name",
      "retired_at",
      "roles",
    ]);
    expect(
      columns.rows.filter((row) => row.is_nullable === "YES").map((row) => row.column_name)
    ).toEqual(["retired_at"]);

    /*
     * **Empty, with `rivals` sitting right there.** No backfill, no INSERT, and
     * therefore nothing for a redeploy to undo: the first hero on any deployment
     * is written by `npm run db:seed`, and from then on the row is the admin's.
     * `npm run build` runs `db:migrate` and not the seed, so a deploy on its own
     * never plants one.
     */
    const total = await client.query<{ total: string }>(
      `select count(*)::text as total from heroes`
    );
    expect(total.rows[0].total).toBe("0");

    /*
     * And the seed is what fills it, asked of the real function as the 0028 test
     * asks `createTemplate`: 54 rows on the game that was already there, no
     * second `rivals`, and nothing on `jackbox`.
     */
    const db = createPgliteDatabase(client);
    const summary = await seed(db, {});
    expect(summary.heroesInserted).toBe(54);
    expect(summary.gamesInserted).toBe(0);

    const planted = await client.query<{ key: string; total: string }>(
      `select g.key, count(h.id)::text as total
         from games g left join heroes h on h.game_id = g.id
        group by g.key order by g.key`
    );
    expect(planted.rows).toEqual([
      { key: "jackbox", total: "0" },
      { key: "rivals", total: "54" },
    ]);

    // Roles are the enum's, read back from the column type rather than assumed.
    const type = await client.query<{ udt_name: string; data_type: string }>(
      `select udt_name, data_type from information_schema.columns
       where table_name = 'heroes' and column_name = 'roles'`
    );
    expect(type.rows[0].data_type).toBe("ARRAY");
    expect(type.rows[0].udt_name).toBe("_hero_role");

    await client.close();
  }, PGLITE_BOOT_BUDGET_MS);
});
