import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../../tailwind.config";

/**
 * The names this repo has deleted, asserted absent from `src/**`.
 *
 * ## Why this reads off a list rather than off the deletions
 *
 * Task 31's acceptance criterion banned the bare eyebrow class outside
 * `components/ui` and nothing noticed that it was unmet, because the sweep
 * written to catch it — `callSites()` in `checkbox-hit-area.test.ts` — matched
 * only `<Checkbox` elements. It counted the *converted* call sites and was
 * blind to an unconverted one. A sweep keyed to the fixed form cannot report
 * the unfixed form.
 *
 * The class name is deliberately not written out as a class list anywhere in
 * this file: a convenience grep for the unconverted sites would otherwise count
 * this prose as a 40th, which is the same miscount in a different costume.
 *
 * So the names below are written down, once, as data. Each is a name some task
 * decided was dead and removed; the assertion is that `src/**` does not
 * mention it any more. Adding a tenth dead name is one line in {@link DEAD},
 * not a new test — and the thing being asserted stays the *name*, which is the
 * form that survives the fix.
 *
 * ## Why comments are stripped and strings are not
 *
 * A deletion is allowed to leave a note behind. `schema.ts` explains why it has
 * no `relations()` declarations and `globals.css` records what `.roundel` was;
 * prose like that is how the next reader learns the decision, and a sweep that
 * forbade it would push the explanations out of the code. So comments are
 * removed before matching.
 *
 * String literals are **not** removed. A deleted export reached through a
 * string — a mock path, a dynamic import, a `vi.mock` factory key — is still a
 * live reference, and those are exactly the references an identifier-only grep
 * misses. If one of these names turns up in a string, this file fails.
 *
 * ## Why a vacuous pass cannot happen
 *
 * Absence is also what a broken scanner reports, and `page-width.test.ts`'s
 * thirteenth escaped mutation was an assertion satisfied by a comment. Both
 * halves are pinned here. {@link CANARIES} are names that *are* in the tree and
 * are required to be found by the same matcher on the same corpus, so a matcher
 * that can no longer see code fails loudly rather than passing clean. The file
 * count is pinned too, so an empty walk cannot read as a tidy repo.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const GLOBALS = path.join(SRC, "app/globals.css");

/**
 * This file, which quotes every name below and would otherwise match itself.
 *
 * Exactly one exemption, asserted to exist and asserted to be the only one, so
 * the hole cannot be widened by adding a path to a list nobody re-reads.
 */
const SELF = path.join(SRC, "app/__tests__/dead-names.test.ts");

type Dead = {
  /** The identifier, exactly as it was spelled when it existed. */
  name: string;
  /** Where it lived, so a failure points at what is being re-introduced. */
  from: string;
  /** Why it was dead — the search that established it, in one line. */
  why: string;
};

/**
 * The twenty-three `relations()` objects `src/db/schema.ts` used to declare.
 *
 * Drizzle's `relations()` helper only feeds the relational query builder's
 * `with:` clause, and nothing in the repo writes a `with:` — the single
 * `db.query.*` call in the suite passes `where` and `orderBy` only. They emitted
 * no DDL either: drizzle-kit's snapshots have no key for relations, so deleting
 * them changed no generated SQL.
 */
const RELATIONS = [
  "usersRelations",
  "userNotesRelations",
  "eventTemplatesRelations",
  "accountsRelations",
  "sessionsRelations",
  "gamesRelations",
  "profileFieldsRelations",
  "profileValuesRelations",
  "eventsRelations",
  "eventDaysRelations",
  "eventQuestionsRelations",
  "applicationsRelations",
  "availabilityRelations",
  "confirmationsRelations",
  "teamsRelations",
  "teamMembersRelations",
  "draftPoolEntriesRelations",
  "draftLotsRelations",
  "draftBidsRelations",
  "draftConfigsRelations",
  "stagesRelations",
  "matchesRelations",
  "matchGamesRelations",
] as const;

/** Every deleted identifier. One line each; add to the end. */
const DEAD: readonly Dead[] = [
  {
    name: "activeGameCount",
    from: "src/lib/admin-games.ts",
    why: "Its only occurrence in the repo was its own declaration — no caller in src, no string, no test.",
  },
  {
    name: "EMPTY_ANSWER",
    from: "src/lib/availability-resolve.ts",
    why: "Exported and re-exported through `availability.ts`'s `export *`, and read by nothing on either path.",
  },
  {
    name: "blankGames",
    from: "src/lib/format-resolve.ts",
    why: "Distinct from the live `blankGamesFor`; a word-boundary search found only its own declaration.",
  },
  {
    name: "InlineSaveRow",
    from: "src/components/admin/events/SaveRow.tsx",
    why: "Its own docblock said nothing used it yet, and nothing did.",
  },
  ...RELATIONS.map(
    (name): Dead => ({
      name,
      from: "src/db/schema.ts",
      why: "A `relations()` object for a `with:` clause the repo never writes; emitted no SQL.",
    })
  ),
];

/**
 * Names that are in the tree, matched the same way on the same corpus.
 *
 * Without these, every assertion below is also satisfied by a scanner that
 * reads nothing. Each is deliberately adjacent to something deleted — the live
 * sibling of a dead name — so a matcher that confused the two is caught as
 * well as one that matched nothing at all.
 */
const CANARIES = [
  // The live function `blankGames` was named after, and the reason `\b` matters.
  "blankGamesFor",
  // SaveRow's surviving default export, beside the deleted `InlineSaveRow`.
  "SaveRow",
  // Lives in schema.ts, ends in `Relations`, and must not read as one of them.
  "ExtractTablesWithRelations",
] as const;

/* --------------------------------------------------------------------- */
/* The corpus                                                            */
/* --------------------------------------------------------------------- */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Block and line comments removed, string literals left in place.
 *
 * Deliberately not a parser: it walks the text once in a tiny state machine so
 * that a `//` inside a string or a quote inside a comment cannot throw it off,
 * which a regex pass over either one does.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "single" | "double" | "tick";
  let state: State = "code";

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch = source[i];

    if (state === "code") {
      if (two === "//") {
        state = "line";
        i += 2;
        continue;
      }
      if (two === "/*") {
        state = "block";
        i += 2;
        continue;
      }
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "tick";
      out += ch;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (two === "*/") {
        state = "code";
        i += 2;
      } else {
        // Newlines are kept so reported line numbers stay honest.
        if (ch === "\n") out += ch;
        i += 1;
      }
      continue;
    }

    // Inside a string: copy through, honouring backslash escapes.
    if (ch === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (state === "single" && ch === "'") ||
      (state === "double" && ch === '"') ||
      (state === "tick" && ch === "`")
    ) {
      state = "code";
    }
    out += ch;
    i += 1;
  }

  return out;
}

const FILES = walk(SRC).filter((file) => file !== SELF);
const CODE = FILES.map((file) => ({
  rel: file.slice(ROOT.length + 1).split(path.sep).join("/"),
  lines: stripComments(fs.readFileSync(file, "utf8")).split("\n"),
}));

/** Every `file:line` in the corpus where `name` appears as a whole word. */
function sightings(name: string): string[] {
  const pattern = new RegExp(`\\b${name}\\b`);
  const found: string[] = [];
  for (const file of CODE) {
    file.lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${file.rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

/* --------------------------------------------------------------------- */

describe("deleted names stay deleted", () => {
  it("has a corpus to search, and only exempts itself", () => {
    expect(fs.existsSync(SELF), "the self-exemption points at no file").toBe(true);
    expect(FILES.length, "the walk found almost nothing — the scan is broken").toBeGreaterThan(300);
    expect(
      FILES.filter((file) => file.endsWith(".tsx")).length,
      "no .tsx files were scanned, so every component is unsearched"
    ).toBeGreaterThan(80);
    expect(DEAD.length, "the list of deleted names is empty").toBeGreaterThanOrEqual(27);
  });

  it("can still find a name that is there", () => {
    /*
     * The positive control. Every assertion below reports absence, and so does
     * a scanner that has stopped reading — this is the half that cannot be
     * satisfied by a broken one.
     */
    for (const canary of CANARIES) {
      expect(sightings(canary), `the matcher can no longer find ${canary}`).not.toEqual([]);
    }
  });

  it.each(DEAD)("$name is gone from src ($from)", ({ name, why }) => {
    expect(sightings(name), `${name} is back in src. It was deleted because: ${why}`).toEqual([]);
  });

  it("declares no relations() object under any name", () => {
    /*
     * The list above names the twenty-four that existed. This catches a
     * twenty-fifth that nobody thought to add to it — the same reason
     * `field-ordering.test.ts` computes its utility properties rather than
     * listing them.
     */
    const declarations = CODE.flatMap((file) =>
      file.lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\bexport const [A-Za-z0-9_]+Relations\b/.test(line))
        .map(({ line, i }) => `${file.rel}:${i + 1}  ${line.trim()}`)
    );
    expect(declarations, "a relations() object is declared again").toEqual([]);
  });
});

/* --------------------------------------------------------------------- */
/* .roundel, which is CSS and needs a different question asked           */
/* --------------------------------------------------------------------- */

async function compiledCss(): Promise<string> {
  const content = [path.join(ROOT, "src/**/*.{ts,tsx}").split(path.sep).join("/")];
  const result = await postcss([tailwindcss({ ...tailwindConfig, content })]).process(
    fs.readFileSync(GLOBALS, "utf8"),
    { from: GLOBALS }
  );
  return result.css;
}

describe(".roundel", () => {
  it("has no rule left in globals.css", () => {
    const source = fs.readFileSync(GLOBALS, "utf8");
    const rules = source
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s*\.roundel\b/.test(line))
      .map(({ line, i }) => `globals.css:${i + 1}  ${line.trim()}`);
    expect(rules, ".roundel is declared again").toEqual([]);
  });

  it("is worn by nothing", () => {
    const worn = CODE.flatMap((file) =>
      file.lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /className=[^>]*\broundel\b/.test(line))
        .map(({ line, i }) => `${file.rel}:${i + 1}  ${line.trim()}`)
    );
    expect(worn, "something wears .roundel").toEqual([]);
  });

  it("is not in the compiled stylesheet, which is the half prose could undo", async () => {
    /*
     * Task 38c's near-miss, one layer deeper. Tailwind's content globs cover
     * `src/**\/*.ts`, so a class named in a test file's own text is a purge
     * candidate: the probe that was supposed to show layering `.roundel` would
     * purge it failed *because this suite mentioned the word*. The guard was
     * worth nothing while it was also the reason the rule survived.
     *
     * This file names `roundel` several times, in prose and in the regexes
     * above. The question that settles it is not whether the word appears in
     * `src/**` — it does, here — but whether the compiled stylesheet has a rule
     * for it. A deleted hand-written rule cannot come back from a mention,
     * because `.roundel` is not a utility Tailwind can generate; only a rule in
     * `globals.css` could emit it. This asserts the emitted CSS, so it holds
     * whatever any comment says.
     */
    const css = await compiledCss();
    const selectors = postcss
      .parse(css)
      .nodes.filter((node): node is postcss.Rule => node.type === "rule")
      .map((rule) => rule.selector)
      .filter((selector) => selector.includes("roundel"));
    expect(selectors, ".roundel is emitted by the build").toEqual([]);
  });
});
