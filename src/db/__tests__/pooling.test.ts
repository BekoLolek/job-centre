import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * What the unbounded connection pool rests on (Task 66 / the Scale constraint).
 *
 * `src/db/index.ts` builds Neon's `Pool` with no `max`, no `idleTimeout` and no
 * `connectionTimeout`, and `docs/decisions/005-connection-pooling.md` records
 * why: production's `DATABASE_URL` names the **pooled** endpoint, so PgBouncer
 * absorbs the fan-out of a live draft.
 *
 * PgBouncer in transaction mode hands a different backend connection to each
 * transaction, so anything scoped to a **session** rather than a transaction
 * breaks — and breaks at the worst possible moment, because the fan-out that
 * makes two transactions land on two backends is exactly a live draft. The
 * decision rests on this app using none of it, which is a fact about the source
 * and therefore checkable here rather than argued in prose.
 *
 * This is a sweep for an **absence**, which fails in a direction its own
 * documentation can cause: the docblock in `src/db/index.ts` names every
 * feature below, and `005` names them twice. So comments are stripped before
 * anything is matched, and `the sweep can see what it is looking for` holds the
 * matcher against samples — otherwise a typo in a pattern would read as "clean"
 * for ever. Task 65's lesson, pointed the other way round: a sweep for
 * something's absence is satisfied by a broken regex as surely as a sweep for
 * its presence is satisfied by its own test file.
 */

const SRC = path.resolve(__dirname, "../..");
const DB_INDEX = path.join(SRC, "db", "index.ts");
const DECISION = path.resolve(__dirname, "../../../docs/decisions/005-connection-pooling.md");

/**
 * Session-scoped Postgres, and what each one would do behind a transaction
 * pooler. Written as the reason rather than just the pattern, so a future
 * addition has to say why it belongs.
 */
const SESSION_SCOPED: Array<{ what: string; pattern: RegExp; because: string; sample: string }> = [
  {
    what: "a session advisory lock",
    pattern: /\bpg_advisory_(?:lock|unlock|xact)/i,
    because:
      "the unlock can land on a different backend from the lock, so the lock is never released",
    sample: "await db.execute(sql`select pg_advisory_lock(${key})`);",
  },
  {
    what: "LISTEN",
    pattern: /\blisten\s+[a-z_"]/i,
    because: "the subscription belongs to a backend this request will not hold again",
    sample: 'await db.execute(sql`listen draft_changes`);',
  },
  {
    what: "NOTIFY",
    pattern: /\bnotify\s+[a-z_"]/i,
    because: "nothing on the other side can still be listening on that backend",
    sample: 'await db.execute(sql`notify draft_changes`);',
  },
  {
    what: "a held cursor",
    pattern: /\bwith\s+hold\b/i,
    because: "the cursor outlives its transaction and the backend it was declared on",
    sample: "sql`declare lots cursor with hold for select * from draft_lots`",
  },
  {
    what: "a session setting",
    pattern: /\bset\s+session\b/i,
    because: "the setting applies to one backend and the next transaction gets another",
    sample: "sql`set session statement_timeout = '5s'`",
  },
  {
    what: "a prepared statement",
    pattern: /\.prepare\(/,
    because:
      "a named statement is prepared on one backend and executed on whichever the pooler gives next",
    sample: "const q = db.select().from(events).prepare();",
  },
];

/** Comments stripped: this file's own prose, and the docblock it is about, name all of these. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("the premise behind an unbounded pool", () => {
  const files = sourceFiles(SRC);

  it("found the tree it is sweeping", () => {
    // A floor, so a walk that returns nothing fails here rather than passing
    // every assertion below by vacuum.
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain(DB_INDEX);
  });

  it("can see what it is looking for", () => {
    // Each pattern against a line that should trip it: a pattern that matches
    // nothing would otherwise make this whole file read "clean" for ever.
    for (const feature of SESSION_SCOPED) {
      expect(feature.sample, `${feature.what}: pattern matches nothing`).toMatch(feature.pattern);
    }
  });

  it("uses nothing scoped to a session, so transaction pooling is safe", () => {
    for (const feature of SESSION_SCOPED) {
      const found = files.filter((file) => feature.pattern.test(code(file)));

      expect(found, `${feature.what} — ${feature.because}`).toEqual([]);
    }
  });

  /*
   * Locks are the half that has to be *present*: `select … for update` is held
   * by the transaction, which is why the lock-ordered writes of Tasks 36 and 56
   * survive a pooler at all. If these ever became advisory locks the test above
   * would fail — this one says the thing they are today.
   */
  it("takes its locks on rows inside the transaction", () => {
    // `.for("update")`, drizzle's builder for `select … for update` — the
    // phrase "for update" appears in this repo only in prose, which is why the
    // first version of this assertion found nothing at all once comments were
    // stripped. A row lock is held by the transaction; that is the whole point.
    const lockers = files.filter((file) => /\.for\("update"\)/.test(code(file)));

    expect(lockers.map((file) => path.basename(file)).sort()).toEqual([
      "admin-allowlist.ts",
      "championship-results.ts",
      "draft.ts",
      "events.ts",
      "format.ts",
    ]);
  });
});

describe("the pool itself", () => {
  const built = code(DB_INDEX);

  it("sets no max, no idle timeout and no connection timeout", () => {
    // Not an omission: a second ceiling in front of PgBouncer's is a number
    // nobody can recompute, and a connection timeout turns Neon's autosuspend
    // cold start into a failed request. Decision 005.
    expect(built).toContain("new Pool({ connectionString: url as string })");
    expect(built).not.toMatch(/\bmax:\s*\d/);
    expect(built).not.toMatch(/idleTimeout/i);
    expect(built).not.toMatch(/connectionTimeout/i);
  });

  it("says where the reasoning is, beside the line that raises the question", () => {
    // The whole file, comments included — the citation *is* a comment.
    const whole = readFileSync(DB_INDEX, "utf8");

    expect(whole).toContain("docs/decisions/005-connection-pooling.md");
    expect(whole).toContain("-pooler");
  });

  it("keeps the decision record where the citation points", () => {
    const decision = readFileSync(DECISION, "utf8");

    // The two conditions the decision rests on, stated in it rather than only
    // here: the endpoint, and why a pool of one is not the easy answer.
    expect(decision).toContain("-pooler");
    expect(decision).toMatch(/max: 1/);
    expect(decision).toMatch(/deadlocks rather than\s+queueing/);
  });
});
