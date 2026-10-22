import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";

/**
 * The guard for "schema.ts and drizzle/ still say the same thing".
 *
 * `src/db/schema.ts` is the *input* drizzle-kit generates from; the SQL in
 * `drizzle/` is what actually runs, against PGlite here and against Neon on a
 * deploy. Every other test in this repo reads the database the migrations
 * built, so a line deleted from `schema.ts` alone changes nothing any of them
 * can see — Task 49 proved it by removing the `uniqueIndex(...)` behind
 * `event_hosts_one_host_per_event` and watching the whole suite stay green,
 * while the next `npm run db:generate` would have emitted a `DROP INDEX` for a
 * constraint that is protecting production. The same hole covers every index,
 * constraint, default and column type in that file.
 *
 * What closes it is drizzle-kit's own diff: generating from the current schema
 * must produce nothing. There is no `--check`-style flag on `drizzle-kit
 * generate` (0.31.10 offers `generate`, `migrate`, `introspect`, `push`,
 * `studio`, `up`, `check`, `drop` and `export`; `check` only validates the
 * migration folder against itself, and `export` dumps the schema from empty
 * rather than diffing it), so the obvious route would be to shell out to a real
 * generate, write into a scratch directory and clean up afterwards. That is the
 * route this file does *not* take. `drizzle-kit/api` exports the two halves
 * `generate` is built from — `generateDrizzleJson` serialises the schema the
 * way a snapshot is serialised, `generateMigration` diffs two snapshots into
 * SQL — so the diff happens in memory. Nothing is written anywhere, there is
 * nothing to clean up on the failure path, no subprocess starts, and the whole
 * check costs about 40ms of test time.
 *
 * It needs no database and no network either, which matters because
 * `DATABASE_URL` is deliberately blank here and the suite runs offline. Note
 * that this is a property of the two API calls, not of `drizzle.config.ts`:
 * neither call reads the config, so the `dbCredentials` both branches of that
 * file set are never consulted. The config's own claim that `db:generate`
 * "never touches a database" is what makes the CLI route viable too — this file
 * simply does not need to find out.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDir = path.join(repoRoot, "drizzle");
const metaDir = path.join(migrationsDir, "meta");

type JournalEntry = { idx: number; tag: string };

function journal(): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(metaDir, "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

/**
 * The snapshot the next generate would diff against: the newest one, found
 * through the journal rather than by sorting filenames, because the journal is
 * what drizzle-kit itself treats as the order of the chain.
 */
function latestSnapshot(): { tag: string; json: Record<string, unknown> } {
  const entries = journal();
  const last = entries.at(-1);
  if (!last) throw new Error("drizzle/meta/_journal.json lists no migrations");
  const file = path.join(metaDir, `${String(last.idx).padStart(4, "0")}_snapshot.json`);
  return {
    tag: last.tag,
    json: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}

describe("schema.ts against drizzle/", () => {
  it("generating a migration from the current schema would produce nothing", async () => {
    const { tag, json } = latestSnapshot();

    // `generateDrizzleJson` wants the schema module's namespace object; the
    // cast is only because its parameter is typed `Record<string, unknown>`
    // and a namespace import is not assignable to that without one.
    const current = generateDrizzleJson(schema as unknown as Record<string, unknown>);

    /*
     * One shape of drift drizzle-kit cannot diff on its own: a *renamed* column,
     * which reaches it as a drop plus an add in one table and is ambiguous — it
     * cannot know whether the old column was renamed or genuinely dropped and a
     * new one added, so it calls its interactive rename resolver and that
     * resolver wants a TTY. `generateMigration(prev, cur)` takes no resolver
     * argument, so there is no non-interactive answer to give it.
     *
     * Drift is not missed when that happens — the call throws rather than
     * returning `[]` — but the bare throw reads as a broken harness: `Error:
     * Interactive prompts require a TTY terminal` over a stack through
     * drizzle-kit's `api.mjs`, which is the kind of failure that gets a test
     * skipped instead of investigated. So it is caught and reported as what it
     * is.
     *
     * `isTTY` is forced false across the call, and restored, so a developer's
     * terminal and CI reach the same branch. Left alone, an interactive
     * terminal would have drizzle-kit *prompt* — a suite that stops and waits
     * for a keystroke rather than failing — while CI threw.
     */
    const wasTTY = process.stdout.isTTY;
    let drift: string[];
    try {
      process.stdout.isTTY = false;
      drift = await generateMigration(
        json as Parameters<typeof generateMigration>[0],
        current as Parameters<typeof generateMigration>[1],
      );
    } catch (error) {
      // Only the prompt is reported as drift. Anything else out of
      // `generateMigration` is a different problem, and dressing it up as a
      // rename would be the same mistake this branch exists to fix.
      const message = error instanceof Error ? error.message : String(error);
      if (!/interactive|TTY|prompt/i.test(message)) throw error;
      throw new Error(
        [
          `src/db/schema.ts no longer matches the migrations in drizzle/, and the drift`,
          `includes a change drizzle-kit cannot resolve without being asked.`,
          ``,
          `Diffing the schema against ${tag} (the newest snapshot in drizzle/meta) needed`,
          `drizzle-kit's interactive rename resolver — which is what a column renamed`,
          `in schema.ts looks like from the outside, since it reaches the differ as a`,
          `drop plus an add in one table. There is no resolver to pass in from here, so`,
          `this test cannot print the SQL for it.`,
          ``,
          `Run \`npm run db:generate\` to see it: the CLI asks the question, and the`,
          `answer you give it is the migration. This is drift, not a broken test.`,
          ``,
          `drizzle-kit said: ${message}`,
        ].join("\n"),
        { cause: error },
      );
    } finally {
      process.stdout.isTTY = wasTTY;
    }

    expect(
      drift,
      [
        `src/db/schema.ts no longer matches the migrations in drizzle/.`,
        ``,
        `Diffing the schema against ${tag} (the newest snapshot in`,
        `drizzle/meta) produced ${drift.length} statement(s). This is exactly the SQL the`,
        `next \`npm run db:generate\` would write into a new migration file:`,
        ``,
        ...drift.map((statement) => `    ${statement.replace(/\n/g, "\n    ")}`),
        ``,
        `If that SQL is the change you meant to make, run \`npm run db:generate\` and`,
        `commit the migration it writes. If it drops or alters something you did not`,
        `mean to touch — a DROP INDEX, a dropped constraint, a changed column type —`,
        `then a line went missing from schema.ts and this is the only test in the repo`,
        `that can see it: every other one reads the database the migrations built, so`,
        `the schema file can disagree with them silently.`,
      ].join("\n"),
    ).toEqual([]);
  });

  /**
   * The chain itself, checked because a half-written generate is how this guard
   * could do damage. Task 49's probe shelled out to a real generate and left a
   * stray `0026` migration, its snapshot and a journal entry behind, all three
   * removed by hand afterwards. This file writes nothing, so it cannot repeat
   * that — but a leak from anywhere else corrupts the order migrations run in,
   * and nothing else here would notice.
   */
  it("every migration in drizzle/ has a journal entry and a snapshot", () => {
    const entries = journal();

    expect(
      entries.map((entry) => entry.idx),
      `drizzle/meta/_journal.json's indexes are not 0..n without a gap, so the order` +
        ` migrations run in is not the order they were written: got` +
        ` [${entries.map((entry) => entry.idx).join(", ")}]`,
    ).toEqual(entries.map((_, index) => index));

    const missing = entries.flatMap((entry) => {
      const sql = path.join(migrationsDir, `${entry.tag}.sql`);
      const snapshot = path.join(metaDir, `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
      return [sql, snapshot]
        .filter((file) => !existsSync(file))
        .map((file) => path.relative(repoRoot, file));
    });
    expect(missing, `the journal names files that are not on disk: ${missing.join(", ")}`).toEqual(
      [],
    );

    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const named = entries.map((entry) => entry.tag).sort();
    const stray = onDisk.filter((name) => !named.includes(name));
    expect(
      stray,
      `drizzle/ holds .sql files the journal does not list, so they will never run: ${stray.join(", ")}`,
    ).toEqual([]);

    /*
     * And the same question of `drizzle/meta`, because a leak has three pieces
     * and the two checks above only see two of them. Task 49's probe left a
     * stray `0026.sql`, a `0026_snapshot.json` and a journal entry; the journal
     * entry is caught by `missing` above (it names files not on disk) and the
     * `.sql` by `stray`, but a snapshot with neither of the other two passed
     * every assertion in this test. It is the piece that matters most for *this
     * file*: `latestSnapshot()` above finds the newest snapshot through the
     * journal, so a stray higher-numbered snapshot is inert today — and the
     * moment anyone reaches for the snapshots by filename instead, the drift
     * check starts diffing against a snapshot no migration ever produced.
     */
    const padded = new Set(entries.map((entry) => String(entry.idx).padStart(4, "0")));
    const strayMeta = readdirSync(metaDir)
      .filter((name) => name.endsWith("_snapshot.json"))
      .filter((name) => !padded.has(name.replace(/_snapshot\.json$/, "")))
      .sort();
    expect(
      strayMeta,
      `drizzle/meta holds snapshots the journal does not list, so they belong to no` +
        ` migration: ${strayMeta.join(", ")}`,
    ).toEqual([]);
  });
});
