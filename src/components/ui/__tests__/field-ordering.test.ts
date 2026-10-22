import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";

/**
 * A utility written on a field has to win, and `.field` has to keep supplying
 * everything nobody wrote a utility for. This is the file that says so.
 *
 * Task 38c. `.field` declares `width: 100%`, `font-size: 14px` and
 * `padding: 0.5rem 0.7rem`, and it was written *after* `@tailwind utilities` at
 * the same 0-1-0 specificity — so the tie broke on source order and `.field`
 * won every one of them. Twenty-six call sites had written a `w-*`, `p*-` or
 * `text-*` on a field and had it silently discarded. The fix moved the block
 * into `@layer components`, which Tailwind emits *before* the utilities, so the
 * tie breaks the ordinary way round.
 *
 * **What this file measures, and what it does not.** The numbers in the task —
 * a `Select` carrying `w-[11rem]` rendering 1010px, `TimeSelect` losing all
 * three at 1010px/14px/8px — were measured in a browser. There is no browser
 * here: the suite runs in vitest's `node` environment with no jsdom and no
 * testing-library, so nothing in this file can measure a layout and nothing in
 * it pretends to. What it measures instead is the thing those pixels were a
 * symptom of: the **resolved cascade**. It compiles `globals.css` with the real
 * Tailwind config and the real `src/**` content, reads the emitted rules in
 * emitted order, and resolves each call site's class list the way a browser
 * would — equal specificity, last rule wins. The pixel figures are the
 * browser's; the winner of the cascade is this file's, and it is the mechanism
 * that produced them.
 *
 * It does both halves from one compiler. `BEFORE` is this same stylesheet with
 * the `@layer components` wrappers stripped back off, which is byte-for-byte the
 * cascade that shipped; `AFTER` is the file as it stands. Every claim below is
 * a comparison between the two.
 *
 * ---------------------------------------------------------------------------
 *
 * **Task 65 extended this file rather than starting a second mechanism**, and
 * widened it from `.field` to the whole stylesheet. `.field` was one instance of
 * the pattern; measuring the rest found that of the **22** top-level class rules
 * `globals.css` had, **20 declared a property a really-emitted utility also
 * writes** — 17 distinct classes, where the plan had estimated nine. Only
 * `.hatch` and `.btn:focus-visible` were clean. `.num` alone is contradicted at
 * 47 call sites and `.btn` at 6 — including `Button`'s own `size="sm"`, whose
 * `px-3 py-1.5` lost to `.btn`'s `padding`, so the size prop had never done
 * anything on any button on the site.
 *
 * The same honesty applies and is worth restating, because the `.num` numbers
 * are easy to misread as layout: **nothing in this file measures a pixel.**
 * These figures were measured in a real browser on a static page served from
 * localhost, carrying the two stylesheets compiled by the Tailwind CLI from the
 * real config and the real `src/**` globs, with each case's ancestor chain
 * reproduced from its call site:
 *
 *   Button size="sm" padding   8px / 13.6px  ->  6px / 12px
 *   Button size="md" padding   8px / 13.6px  ->  8px / 13.6px   (unchanged)
 *   Stepper arrow              13px, 1px     ->  16px, 0px
 *   DevLoginBanner             13.6px pad, rgb(201,204,211), --hair border
 *                                            ->  12px pad, rgb(255,45,79), flare/50
 *   /admin/audit chip          13px, 8/13.6  ->  12px, 4/8
 *   /events/[slug] tab border  1px           ->  0px
 *   DraftRoom wordmark         13px          ->  16px
 *   AppHeader wordmark         13px          ->  13px           (unchanged)
 *   ResultsTab scoreline       14.1px        ->  20px
 *   BidBox locked bid          14.1px        ->  48px
 *   PlayerChip seed            14.1px        ->  11px   (in a 24px box)
 *   .num with no size written  13.16px       ->  13.16px         (unchanged)
 *
 * And the measurement that explains why `.num` is not `.btn`. One class list,
 * `num text-12`, under three parents:
 *
 *               before              after
 *   12px parent  11.28px             12px
 *   14px parent  13.16px             12px
 *   20px parent  18.8px              12px
 *
 * `0.94em` resolves against the *parent*, so the author's `text-12` was not
 * overridden by a competing size — it was replaced by a number derived from
 * whatever happened to be above the element. That is why layering `.num` is
 * right even though the correction is deliberate: it only stops applying where
 * a call site stated a size, and a stated size was never what rendered.
 *
 * What this file pins is, again, the resolved cascade that produced those
 * pixels — plus two things a cascade alone would not catch: that no unlayered
 * rule is left able to eat a utility (`MUST_KEEP_WINNING` is the only exit, and
 * it needs a reason), and that no class list writes two font-size utilities at
 * once, where the winner would be Tailwind's emitted order rather than the
 * author.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const GLOBALS = path.join(ROOT, "src/app/globals.css");
const UI_DIR = path.join(ROOT, "src/components/ui");

/** The class every control on the `.field` surface wears. */
const FIELD = "field";

/** The three kit components. They are the class, not call sites of it. */
const KIT = ["Field.tsx", "Select.tsx", "Textarea.tsx"];

/** How the sweep labels a control that wears `.field` by hand. */
const RAW = 'className="field …"';

/**
 * String literals in `src/**` that contain the word `field` and are not class
 * lists, so the sweep is allowed not to find a control in them.
 *
 * This list exists because the first version of this file matched *every*
 * double-quoted literal containing a `field` token, and picked up the sentence
 * below as a call site with a twelve-class class list. It resolved to the
 * `.field` defaults — none of those words is a class — so it passed, quietly,
 * as a thirteenth control that does not exist. Narrowing the match to
 * `className="…"` fixes that and opens the opposite hole: a control written as
 * `cx("field", …)` outside the kit would now be invisible. "has no control
 * wearing .field in a form the sweep cannot see" closes it against this list.
 */
const NOT_A_CLASS_LIST = [
  "No profile field with this key on this game — the question will simply not prefill.",
];

/**
 * The properties `.field` hard-codes, and therefore the only ones a utility on
 * a field can lose. `padding` is tracked as its four longhands because `.field`
 * writes the shorthand and `py-1.5` writes two sides of it: resolving those
 * against each other is the whole question for half the call sites.
 */
const TRACKED = [
  "width",
  "font-size",
  "line-height",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

type Resolved = Partial<Record<(typeof TRACKED)[number], string>>;

/**
 * What a field looks like when nobody writes a utility on it — Task 38c's
 * second acceptance criterion, as values rather than as a promise.
 *
 * Written out here rather than read back out of `.field`, deliberately. Read
 * from the stylesheet these would agree with whatever the stylesheet said,
 * including with a `width: 100%` somebody had deleted, and the criterion is
 * that the default is *unchanged* — which is a claim about these numbers.
 */
const FIELD_DEFAULTS: Required<Resolved> = {
  width: "100%",
  "font-size": "14px",
  "line-height": "1.4",
  "padding-top": "0.5rem",
  "padding-right": "0.7rem",
  "padding-bottom": "0.5rem",
  "padding-left": "0.7rem",
};

/* --------------------------------------------------------------------- */
/* Compiling the real stylesheet                                         */
/* --------------------------------------------------------------------- */

async function compile(css: string): Promise<string> {
  const content = [path.join(ROOT, "src/**/*.{ts,tsx}").split(path.sep).join("/")];
  // Tailwind's PostCSS plugin resolves its content globs asynchronously, so the
  // result has to be awaited rather than read off `.css`.
  const result = await postcss([tailwindcss({ ...tailwindConfig, content })]).process(css, {
    from: GLOBALS,
  });
  return result.css;
}

/**
 * The stylesheet as it shipped before the fixes: the same declarations, in the
 * same place, without the `@layer components` wrappers around them.
 *
 * Unwrapping in place *is* the old cascade. Everything in `globals.css` below
 * line 3 is already after `@tailwind utilities`, so a plain rule there is a
 * plain rule emitted last, which is exactly what `.field`, `.btn` and `.num`
 * were.
 *
 * Every block, not the first one. Task 38c had one to strip; Task 65 layered
 * nine more regions, and a `BEFORE` that unwrapped only the first would quietly
 * be comparing the new cascade against itself for all of them.
 */
function unlayer(css: string): string {
  let out = css;
  let count = 0;

  for (;;) {
    const open = out.indexOf("@layer components {");
    if (open === -1) break;

    let depth = 0;
    let close = -1;
    for (let i = out.indexOf("{", open); i < out.length; i += 1) {
      if (out[i] === "{") depth += 1;
      else if (out[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close, "a @layer components block is unbalanced").toBeGreaterThan(open);

    const inner = out.slice(out.indexOf("{", open) + 1, close);
    out = out.slice(0, open) + inner + out.slice(close + 1);
    count += 1;
  }

  // A floor, so a rename of the directive cannot turn this into a no-op that
  // compares the current cascade with itself and agrees.
  expect(count, "globals.css no longer wraps anything in @layer components").toBeGreaterThanOrEqual(
    10
  );
  return out;
}

/** One emitted rule whose selector is a single bare class, with its index. */
type ClassRule = { cls: string; selector: string; decls: [string, string][] };

/**
 * Every emitted top-level `.one-class { … }` rule, in emitted order.
 *
 * Top-level and single-class on purpose: those are the rules `.field` and a
 * plain utility both are, and comparing them is comparing like with like. A
 * rule inside `@media` or one carrying a pseudo-class is a different cascade
 * question and is left out rather than half-answered — `writesNothingOddly`
 * below refuses any call site that would need one.
 */
function classRules(css: string): ClassRule[] {
  const out: ClassRule[] = [];
  for (const node of postcss.parse(css).nodes) {
    if (node.type !== "rule") continue;
    for (const raw of node.selector.split(",")) {
      const selector = raw.trim();
      const simple = /^\.((?:[-\w]|\\.)+)$/.exec(selector);
      if (!simple) continue;
      const decls: [string, string][] = [];
      node.each((child) => {
        if (child.type === "decl") decls.push(...expand(child.prop, child.value));
      });
      out.push({ cls: simple[1].replace(/\\(.)/g, "$1"), selector, decls });
    }
  }
  return out;
}

/**
 * `padding: 0.5rem 0.7rem` → the four longhands, and `border: 1px solid x` →
 * the three it sets. Everything else passes through.
 *
 * Both are needed because the component rule writes the shorthand and the
 * utility writes a piece of it: `py-1.5` writes two sides of the padding,
 * `border-flare/50` writes only the colour. Resolving those against each other
 * is the whole question at half these call sites.
 */
function expand(prop: string, value: string): [string, string][] {
  if (prop === "padding") {
    const parts = value.trim().split(/\s+/);
    const [top, right = top, bottom = top, left = right] = parts;
    return [
      ["padding-top", top],
      ["padding-right", right],
      ["padding-bottom", bottom],
      ["padding-left", left],
    ];
  }
  if (prop === "border") {
    // Only the three-value form this stylesheet writes: `1px solid <colour>`.
    const parts = value.trim().split(/\s+/);
    if (parts.length === 3) {
      return [
        ["border-width", parts[0]],
        ["border-style", parts[1]],
        ["border-color", parts[2]],
      ];
    }
  }
  if (prop === "background") {
    /*
     * The shorthand resets both, which is the point: a `bg-*` utility writes
     * only `background-color`, and a rule declaring `background` eats it.
     * Without this, the `background: radial-gradient(…)` on the since-deleted
     * `.roundel` read as clean — it declares a property no utility writes *by
     * that name* — and the criterion-1 guard waved it through for the wrong
     * reason. `.panel`'s `background` is still measured through this path.
     */
    return [
      ["background-color", value],
      ["background-image", value],
    ];
  }
  return [[prop, value]];
}

/**
 * The cascade, for one element's class list.
 *
 * Every rule here is a single class, so every rule has the same 0-1-0
 * specificity and the browser's tie-break is source order: walk the emitted
 * rules in order and let each matching one overwrite. That is the entire
 * mechanism this task is about, and it is four lines.
 */
function resolve(
  rules: ClassRule[],
  classes: string[],
  tracked: readonly string[] = TRACKED
): Record<string, string> {
  const wanted = new Set(classes);
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!wanted.has(rule.cls)) continue;
    for (const [prop, value] of rule.decls) {
      if (tracked.includes(prop)) out[prop] = value;
    }
  }
  return out;
}

/* --------------------------------------------------------------------- */
/* Task 65: reading the layer structure out of the source                */
/* --------------------------------------------------------------------- */

/**
 * Every selector that sits inside a `@layer components` block in the source,
 * one entry per comma-separated part.
 *
 * Read rather than listed. This is what the purge guard checks and what the
 * criterion-1 guard treats as "accounted for", so both follow the file.
 */
function layeredSelectors(): string[] {
  const out: string[] = [];
  postcss.parse(fs.readFileSync(GLOBALS, "utf8")).walkRules((rule) => {
    const parent = rule.parent as postcss.AtRule | undefined;
    if (parent?.type !== "atrule" || parent.name !== "layer") return;
    for (const part of rule.selector.split(",")) out.push(part.trim());
  });
  return out;
}

/**
 * Top-level class rules in the source that are **not** in a layer — the rules
 * that still beat a utility on source order.
 *
 * Top-level only: a rule inside `@media` is a different cascade question and
 * `writesNothingOddly` already refuses any call site that would need one.
 */
type SourceRule = { selector: string; classes: string[]; props: string[] };

function unlayeredClassRules(): SourceRule[] {
  const out: SourceRule[] = [];
  for (const node of postcss.parse(fs.readFileSync(GLOBALS, "utf8")).nodes) {
    if (node.type !== "rule") continue;
    const classes: string[] = [];
    for (const raw of node.selector.split(",")) {
      const m = /^\.((?:[-\w]|\\.)+)(?:::?[-\w()]+)?$/.exec(raw.trim());
      if (m) classes.push(m[1].replace(/\\(.)/g, "$1"));
    }
    if (classes.length === 0) continue;
    const props: string[] = [];
    node.each((child) => {
      if (child.type === "decl") props.push(...expand(child.prop, child.value).map(([p]) => p));
    });
    out.push({ selector: node.selector.replace(/\s+/g, " "), classes, props });
  }
  return out;
}

/**
 * The properties a really-emitted utility writes, computed from a bare
 * stylesheet compiled against the real `src/**` content.
 *
 * Computed, not listed, and that is the point of the last acceptance criterion:
 * the set a tenth rule has to be checked against cannot be a list somebody
 * forgot to extend. Only single bare classes count — those are the rules that
 * tie with a component class at 0-1-0, which is the whole mechanism.
 */
async function utilityProperties(): Promise<{
  props: Set<string>;
  writing: (prop: string) => Set<string>;
}> {
  const bare = await compile("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
  const props = new Set<string>();
  const byProp = new Map<string, Set<string>>();

  for (const node of postcss.parse(bare).nodes) {
    if (node.type !== "rule") continue;
    for (const raw of node.selector.split(",")) {
      const m = /^\.((?:[-\w]|\\.)+)$/.exec(raw.trim());
      if (!m) continue;
      const cls = m[1].replace(/\\(.)/g, "$1");
      node.each((child) => {
        if (child.type !== "decl") return;
        props.add(child.prop);
        if (!byProp.has(child.prop)) byProp.set(child.prop, new Set());
        byProp.get(child.prop)!.add(cls);
      });
    }
  }
  return { props, writing: (prop) => byProp.get(prop) ?? new Set() };
}

/**
 * The rules Task 65 deliberately left winning, and why each one has to.
 *
 * This is the only exit from the criterion, and it is a map rather than a list
 * so a rule cannot be waved through without a sentence. Adding a class here is
 * a decision; adding a rule to `globals.css` without doing either is a failure.
 */
const MUST_KEEP_WINNING: Record<string, string> = {
  "wordmark-accent":
    "`color: transparent` is the mechanism, not a default: the gradient is seen " +
    "through it via `background-clip: text`, and `a.wordmark-accent:hover` works " +
    "by dropping the image so that colour shows. A `text-*` that beat it would " +
    "replace the lit mark with flat colour.",
};

let BEFORE: ClassRule[];
let AFTER: ClassRule[];
let AFTER_CSS: string;
let UTILITY_PROPS: Set<string>;
/** The utility classes that write `font-size` — `text-11` … `text-stage`. */
let SIZE_UTILITIES: Set<string>;

beforeAll(async () => {
  const source = fs.readFileSync(GLOBALS, "utf8");
  AFTER_CSS = await compile(source);
  AFTER = classRules(AFTER_CSS);
  BEFORE = classRules(await compile(unlayer(source)));
  const utilities = await utilityProperties();
  UTILITY_PROPS = utilities.props;
  SIZE_UTILITIES = utilities.writing("font-size");
});

/* --------------------------------------------------------------------- */
/* The call sites                                                        */
/* --------------------------------------------------------------------- */

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  })(path.join(ROOT, "src"));
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * The attribute text of one JSX element, found without a regex.
 *
 * A regex over `<Select …>` has to guess where the tag ends, and the obvious
 * guess — `\{[^{}]*\}` for a braced attribute — stops at the first nested
 * brace, so every call site carrying an `onChange={(e) => { … }}` falls out of
 * the sweep. Thirty-odd of these do. Walking the text with a brace and quote
 * counter cannot miss one, and `everyFieldOnTheSite` asserts the count it finds
 * against the count of opening tags, so a sweep that silently shrinks fails.
 */
function attributesAt(source: string, from: number): string | null {
  let depth = 0;
  let quote = "";
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(from, source[i - 1] === "/" ? i - 1 : i);
  }
  return null;
}

type CallSite = { where: string; what: string; classes: string[]; written: string[] };

/**
 * **Every control on the `.field` surface**, in both the forms it is written in.
 *
 * Both forms, and not the component alone, for the reason Task 31 recorded in
 * its own `Left over` note: a sweep keyed to the fixed form cannot report the
 * unfixed one. Four controls wear `.field` by hand rather than through the kit
 * — two in `AvailabilityGrid`, one in `FormatTab`, one in `Stepper` — and all
 * four carry a `w-*` or a `text-*` that `.field` was eating. A sweep matching
 * `<Field|Select|Textarea` would have reported the components fixed and said
 * nothing at all about those.
 *
 * Call sites with *no* `className` are collected too, and they are the majority.
 * They are the whole of the second criterion: a control nobody wrote a utility
 * on must come out of this unchanged, and there is nothing to compare unless the
 * sweep counts it.
 */
function callSites(): CallSite[] {
  const out: CallSite[] = [];

  for (const file of sourceFiles()) {
    // The three kit components are not call sites; they *are* the `.field`
    // class, and `cx("field", className)` would read as a call site writing
    // nothing. Their own call sites are everywhere else in this sweep.
    if (KIT.includes(path.basename(file))) continue;

    const source = fs.readFileSync(file, "utf8");
    const rel = relative(file);
    const lineAt = (index: number) => source.slice(0, index).split("\n").length;

    // Through the kit. `className` is the only thing a call site adds to `.field`.
    for (const match of source.matchAll(/<(Field|Select|Textarea)[\s\n]/g)) {
      const attrs = attributesAt(source, match.index + match[0].length - 1);
      expect(attrs, `${rel}:${lineAt(match.index)} <${match[1]}> never closes its tag`).not.toBeNull();

      const found = /(^|[\s{])className=("[^"]*"|\{[\s\S]*?\})/.exec(attrs!);
      const literal = found && found[2].startsWith('"') ? found[2].slice(1, -1) : null;
      expect(
        found === null || literal !== null,
        `${rel}:${lineAt(match.index)} hands <${match[1]}> a className this test cannot read ` +
          `(${found?.[2]}) — resolve it by hand or make it a literal`
      ).toBe(true);

      const written = (literal ?? "").split(/\s+/).filter(Boolean);
      out.push({
        where: `${rel}:${lineAt(match.index)}`,
        what: `<${match[1]}>`,
        classes: [FIELD, ...written],
        written,
      });
    }

    // Hand-rolled: a `className` carrying `field` itself.
    for (const match of source.matchAll(/className="([^"\n]*)"/g)) {
      const written = match[1].split(/\s+/).filter(Boolean);
      if (!written.includes(FIELD)) continue;
      out.push({
        where: `${rel}:${lineAt(match.index)}`,
        what: RAW,
        classes: written,
        written: written.filter((token) => token !== FIELD),
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------------- */
/* The mechanism                                                         */
/* --------------------------------------------------------------------- */

describe("the .field cascade", () => {
  it("puts .field in @layer components, so Tailwind emits it before the utilities", () => {
    const source = fs.readFileSync(GLOBALS, "utf8");
    const layer = source.indexOf("@layer components {");
    expect(layer, "`.field` is no longer inside @layer components").toBeGreaterThan(-1);
    expect(source.indexOf(".field {")).toBeGreaterThan(layer);
  });

  it("still emits every layered rule, which @layer components can purge", () => {
    /*
     * The cost of the mechanism, and the one way it could fail silently.
     * Tailwind tree-shakes the `components` layer against the content globs:
     * a selector in that block whose class never appears in `src/**` is simply
     * not emitted, and a field would lose its border, its focus ring or its
     * dropdown colours with nothing in the source looking wrong.
     *
     * Task 38c named its five `.field` rules by hand. Task 65 layered fifteen
     * regions and this now reads the list out of the source instead, because a
     * hand-kept list of thirty-odd selectors is a list that goes stale — and
     * going stale here means a rule silently stops being emitted, which is the
     * exact failure the list exists to catch.
     *
     * The behaviour was confirmed rather than taken on trust. A probe
     * stylesheet with `.zzz-never-used-anywhere` inside `@layer components` and
     * `.zzz-unlayered-probe` outside it, compiled by the Tailwind CLI against
     * the real content globs, emits the second and drops the first.
     *
     * It also has a trap worth knowing about, found while checking it: the
     * content globs include `src/**\/*.ts`, so **this test file is scanned
     * too**, and a class name merely *mentioned* in a comment or a string here
     * is enough to keep its rule alive. A guard that proved a rule survives the
     * purge while being the only reason it survived would be worthless, so
     * nothing below relies on a class name appearing in this file.
     */
    const layered = layeredSelectors();
    expect(layered.length, "nothing is inside @layer components any more").toBeGreaterThanOrEqual(
      25
    );

    /*
     * Compared as a set of selectors parsed out of the compiled stylesheet, not
     * as substrings of it. `toContain(".seam")` would be satisfied by
     * `.seam::after`, and a guard that a neighbouring rule can satisfy is the
     * shape of mutation that has escaped on this project twice.
     */
    const emitted = new Set<string>();
    for (const node of postcss.parse(AFTER_CSS).nodes) {
      if (node.type !== "rule") continue;
      for (const part of node.selector.split(",")) emitted.add(part.trim());
    }

    const dropped = layered.filter((selector) => !emitted.has(selector));
    expect(dropped, "these were purged from the components layer").toEqual([]);
  });

  it("keeps every layered rule alive from a real .tsx call site, not from this file", () => {
    /*
     * The premise of the guard above, checked separately — because of the trap
     * in its comment. Every selector in the layer survives the purge only
     * because its class appears in the content, and a mention in *this* file
     * counts. So each one is also required to appear as a class token in a real
     * `.tsx` literal, which `classLists` is the only thing here that looks at.
     *
     * Without this, deleting the last `className="rise"` in the app would leave
     * the rule emitted (this file names `rise` nowhere, but the pattern is the
     * danger) and the guard above would keep passing over a dead rule.
     */
    const bases = new Set(
      layeredSelectors().map((selector) => /^\.((?:[-\w]|\\.)+)/.exec(selector)?.[1] ?? "")
    );
    bases.delete("");
    expect(bases.size, "no layered classes parsed").toBeGreaterThanOrEqual(12);

    const orphans = [...bases].filter((cls) => classLists(cls).length === 0).sort();
    expect(orphans, "layered but worn by nothing in src/**/*.tsx — dead, or purge-fodder").toEqual(
      []
    );
  });

  it("leaves .field and a utility at the same specificity, so only order decides", () => {
    // Both are one bare class. If that stops being true the tie-break below is
    // no longer source order and every number in this file has to be redone.
    const field = AFTER.filter((rule) => rule.cls === FIELD);
    expect(field.map((rule) => rule.selector)).toEqual([".field"]);

    const utilities = new Set(callSites().flatMap((site) => site.written));
    for (const rule of AFTER.filter((r) => utilities.has(r.cls))) {
      expect(rule.selector, `${rule.selector} is not a single bare class`).toBe(
        `.${rule.cls.replace(/([[\].\\/%])/g, "\\$1")}`
      );
    }
  });

  it("emits .field before every utility a call site writes on a field, and did not before", () => {
    const utilities = new Set(callSites().flatMap((site) => site.written));

    for (const [name, rules, fieldShouldWin] of [
      ["before the fix", () => BEFORE, true],
      ["after the fix", () => AFTER, false],
    ] as const) {
      const list = rules();
      const field = list.findIndex((rule) => rule.cls === FIELD);
      expect(field, `.field is not emitted at all ${name}`).toBeGreaterThan(-1);

      const written = list
        .map((rule, index) => ({ ...rule, index }))
        .filter((rule) => utilities.has(rule.cls));
      expect(written.length, `no utility from a call site is emitted ${name}`).toBeGreaterThan(10);

      for (const rule of written) {
        expect(
          rule.index < field,
          `${name}: .${rule.cls} is emitted at ${rule.index} and .field at ${field}`
        ).toBe(fieldShouldWin);
      }
    }
  });
});

/* --------------------------------------------------------------------- */
/* Every field on the site                                               */
/* --------------------------------------------------------------------- */

describe("every field on the site", () => {
  it("finds the call sites, so an empty sweep cannot pass", () => {
    const sites = callSites();

    // A floor rather than an equality: adding a field is not a failure. The
    // numbers are what the site has — 103 kit call sites and 4 hand-rolled.
    expect(sites.filter((site) => site.what !== RAW).length).toBeGreaterThanOrEqual(100);
    expect(sites.filter((site) => site.what === RAW).length).toBeGreaterThanOrEqual(4);

    /*
     * And the sweep sees every opening tag there is. `attributesAt` walks the
     * source rather than matching it, but a bug in the walker would drop call
     * sites quietly, and a sweep that has quietly shrunk is the failure mode
     * this whole file is written against.
     */
    let tags = 0;
    for (const file of sourceFiles()) {
      if (KIT.includes(path.basename(file))) continue;
      tags += [...fs.readFileSync(file, "utf8").matchAll(/<(Field|Select|Textarea)[\s\n]/g)].length;
    }
    expect(sites.filter((site) => site.what !== RAW).length).toBe(tags);
  });

  it("has no control wearing .field in a form the sweep cannot see", () => {
    /*
     * The sweep reads `className="… field …"`, which is how all four hand-rolled
     * controls are written. A fifth written as `cx("field", busy && "w-auto")`
     * would be a control this file silently does not cover — the Task 31 trap,
     * one layer further in — so every other literal in `src/**` carrying a
     * `field` token has to be accounted for here.
     */
    const unseen: string[] = [];
    for (const file of sourceFiles()) {
      if (KIT.includes(path.basename(file))) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/"([^"\n]*)"/g)) {
        if (!match[1].split(/\s+/).includes(FIELD)) continue;
        if (NOT_A_CLASS_LIST.includes(match[1])) continue;
        if (source.slice(0, match.index).endsWith("className=")) continue;
        unseen.push(`${relative(file)}:${source.slice(0, match.index).split("\n").length}: ${match[1]}`);
      }
    }
    expect(unseen).toEqual([]);
  });

  it("writes nothing the resolver cannot see", () => {
    /*
     * The honest limit of the resolver, as an assertion rather than a footnote.
     * It reads top-level single-class rules, so a responsive variant
     * (`sm:w-auto`, emitted inside `@media`) or a `!important` would beat
     * `.field` by something other than source order and this file would be
     * answering the wrong question about it. None is written today.
     */
    const odd: string[] = [];
    for (const site of callSites()) {
      for (const token of site.written) {
        if (token.includes(":") || token.startsWith("!")) odd.push(`${site.where}: ${token}`);
      }
    }
    expect(odd).toEqual([]);
  });

  it("gives a field with no utility on it exactly the size it had before", () => {
    /*
     * Task 38c's second criterion, over every real call site rather than a
     * fixture. "Exactly" twice over: the resolved values are identical to the
     * ones the old cascade produced, *and* they are the numbers written at the
     * top of this file — because identical-to-before would also hold if a
     * declaration had been deleted from both.
     */
    const quiet = callSites().filter(
      (site) => JSON.stringify(resolve(BEFORE, site.classes)) === JSON.stringify(resolve(AFTER, site.classes))
    );
    expect(quiet.length, "no call site writes nothing at all — the sweep is broken").toBeGreaterThan(
      60
    );

    for (const site of quiet) {
      expect(resolve(AFTER, site.classes), `${site.where} ${site.what}`).toEqual(FIELD_DEFAULTS);
    }
  });

  it("lets the utility win where one is written, and keeps .field for the rest", () => {
    /*
     * Task 38c's first criterion, and the same sentence in both directions:
     * what a call site writes takes effect, and what it does not write still
     * comes from `.field`. `bare` is the call site's own utilities resolved
     * without `.field` in the list — the utility's own value, with nothing to
     * argue with it — so the expected result is literally the defaults with the
     * utilities laid over the top.
     */
    const loud = callSites().filter(
      (site) => JSON.stringify(resolve(BEFORE, site.classes)) !== JSON.stringify(resolve(AFTER, site.classes))
    );
    /*
     * Nineteen call sites had a utility eaten. Twenty-eight write a `className`
     * on a field at all; the other nine write only things `.field` never
     * claimed (`h-32`, `mt-3 max-w-xs`, `min-w-0 flex-1 text-center`) and were
     * never affected either way. The remaining seventy-nine write nothing and
     * are the `quiet` set above.
     *
     * A floor, not an equality: adding a field is not a failure.
     */
    expect(loud.length, "no call site writes a utility that used to be eaten").toBeGreaterThanOrEqual(
      19
    );

    for (const site of loud) {
      const bare = resolve(AFTER, site.written);
      expect(Object.keys(bare).length, `${site.where} resolves to no tracked property`).toBeGreaterThan(0);

      // Before: `.field` took all seven, whatever the author wrote.
      expect(resolve(BEFORE, site.classes), `${site.where} ${site.what} before`).toEqual(
        FIELD_DEFAULTS
      );
      // After: the utility, over the defaults.
      expect(resolve(AFTER, site.classes), `${site.where} ${site.what} after`).toEqual({
        ...FIELD_DEFAULTS,
        ...bare,
      });
    }
  });
});

/* --------------------------------------------------------------------- */
/* The three call sites the task measured, and the wrapper it removed     */
/* --------------------------------------------------------------------- */

/**
 * The three controls whose pixels were measured in a browser, named here so the
 * before/after is readable as a list rather than inferred from a sweep.
 *
 * `width` only, and `font-size`/`padding-top` where the task measured them. The
 * browser figures are in the comment; the values are what the cascade resolves.
 */
const MEASURED = [
  {
    what: "AvailabilityPanel's day Select — browser: 1010px, wanted 11rem",
    classes: [FIELD, "w-[11rem]", "shrink-0"],
    after: { width: "11rem" },
  },
  {
    what: "AvailabilityPanel's TimeSelect — browser: 1010px / 14px / 8px",
    classes: [FIELD, "w-auto", "py-1.5", "text-13"],
    after: { width: "auto", "font-size": "13px", "line-height": "20px", "padding-top": "0.375rem", "padding-bottom": "0.375rem" },
  },
  {
    what: "SuggestionBox's status Select — browser: the same",
    classes: [FIELD, "w-auto", "py-1", "text-13"],
    after: { width: "auto", "font-size": "13px", "line-height": "20px", "padding-top": "0.25rem", "padding-bottom": "0.25rem" },
  },
] as const;

describe("the three call sites the task measured", () => {
  it.each(MEASURED)("$what", ({ classes, after }) => {
    expect(resolve(BEFORE, [...classes])).toEqual(FIELD_DEFAULTS);
    expect(resolve(AFTER, [...classes])).toEqual({ ...FIELD_DEFAULTS, ...after });
  });

  it("has those class lists actually written at those call sites", () => {
    // Otherwise the table above is three strings agreeing with themselves.
    const written = new Map(callSites().map((site) => [site.classes.join(" "), site.where]));
    for (const { classes } of MEASURED) {
      expect([...written.keys()], `${classes.join(" ")} is not written anywhere`).toContain(
        [...classes].join(" ")
      );
    }
  });
});

describe("the AvailabilityPanel wrapper", () => {
  const PANEL = path.join(ROOT, "src/components/profile/AvailabilityPanel.tsx");

  it("is gone, and its width is on the Select instead", () => {
    /*
     * Task 38c's third criterion. Task 31a could not put the width on the
     * control — `.field` ate it — so it wrapped the Select in a `w-[11rem]` div
     * for the field to fill. With the cascade fixed the wrapper is a div that
     * does nothing, and the class belongs back on the control that wanted it.
     */
    const source = fs.readFileSync(PANEL, "utf8");

    const wrappers = [...source.matchAll(/<(?:div|span)\s+className="([^"]*)"/g)]
      .map((match) => match[1])
      .filter((list) => list.split(/\s+/).includes("w-[11rem]"));
    expect(wrappers, "a w-[11rem] wrapper is back in AvailabilityPanel").toEqual([]);

    const select = callSites().filter(
      (site) => site.where.startsWith("src/components/profile/AvailabilityPanel.tsx") && site.written.includes("w-[11rem]")
    );
    expect(select.length, "no Select in AvailabilityPanel carries w-[11rem]").toBe(1);
    // `shrink-0` came off the wrapper with it: the Select is the flex item now.
    expect(select[0].written).toContain("shrink-0");
  });
});

/* --------------------------------------------------------------------- */
/* Task 65: the rest of the stylesheet                                   */
/* --------------------------------------------------------------------- */

/**
 * Every class list in `src/**` that carries `cls` as one of its tokens.
 *
 * A generalisation of `callSites()` above, and deliberately matching *any*
 * double-quoted literal rather than only `className="…"`: `.num` is written as
 * `className="num …"` at 62 sites and inside a `cx(…)` at 16, and a sweep that
 * saw only the first form would have reported four fifths of a problem. Task
 * 38c's note records the other half of this trade — matching every literal is
 * what swallowed an English sentence as a class list — so every caller below
 * asserts a count, and the decision table has to name every list this finds.
 */
function classLists(cls: string): { where: string; classes: string[] }[] {
  const out: { where: string; classes: string[] }[] = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"([^"\n]*)"/g)) {
      const classes = match[1].split(/\s+/).filter(Boolean);
      if (!classes.includes(cls)) continue;
      out.push({
        where: `${relative(file)}:${source.slice(0, match.index).split("\n").length}`,
        classes,
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------------- */
/* Criterion 1 and 5: every rule in the file, not the ones we looked at  */
/* --------------------------------------------------------------------- */

describe("every class rule in globals.css", () => {
  it("is layered, writes nothing a utility writes, or says why it must win", () => {
    /*
     * The criterion that stops this recurring, and the reason it is computed
     * rather than listed: `.field` was fixed in Task 38c, `.btn` was named in
     * the same note and left for Task 65, and nobody had checked the other
     * seventeen rules. A tenth, eleventh or thirtieth rule added after
     * `@tailwind utilities` fails here rather than silently losing.
     *
     * "Writes nothing a utility writes" is measured against the properties the
     * real build actually emits, so `.hatch`'s lone `background-image` passes
     * and `.stage`'s `position` does not.
     */
    const layered = new Set(layeredSelectors());
    const unaccounted: string[] = [];

    for (const rule of unlayeredClassRules()) {
      const parts = rule.selector.split(",").map((part) => part.trim());
      if (parts.every((part) => layered.has(part))) continue;

      const clash = [...new Set(rule.props)].filter((prop) => UTILITY_PROPS.has(prop));
      if (clash.length === 0) continue;
      if (rule.classes.every((cls) => MUST_KEEP_WINNING[cls])) continue;

      unaccounted.push(`${rule.selector} — a utility also writes ${clash.join(", ")}`);
    }

    expect(unaccounted, "unlayered and able to eat a utility, with no reason given").toEqual([]);
  });

  it("finds rules to check at all, so an empty parse cannot pass", () => {
    /*
     * The assertion above is satisfied by finding nothing, which is also what a
     * broken parser returns. Every half is pinned: the top-level parser is
     * checked by name against the rules that are *supposed* to be there rather
     * than by a count, because after Task 65 there were exactly two and a count
     * of "at least two" would be met by any pair of rules at all. `.roundel`
     * was the second, and the dead-code sweep deleted it — so the name is still
     * what this asserts, and the list is now one long.
     */
    const unlayered = unlayeredClassRules().flatMap((rule) => rule.classes);
    expect(unlayered.sort(), "the top-level parser no longer finds the unlayered rule").toEqual([
      "wordmark-accent",
    ]);
    expect(layeredSelectors().length, "the components layer parsed as empty").toBeGreaterThanOrEqual(
      28
    );
    expect(UTILITY_PROPS.size, "no utility properties were computed").toBeGreaterThan(50);
    expect(SIZE_UTILITIES.size, "no font-size utilities were computed").toBeGreaterThanOrEqual(10);
  });

  it("keeps .wordmark-accent unlayered, which is the recorded decision", () => {
    /*
     * The exit has to be used, or it is an allowlist quietly covering nothing.
     * The entry is asserted to still describe the file: layering it would be a
     * behaviour change — a flat mark instead of a lit one — and it would show
     * up here.
     */
    const layered = new Set(layeredSelectors());
    for (const [cls, reason] of Object.entries(MUST_KEEP_WINNING)) {
      expect(layered.has(`.${cls}`), `.${cls} is now layered — remove its entry`).toBe(false);
      expect(reason.length, `.${cls} has no reason written`).toBeGreaterThan(80);
    }
  });
});

/* --------------------------------------------------------------------- */
/* Criterion 2: .btn's call sites                                        */
/* --------------------------------------------------------------------- */

/** What `.btn` hard-codes that a utility on a button can lose. */
const BTN_TRACKED = [
  "font-size",
  "font-weight",
  "color",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

/**
 * `.btn` with nothing written on it. The numbers, not a read-back of the rule —
 * same reason as `FIELD_DEFAULTS`: read from the stylesheet these would agree
 * with a declaration somebody had deleted.
 */
const BTN_DEFAULTS: Record<string, string> = {
  "font-size": "13px",
  "font-weight": "500",
  color: "var(--body)",
  "padding-top": "0.5rem",
  "padding-right": "0.85rem",
  "padding-bottom": "0.5rem",
  "padding-left": "0.85rem",
};

/**
 * The `.btn` class lists that write something `.btn` was eating.
 *
 * The plan recorded three. Measuring found six, because it had counted
 * `font-size` and `padding` and not `border` or `color` — and had not looked
 * inside `Button` itself, where the `size="sm"` row of a lookup table is the
 * most-used of all of them and had never once taken effect.
 *
 * `after` covers only `BTN_TRACKED`. The border claims are carried by the
 * browser figures in the file docblock and by the ordering assertion below,
 * because `border-width` against `border-right-width` is a longhand-precedence
 * question rather than a source-order one, and this resolver answers the second.
 */
const BTN_SITES = [
  {
    what: 'Button size="sm" — browser: 8px/13.6px padding -> 6px/12px',
    classes: ["btn", "px-3", "py-1.5"],
    after: {
      "padding-top": "0.375rem",
      "padding-bottom": "0.375rem",
      "padding-left": "0.75rem",
      "padding-right": "0.75rem",
    },
  },
  {
    what: "Stepper's decrease arrow — browser: 13px -> 16px, border-right 1px -> 0px",
    classes: ["btn", "w-12", "justify-center", "border-r-0", "text-16"],
    after: { "font-size": "16px" },
  },
  {
    what: "Stepper's increase arrow — the same",
    classes: ["btn", "w-12", "justify-center", "border-l-0", "text-16"],
    after: { "font-size": "16px" },
  },
  {
    what: "DevLoginBanner — browser: body grey -> flare red, 13.6px -> 12px padding",
    classes: ["btn", "border-flare/50", "px-3", "py-1.5", "text-flare"],
    after: {
      color: "rgb(var(--flare-rgb) / var(--tw-text-opacity, 1))",
      "padding-top": "0.375rem",
      "padding-bottom": "0.375rem",
      "padding-left": "0.75rem",
      "padding-right": "0.75rem",
    },
  },
  {
    what: "/admin/audit's filter chip — browser: 13px/8px -> 12px/4px",
    classes: ["btn", "border", "px-2", "py-1", "text-12"],
    after: {
      "font-size": "12px",
      "padding-top": "0.25rem",
      "padding-bottom": "0.25rem",
      "padding-left": "0.5rem",
      "padding-right": "0.5rem",
    },
  },
  {
    what: "/events/[slug]'s tab — border only, so nothing tracked here moves",
    classes: ["btn", "border-0"],
    after: {},
  },
] as const;

describe("the .btn cascade", () => {
  it.each(BTN_SITES)("$what", ({ classes, after }) => {
    // Before: `.btn` took all seven, whatever the author wrote.
    expect(resolve(BEFORE, [...classes], BTN_TRACKED)).toEqual(BTN_DEFAULTS);
    // After: the utility, over the defaults.
    expect(resolve(AFTER, [...classes], BTN_TRACKED)).toEqual({ ...BTN_DEFAULTS, ...after });
  });

  it("emits .btn before every utility a call site writes on a button, and did not before", () => {
    const written = new Set<string>(
      BTN_SITES.flatMap((site) => site.classes.filter((c) => c !== "btn"))
    );

    for (const [name, rules, btnShouldWin] of [
      ["before the fix", () => BEFORE, true],
      ["after the fix", () => AFTER, false],
    ] as const) {
      const list = rules();
      const btn = list.findIndex((rule) => rule.cls === "btn");
      expect(btn, `.btn is not emitted at all ${name}`).toBeGreaterThan(-1);

      const utilities = list
        .map((rule, index) => ({ ...rule, index }))
        .filter((rule) => written.has(rule.cls));
      expect(
        utilities.length,
        `no utility from a .btn call site is emitted ${name}`
      ).toBeGreaterThan(6);

      for (const rule of utilities) {
        expect(
          rule.index < btn,
          `${name}: .${rule.cls} is emitted at ${rule.index} and .btn at ${btn}`
        ).toBe(btnShouldWin);
      }
    }
  });

  it("has every class list above actually written in src/**", () => {
    // Otherwise the table is six arrays agreeing with themselves. `Button`'s
    // row is assembled by `cx` from a lookup, so it is checked against the
    // component's source instead of against a literal.
    const literals = new Set(classLists("btn").map((site) => site.classes.join(" ")));
    const button = fs.readFileSync(path.join(UI_DIR, "Button.tsx"), "utf8");

    expect(button, "Button no longer composes .btn with its size row").toContain(
      'cx("btn", VARIANT[variant], SIZE[size], className)'
    );
    expect(button, 'Button\'s size="sm" is no longer px-3 py-1.5').toContain('sm: "px-3 py-1.5"');

    for (const site of BTN_SITES) {
      const list = site.classes.join(" ");
      if (list === "btn px-3 py-1.5") continue; // assembled by Button, checked above
      expect([...literals], `${list} is not written anywhere`).toContain(list);
    }
  });

  it("gives a button with no utility on it exactly the size it had before", () => {
    /*
     * Criterion 4, for buttons. `Button` with no `className` and `size="md"`
     * resolves to the bare class — `SIZE.md` is an empty string — so this is
     * the overwhelming majority of buttons on the site and it must not have
     * moved. Browser-measured at 8px/13.6px on both stylesheets.
     */
    for (const classes of [["btn"], ["btn", "btn-union"], ["btn", "btn-flare"]]) {
      expect(resolve(BEFORE, classes, BTN_TRACKED)).toEqual(resolve(AFTER, classes, BTN_TRACKED));
    }
    expect(resolve(AFTER, ["btn"], BTN_TRACKED)).toEqual(BTN_DEFAULTS);
  });

  it("keeps .btn-union and .btn-flare beating .btn, which layering could have reversed", () => {
    /*
     * The variants win by coming *after* `.btn` at equal specificity. Wrapping
     * them in a `@layer components` block that landed before `.btn`'s, or in
     * the same block in the wrong order, would make a primary button render
     * `--raised` — a silent regression on every commit action on the site, and
     * one no `font-size` assertion would have noticed.
     */
    const btn = AFTER.findIndex((rule) => rule.cls === "btn");
    for (const variant of ["btn-union", "btn-flare"]) {
      const index = AFTER.findIndex((rule) => rule.cls === variant);
      expect(index, `.${variant} is not emitted`).toBeGreaterThan(-1);
      expect(index, `.${variant} is emitted before .btn and would lose to it`).toBeGreaterThan(btn);
    }

    // And the colour each resolves to, so "after .btn" is not the only claim.
    expect(resolve(AFTER, ["btn", "btn-union"], ["color"])).toEqual({ color: "var(--hot)" });
    expect(resolve(AFTER, ["btn", "btn-flare"], ["color"])).toEqual({ color: "var(--flare-soft)" });
  });
});

/* --------------------------------------------------------------------- */
/* Criterion 2: .wordmark's one call site                                */
/* --------------------------------------------------------------------- */

describe("the .wordmark cascade", () => {
  it("lets DraftRoom's wordmark render the 16px it asked for — browser: 13px -> 16px", () => {
    const classes = ["wordmark", "wordmark-accent", "text-16"];
    expect(resolve(BEFORE, classes, ["font-size"])).toEqual({ "font-size": "13px" });
    expect(resolve(AFTER, classes, ["font-size"])).toEqual({ "font-size": "16px" });
  });

  it("leaves AppHeader's wordmark at 13px, because it writes no size", () => {
    // Criterion 4 again. Browser-measured at 13px on both stylesheets.
    const classes = ["wordmark", "wordmark-accent", "shrink-0"];
    expect(resolve(BEFORE, classes, ["font-size"])).toEqual({ "font-size": "13px" });
    expect(resolve(AFTER, classes, ["font-size"])).toEqual({ "font-size": "13px" });
  });

  it("has both class lists written in src/**", () => {
    const literals = new Set(classLists("wordmark").map((site) => site.classes.join(" ")));
    expect([...literals]).toContain("wordmark wordmark-accent text-16");
    expect([...literals]).toContain("wordmark wordmark-accent shrink-0");
  });

  it("does not let a utility reach .wordmark-accent's colour", () => {
    /*
     * The other half of the `MUST_KEEP_WINNING` entry, as a value rather than a
     * promise: `/signin` writes `text-48` beside the class, and the gradient
     * still has its transparent hole to be seen through.
     */
    expect(resolve(AFTER, ["wordmark-accent", "text-48"], ["color"])).toEqual({
      color: "transparent",
    });
  });
});

/* --------------------------------------------------------------------- */
/* Criterion 3: a decision per .num call site                            */
/* --------------------------------------------------------------------- */

/**
 * What the author of each `.num` class list wanted, and which way the cascade
 * now has to break for them to get it.
 *
 *   `absolute`  — a size is written and it is a statement about pixels. The
 *                 utility now wins. Before: `0.94 × parent`, which was never
 *                 the written number.
 *   `byProp`    — the size is injected by the component's own size prop or a
 *                 conditional, so the class list alone has none. Absolute for
 *                 the same reason, and listed with every size it can inject.
 *   `relative`  — no size is written. The 0.94em correction *is* the decision,
 *                 nothing contradicts it, and it still applies. Unchanged.
 *
 * Keyed by the class list rather than by `file:line`, so the table does not
 * rot every time a line moves, and so two call sites that wrote the same thing
 * cannot be given two different answers. `everyNumCallSite` maps every site
 * found by the sweep back through here, so a new one with no decision fails.
 *
 * The partition is the finding, not a convention imposed on the file: of 78
 * sites, every one that wrote a size is a flex item, a fixed-width cell, a
 * standalone display figure or a size prop — and every figure set inline in a
 * sentence wrote nothing. The authors had already said which they meant.
 */
type NumDecision =
  | { decision: "absolute"; size: string; why: string }
  | { decision: "byProp"; sizes: string[]; why: string }
  | { decision: "relative"; why: string };

const SIBLING = "matches the step of the text it sits beside";
const FIXED = "the width was chosen to fit digits at a size, so the size is the point";
const FIGURE = "a standalone display figure — the size is the hierarchy";
const INLINE = "set inline in a run of text, where sitting 6% below it is the point";

const NUM_DECISIONS: Record<string, NumDecision> = {
  /* ---- a size is written: it takes effect ---- */
  "num block text-16 text-chalk": { decision: "absolute", size: "16px", why: FIGURE },
  "num min-w-0 flex-1 truncate text-14": { decision: "absolute", size: "14px", why: SIBLING },
  "num mt-0.5 text-11 text-muted": { decision: "absolute", size: "11px", why: SIBLING },
  "num mt-0.5 w-4 shrink-0 text-14": { decision: "absolute", size: "14px", why: FIXED },
  "num pr-2 text-right text-11 leading-[1.6rem] text-dim": {
    decision: "absolute",
    size: "11px",
    why: "an availability-grid row label; its leading-[1.6rem] pins the row height, which only holds at a known size",
  },
  "num shrink-0 text-13 text-body": { decision: "absolute", size: "13px", why: SIBLING },
  "num shrink-0 text-20": {
    decision: "absolute",
    size: "20px",
    why: "the scoreline. Browser-measured at 14.1px before — the same size as the team names beside it, so the score did not read as the score",
  },
  "num text-11 text-dim": { decision: "absolute", size: "11px", why: SIBLING },
  "num text-11 text-muted transition-colors hover:text-union": {
    decision: "absolute",
    size: "11px",
    why: SIBLING,
  },
  "num text-11 text-muted": { decision: "absolute", size: "11px", why: SIBLING },
  "num text-12 tabular-nums transition-colors": {
    decision: "absolute",
    size: "12px",
    why: "a tab's count badge, one step below the 13px tab label it follows",
  },
  "num text-12 text-body": { decision: "absolute", size: "12px", why: SIBLING },
  "num text-12 text-chalk/80": {
    decision: "absolute",
    size: "12px",
    why: "sits beside an Eyebrow, which is 12px. Rendered 13.16px before, inside a text-14 list",
  },
  "num text-12 text-dim": { decision: "absolute", size: "12px", why: SIBLING },
  "num text-12 text-muted": { decision: "absolute", size: "12px", why: SIBLING },
  "num text-12 text-union": { decision: "absolute", size: "12px", why: SIBLING },
  "num text-12": { decision: "absolute", size: "12px", why: "EventDateRange's own base step" },
  "num text-13 text-body": {
    decision: "absolute",
    size: "13px",
    why: "deliberately a step *above* the 12px 'points' beside it — the figure is the thing being read. Rendered 11.28px before, i.e. below it",
  },
  "num text-13 text-dim": { decision: "absolute", size: "13px", why: SIBLING },
  "num text-13 text-muted": { decision: "absolute", size: "13px", why: SIBLING },
  "num text-13": { decision: "absolute", size: "13px", why: SIBLING },
  "num text-14": { decision: "absolute", size: "14px", why: SIBLING },
  "num text-16 leading-none": { decision: "absolute", size: "16px", why: FIGURE },
  "num text-20": { decision: "absolute", size: "20px", why: FIGURE },
  "num w-10 shrink-0 self-center text-12 text-muted": {
    decision: "absolute",
    size: "12px",
    why: FIXED,
  },
  "num w-5 shrink-0 text-12 text-muted": { decision: "absolute", size: "12px", why: FIXED },
  "num w-5 shrink-0 text-12": { decision: "absolute", size: "12px", why: FIXED },
  "num w-6 shrink-0 text-12 text-muted": { decision: "absolute", size: "12px", why: FIXED },
  "num w-6 shrink-0 text-right text-11 text-muted": {
    decision: "absolute",
    size: "11px",
    why: "a seed index in a 24px box. Browser-measured at 14.1px before, which did not fit it",
  },
  "num w-8 shrink-0 text-12 text-muted": { decision: "absolute", size: "12px", why: FIXED },
  "num w-[15rem] shrink-0 text-13 text-chalk": { decision: "absolute", size: "13px", why: FIXED },

  /* ---- the size comes from a prop or a conditional ---- */
  "num inline-flex flex-wrap items-baseline gap-x-2": {
    decision: "byProp",
    sizes: ["text-12", "text-14"],
    why: "EventSeats' `size` prop picks the step; a prop whose whole job is choosing a size is not asking for a relative one",
  },
  "num leading-none text-chalk": {
    decision: "byProp",
    sizes: ["text-24", "text-36"],
    why: "Podium's leader gets 36px and the runners-up 24px. The difference between them *is* the component",
  },
  "num whitespace-nowrap": {
    decision: "byProp",
    sizes: ["text-12", "text-14", "text-16", "text-24", "text-48"],
    why: "Money's SIZE table. BidBox's locked bid wanted 48px and rendered 14.1px",
  },

  /* ---- no size is written: the correction stays ---- */
  num: { decision: "relative", why: INLINE },
  "num ml-auto": { decision: "relative", why: INLINE },
  "num ml-auto text-chalk": { decision: "relative", why: INLINE },
  "num mr-3 text-chalk/70": { decision: "relative", why: INLINE },
  "num shrink-0 text-chalk/80": { decision: "relative", why: INLINE },
  "num shrink-0 text-muted": { decision: "relative", why: INLINE },
  "num text-body": { decision: "relative", why: INLINE },
  "num text-chalk/80": { decision: "relative", why: INLINE },
  "num text-dim": { decision: "relative", why: INLINE },
  "num text-muted": { decision: "relative", why: INLINE },
  "num text-union": { decision: "relative", why: INLINE },
  "num w-14 shrink-0 text-right text-muted": {
    decision: "relative",
    why: "a duration column in a schedule list, which has no step of its own and should sit under whatever the list is set at",
  },
};

describe("every .num call site has a recorded decision", () => {
  it("covers every class list the sweep finds, and finds enough of them", () => {
    const sites = classLists("num");

    // Floors, so a sweep that silently finds nothing — or four fifths of the
    // sites, which is what matching only `className="…"` would have done —
    // cannot pass. The site has 78 and 46 distinct lists.
    expect(sites.length, "the .num sweep found almost nothing").toBeGreaterThanOrEqual(70);
    const lists = new Set(sites.map((site) => site.classes.join(" ")));
    expect(lists.size, "the .num sweep found almost no distinct class lists").toBeGreaterThanOrEqual(
      40
    );

    const undecided = [...lists].filter((list) => !NUM_DECISIONS[list]).sort();
    expect(undecided, "these .num class lists have no decision recorded").toEqual([]);

    // And nothing in the table that is no longer written, so it cannot drift
    // into a list of decisions about code that has gone.
    const stale = Object.keys(NUM_DECISIONS).filter((list) => !lists.has(list)).sort();
    expect(stale, "these decisions are about class lists nobody writes any more").toEqual([]);
  });

  it("records all three kinds, so a table of one answer cannot pass", () => {
    const kinds = Object.values(NUM_DECISIONS).map((entry) => entry.decision);
    expect(kinds.filter((k) => k === "absolute").length).toBeGreaterThanOrEqual(25);
    expect(kinds.filter((k) => k === "relative").length).toBeGreaterThanOrEqual(10);
    expect(kinds.filter((k) => k === "byProp").length).toBe(3);

    for (const [list, entry] of Object.entries(NUM_DECISIONS)) {
      expect(entry.why.length, `${list} has no reason written`).toBeGreaterThan(20);
    }
  });

  it.each(
    Object.entries(NUM_DECISIONS).map(([list, entry]) => ({ list, entry }))
  )("$list", ({ list, entry }) => {
    const classes = list.split(" ");

    if (entry.decision === "relative") {
      /*
       * Criterion 4. Nothing contradicts `.num` here, so the correction applies
       * on both stylesheets and the rendered size is identical — browser-
       * measured at 13.16px and 11.28px on two of these, before and after.
       */
      expect(resolve(BEFORE, classes, ["font-size"])).toEqual({ "font-size": "0.94em" });
      expect(resolve(AFTER, classes, ["font-size"])).toEqual({ "font-size": "0.94em" });
      return;
    }

    const sizes = entry.decision === "byProp" ? entry.sizes : [null];
    for (const injected of sizes) {
      const full = injected === null ? classes : [...classes, injected];
      const expected =
        entry.decision === "byProp"
          ? resolve(AFTER, [injected as string], ["font-size"])["font-size"]
          : entry.size;

      // Before: `.num` took it, and what it took was 0.94 of the *parent* —
      // not 0.94 of this, and not this.
      expect(resolve(BEFORE, full, ["font-size"]), `${list} before`).toEqual({
        "font-size": "0.94em",
      });
      // After: the size the author wrote.
      expect(resolve(AFTER, full, ["font-size"]), `${list} after`).toEqual({
        "font-size": expected,
      });
      expect(expected, `${list} resolves to no size at all`).toMatch(/^\d+px$/);
    }
  });

  it("never writes two font-size utilities in one class list", () => {
    /*
     * The trap layering opens, and the one this task had to fix in source
     * rather than in the stylesheet. Two font-size utilities on one element are
     * both 0-1-0 in the same layer, so the winner is whichever Tailwind emitted
     * later — its `fontSize` key order — and not the author.
     *
     * `BidBox` had exactly this: `size="xl"` (24px) *and* `className="text-48"`.
     * It rendered 48px only because `text-48` happens to be emitted after
     * `text-24`, and reordering the scale would have silently flipped it. Money
     * gained a `2xl` row so the size is named once.
     *
     * Checked across the whole composed class list, not the literal, because
     * that is where the two sizes met: one came from the component's lookup and
     * one from the call site's `className`.
     */
    const offenders: string[] = [];

    for (const [list, entry] of Object.entries(NUM_DECISIONS)) {
      const own = list.split(" ").filter((token) => SIZE_UTILITIES.has(token));
      const injected = entry.decision === "byProp" ? 1 : 0;
      if (own.length + injected > 1) offenders.push(`${list} writes ${own.join(" + ")}`);
    }
    expect(offenders, "a .num class list writes two sizes; emitted order would decide").toEqual([]);

    // And the same for the composed lists the passthrough components build.
    for (const file of ["src/app/events/[slug]/draft/BidBox.tsx", "src/app/events/[slug]/draft/WatchPanel.tsx"]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const both = [...source.matchAll(/<Money[^>]*>/g)].filter(
        (m) => /size="(xl|2xl|lg|md|sm)"/.test(m[0]) && /className="[^"]*\btext-\d/.test(m[0])
      );
      expect(both.map((m) => m[0]), `${file} passes a size prop and a text-* at once`).toEqual([]);
    }
  });
});
