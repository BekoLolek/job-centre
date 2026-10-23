import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import tailwindcss from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import Eyebrow, { NAMES_A_COLOUR, type EyebrowProps } from "../Eyebrow";

/**
 * A colour passed to `<Eyebrow>` has to win. This is the file that says so.
 *
 * Task 69. `.eyebrow` declares no `color` — a label has no colour, the thing it
 * labels does — so the component supplied `text-dim` itself, hard-coded beside
 * the class, and its docblock invited call sites to "pass `text-muted` or a
 * tone class to change it". Both are single classes at 0-1-0 specificity, so
 * the tie broke on *emitted* order, and **Tailwind emits the colour utilities
 * alphabetically**. `cx` is a plain join with no dedupe, so the order the author
 * wrote them in never entered into it. The promise therefore held for half the
 * palette and failed, silently, for the other half: `text-flare`, `text-hot`,
 * `text-muted`, `text-success` and `text-union` sort after `text-dim` and won;
 * `text-body`, `text-chalk` and the chalk tones sort before it and lost.
 *
 * **Eleven call sites were already rendering a colour they had not asked for**
 * — eight `mb-2 text-chalk/70`, one `text-chalk/70`, one `mb-1 text-chalk/70`
 * and one `hidden text-chalk/80 lg:inline` — and nothing could have told
 * anybody: the class was in the markup, in the right place, doing nothing.
 *
 * The fix is for the component's default to stand aside when a call site names
 * a colour, rather than to fight it, which is the same cascade hygiene Tasks
 * 38c and 65 went to some trouble to establish. **Not `!important`:** nothing in
 * `src/**` uses one, and an `!` here would be the one place on the site where it
 * was most visible. The last test in this file measures the compiled sheet and
 * holds that line.
 *
 * **What this file measures, and what it does not.** The same honesty as
 * `field-ordering.test.ts`, whose machinery this borrows: the suite runs in
 * vitest's `node` environment with no jsdom, so nothing here renders a pixel or
 * reads a computed style. What it measures is the **resolved cascade** — it
 * compiles the real `globals.css` with the real `tailwind.config.ts` and the
 * real `src/**` globs, reads the emitted rules in emitted order, and resolves
 * each call site's class list the way a browser would: equal specificity, last
 * rule wins. The browser half of this task — what the eleven look like on
 * screen, which is a decision rather than a cascade — was done on a static
 * server in Task 30's manner and is recorded in the task notes, not faked here.
 *
 * The class lists come from rendering the real component with
 * `renderToStaticMarkup`, not from re-implementing it, so a change to how
 * `Eyebrow` composes its classes is measured rather than mirrored. `rendered()`
 * is the one thing spelled out: `cx("eyebrow text-dim", className)`, which is
 * byte-for-byte what the component did before. Every claim about the eleven is a
 * comparison between that and what the component does now.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const GLOBALS = path.join(ROOT, "src/app/globals.css");

/** The class the component wears, and the default it supplies. */
const EYEBROW = "eyebrow";
const DEFAULT_COLOUR = "text-dim";

/** `!important`, spelled so the needle is not a literal in the file that looks for it. */
const IMPORTANT = new RegExp(`${"!"}important`);


/* --------------------------------------------------------------------- */
/* Compiling the real stylesheet                                         */
/* --------------------------------------------------------------------- */

/**
 * The real `globals.css`, through the real config, against the real `src/**`.
 *
 * `extra` adds a synthetic content source, used by the palette sweep below: a
 * token nobody has written yet emits no rule, and "every colour in the theme
 * works" cannot be answered from a stylesheet that only carries the ones
 * somebody happened to use. Passing the names as content is the honest way to
 * ask — Tailwind emits them exactly where it would emit them if a call site had
 * written them, which is the only thing this file cares about.
 */
async function compile(css: string, extra?: string): Promise<string> {
  const content: (string | { raw: string; extension: string })[] = [
    path.join(ROOT, "src/**/*.{ts,tsx}").split(path.sep).join("/"),
  ];
  if (extra) content.push({ raw: extra, extension: "html" });
  // Tailwind's PostCSS plugin resolves its content globs asynchronously, so the
  // result has to be awaited rather than read off `.css`.
  const result = await postcss([tailwindcss({ ...tailwindConfig, content })]).process(css, {
    from: GLOBALS,
  });
  return result.css;
}

/** One emitted rule whose selector is a single bare class, with its colour. */
type ClassRule = { cls: string; colour: string | null };

/**
 * Every emitted top-level `.one-class { … }` rule, in emitted order.
 *
 * Top-level and single-class on purpose: those are the rules `.eyebrow` and a
 * `text-*` utility both are, and comparing them is comparing like with like. A
 * rule inside `@media` or one carrying a pseudo-class is a different cascade
 * question and is left out rather than half-answered — "writes no colour the
 * resolver cannot see" below refuses any call site that would need one.
 */
function classRules(css: string): ClassRule[] {
  const out: ClassRule[] = [];
  for (const node of postcss.parse(css).nodes) {
    if (node.type !== "rule") continue;
    for (const raw of node.selector.split(",")) {
      const simple = /^\.((?:[-\w]|\\.)+)$/.exec(raw.trim());
      if (!simple) continue;
      let colour: string | null = null;
      node.each((child) => {
        if (child.type === "decl" && child.prop === "color") colour = child.value;
      });
      out.push({ cls: simple[1].replace(/\\(.)/g, "$1"), colour });
    }
  }
  return out;
}

/**
 * The colour one element's class list resolves to, or `null` for "inherited".
 *
 * Every rule here is a single class, so every rule has the same 0-1-0
 * specificity and the browser's tie-break is source order: walk the emitted
 * rules in order and let each matching one overwrite. That is the entire
 * mechanism this task is about, and it is four lines.
 */
function resolve(rules: ClassRule[], classes: string[]): string | null {
  const wanted = new Set(classes);
  let out: string | null = null;
  for (const rule of rules) {
    if (wanted.has(rule.cls) && rule.colour !== null) out = rule.colour;
  }
  return out;
}

/** Where a class is emitted, for the ordering premise. */
function indexOf(rules: ClassRule[], cls: string): number {
  return rules.findIndex((rule) => rule.cls === cls);
}

/* --------------------------------------------------------------------- */
/* The component, and the component as it was                            */
/* --------------------------------------------------------------------- */

/**
 * The class list the real component renders, read back out of its own markup.
 *
 * Rendered rather than recomputed. A test that re-implements
 * `cx("eyebrow", fallback, className)` agrees with itself and says nothing about
 * the component; this one fails if `Eyebrow` stops adding a default, starts
 * adding two, or drops the caller's classes.
 */
function renders(className?: string, as?: EyebrowProps["as"]): string[] {
  const markup = renderToStaticMarkup(createElement(Eyebrow, { className, as }, "x"));
  const found = /class="([^"]*)"/.exec(markup);
  expect(found, `<Eyebrow className=${JSON.stringify(className)}> rendered no class`).not.toBeNull();
  return found![1].split(/\s+/).filter(Boolean);
}

/**
 * What the component used to render: `cx("eyebrow text-dim", className)`.
 *
 * Spelled out rather than recovered from history, because it is one line and
 * because the whole point of the file is to compare against it. The "renders the
 * same class list it always did" test below is what notices if this ever stops
 * being a faithful copy of what shipped.
 */
function rendered(className?: string): string[] {
  return [EYEBROW, DEFAULT_COLOUR, ...(className ?? "").split(/\s+/)].filter(Boolean);
}

/* --------------------------------------------------------------------- */
/* The call sites                                                        */
/* --------------------------------------------------------------------- */

/**
 * `.tsx` for the eyebrow sweep — only JSX can carry a `<Eyebrow>` — and both
 * extensions for the `!` scan, because `board.ts`, `labels.ts` and `story.ts`
 * author class strings too and were invisible to a `.tsx`-only walker when
 * `design-tokens.test.ts` made the same mistake.
 */
function sourceFiles(ext = /\.tsx$/): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (ext.test(entry.name)) out.push(full);
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
 * Lifted from `field-ordering.test.ts` for the reason recorded there: a regex
 * over `<Eyebrow …>` has to guess where the tag ends, and the obvious guess for
 * a braced attribute stops at the first nested brace, so a call site carrying an
 * arrow function falls out of the sweep. Walking the text with a brace and quote
 * counter cannot miss one, and the sweep asserts its own count against the count
 * of opening tags.
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

/**
 * The lines of one file that write `.eyebrow` into a class list by hand.
 *
 * Every double-quoted literal, split on the quote and taking the odd pieces,
 * which is the same two-line parser the `!` scan uses and for the same reason:
 * a regex over the raw line cannot tell a class list from the code between two
 * strings. Matching the *literal* rather than `className=` is what catches a
 * `cx("eyebrow", …)` — the exact form of the one call site Task 32's own grep
 * missed, and of two of the five the kit still has.
 *
 * Comment lines are dropped. `PageHeader`'s docblock says, in prose, that the
 * eyebrow "goes through `Eyebrow`, not `className="eyebrow"`" — a sentence that
 * is true, is worth keeping, and is not a call site. Dropping whole comment
 * lines is the same answer `dead-names.test.ts` reached.
 */
/**
 * The files that render markup — everything but the tests beside them.
 *
 * `page-header.test.ts` asserts the exact string `class="eyebrow text-dim mb-2"`
 * and this file asserts several more. Those are measurements *of* the class, and
 * reading them as call sites of it would make the guard below impossible to
 * satisfy without weakening the assertions that make it worth having.
 */
function markup(ext: RegExp): string[] {
  return sourceFiles(ext).filter((file) => !relative(file).includes("/__tests__/"));
}

function writesTheClass(file: string): string[] {
  const out: string[] = [];
  for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    const pieces = line.split('"');
    for (let at = 1; at < pieces.length; at += 2) {
      if (pieces[at].split(/\s+/).includes(EYEBROW)) out.push(`${i + 1}: ${line.trim()}`);
    }
  }
  return out;
}

/**
 * Every `className` an `<Eyebrow>` is given that is **not** a literal, and every
 * class list it can actually produce.
 *
 * Eight of them, and they have to be written down rather than skipped: the claim
 * of this file is that *no* eyebrow but the eleven changes colour, and a sweep
 * that quietly ignored the computed ones would be asserting that about 250 of
 * 258 call sites while calling it all of them. Each entry is keyed by the
 * expression as it is written, so the key breaks if the expression changes
 * rather than drifting with a line number.
 *
 * Eight and not six, and the last two are the reason the sweep walks the source
 * instead of matching it: `ScheduleTab`'s "Up next" tone and
 * `ProfileSection`'s completeness tone are written on tags spread over three
 * lines, so the obvious `<Eyebrow[^>]*className=\{` grep does not see either of
 * them at all. Both happen to be tones that already won — but a sweep that
 * silently misses a call site is worth nothing whichever way those go.
 *
 * `matchToneClass` and `note.tone` are read from their own modules
 * (`components/format/board.ts`'s `TONE_TEXT`, `ApplicantsTab`'s eligibility
 * note); the `undefined` branches are an eyebrow with no colour at all, which is
 * the component's default and the common case.
 */
const COMPUTED: Record<string, { lists: string[]; why: string }> = {
  'src/app/events/[slug]/draft/AdminConsole.tsx: lot?.allBidsIn ? "text-success" : "text-flare"': {
    lists: ["text-success", "text-flare"],
    why: "both sort after text-dim and already won; unchanged either way",
  },
  'src/app/events/[slug]/draft/TeamsRail.tsx: view.lot?.allBidsIn ? "text-success" : undefined': {
    lists: ["text-success", ""],
    why: "text-success already won; the other branch takes the default",
  },
  'src/app/events/[slug]/ScheduleTab.tsx: next.needsDecision ? "text-flare" : "text-union"': {
    lists: ["text-flare", "text-union"],
    why: "the Up-next callout; both sort after text-dim and already won",
  },
  'src/app/events/[slug]/ScheduleTab.tsx: cx("w-24 shrink-0 text-right", matchToneClass(tone))': {
    lists: [
      "w-24 shrink-0 text-right text-muted",
      "w-24 shrink-0 text-right text-flare",
      "w-24 shrink-0 text-right text-dim",
    ],
    why:
      "board.ts's TONE_TEXT is muted · muted · flare · flare · dim. Also the one " +
      "call site that writes a non-colour text-* beside a colour: `text-right` must " +
      "not read as a colour, and a hand-written `text-dim` must still resolve to dim " +
      "with the component's own default suppressed",
  },
  'src/components/admin/AnnouncementSettings.tsx: configured ? "text-success" : "text-muted"': {
    lists: ["text-success", "text-muted"],
    why: "both sort after text-dim and already won",
  },
  'src/components/admin/events/ApplicantsTab.tsx: cx("block", note.tone)': {
    lists: ["block text-flare", "block text-union", "block text-muted"],
    why: "the eligibility note's three tones, all of which already won",
  },
  'src/components/profile/ProfileSection.tsx: completeness.complete ? "text-success" : undefined': {
    lists: ["text-success", ""],
    why: "text-success already won; the other branch takes the default",
  },
  "src/components/format/ZoneNote.tsx: className": {
    lists: [""],
    why: "all five <ZoneNote /> call sites pass no className",
  },
};

type CallSite = { where: string; file: string; written: string; lists: string[]; key?: string };

/**
 * **Every `<Eyebrow>` in `src/**`**, with every class list it can render.
 *
 * Call sites with no `className` are collected too, and they are the majority.
 * They are half the claim: an eyebrow nobody wrote a colour on must come out of
 * this unchanged, and there is nothing to compare unless the sweep counts it.
 */
function callSites(): CallSite[] {
  const out: CallSite[] = [];

  for (const file of sourceFiles()) {
    // The component is not a call site of itself.
    if (path.basename(file) === "Eyebrow.tsx") continue;

    const source = fs.readFileSync(file, "utf8");
    const rel = relative(file);
    const lineAt = (index: number) => source.slice(0, index).split("\n").length;

    for (const match of source.matchAll(/<Eyebrow[\s\n>]/g)) {
      const at = match.index + match[0].length - 1;
      const where = `${rel}:${lineAt(match.index)}`;
      const attrs = source[at] === ">" ? "" : attributesAt(source, at);
      expect(attrs, `${where} <Eyebrow> never closes its tag`).not.toBeNull();

      const found = /(^|[\s{])className=("[^"]*"|\{[\s\S]*?\})/.exec(attrs!);
      if (found === null) {
        out.push({ where, file: rel, written: "", lists: [""] });
        continue;
      }
      if (found[2].startsWith('"')) {
        const literal = found[2].slice(1, -1);
        out.push({ where, file: rel, written: literal, lists: [literal] });
        continue;
      }

      const key = `${rel}: ${found[2].slice(1, -1).replace(/\s+/g, " ").trim()}`;
      const decided = COMPUTED[key];
      expect(
        decided,
        `${where} hands <Eyebrow> a className this file cannot read — add ` +
          `'${key}' to COMPUTED with every class list it produces`
      ).toBeDefined();
      out.push({ where, file: rel, written: `{computed}`, lists: decided.lists, key });
    }
  }
  return out;
}

/**
 * Every class list on the site that names a chalk tone, and why it does.
 *
 * **The decision is the task, not a side effect of it.** Fixing the component
 * changed eleven rendered colours the moment it landed, so the question "did
 * those authors want chalk, or did they want the dim they have had?" is answered
 * here, deliberately, once: **chalk — they wrote it.** Every one is a label
 * naming a control the reader is about to use, in an admin form or across the
 * top of the draft room, and in each case the author reached past the default on
 * purpose. The draft-room one is the clearest reading of all: the viewer's role
 * sits next to a bare `<Eyebrow>` showing the pool counts, so `text-chalk/80`
 * was written to lift one above the other — and with both rendering dim, that
 * distinction had never appeared on screen.
 *
 * Both tones already clear `design-tokens.test.ts`'s 4.5:1 floor on all four
 * grounds, because both are already written in the source; this makes them
 * render, it does not introduce them.
 *
 * Keyed by class list rather than by site, like `field-ordering.test.ts`'s
 * `NUM_DECISIONS`: the eight identical `mb-2 text-chalk/70` labels are one
 * decision taken eight times, and a ninth arriving needs no edit here.
 */
const DECIDED: Record<string, string> = {
  "mb-2 text-chalk/70":
    "a field label in an admin form (BasicsTab ×4, EventQuestionDialog ×2, QuestionDialog ×2) — " +
    "chalk/70 is the form-label tone the author wrote; dim is the passive-meta tone",
  "text-chalk/70":
    "the same label where the row spaces itself — EventQuestionDialog, and the three sites " +
    "converted from a bare `.eyebrow` that had been rendering chalk/70 all along",
  "mb-1 text-chalk/70": "the same label, one step tighter (EntryRulesTab)",
  "min-w-[9rem] text-chalk/70": "the same label as a `dt`, in the entry-rules list on /apply",
  "min-w-[9rem] flex-1 text-chalk/70": "the same label as a `dt`, in the applicant detail panel",
  "truncate text-chalk/70": "the captain's name on a draft team card",
  "hidden text-chalk/80 lg:inline":
    "the viewer's role in the draft-room bar, written to sit above the bare eyebrow beside it",
};

/**
 * Every call site whose colour the old hard-coded default would have eaten,
 * by file and class list.
 *
 * **Seventeen, and the split matters.** Eleven were already `<Eyebrow>` and were
 * really rendering dim against their own source — the defect Task 69 was opened
 * for. The other six were hand-written `.eyebrow` spans, so nothing was
 * overriding them and they have always rendered the chalk they ask for; they
 * are here because they are now `<Eyebrow>` too, and before the fix the
 * conversion would have darkened them. That is exactly why Task 32 could not do
 * it: converting them was blocked on this.
 *
 * No line numbers: a line number is the one part of a call site's identity that
 * an unrelated edit three functions up can change, and a guard that has to be
 * re-numbered is a guard somebody will eventually re-number without looking.
 */
const WOULD_HAVE_BEEN_EATEN = [
  "src/app/events/[slug]/apply/page.tsx min-w-[9rem] text-chalk/70",
  "src/app/events/[slug]/draft/DraftRoom.tsx hidden text-chalk/80 lg:inline",
  "src/components/admin/QuestionDialog.tsx mb-2 text-chalk/70",
  "src/components/admin/QuestionDialog.tsx mb-2 text-chalk/70",
  "src/components/admin/events/ApplicantsTab.tsx min-w-[9rem] flex-1 text-chalk/70",
  "src/components/admin/events/BasicsTab.tsx mb-2 text-chalk/70",
  "src/components/admin/events/BasicsTab.tsx mb-2 text-chalk/70",
  "src/components/admin/events/BasicsTab.tsx mb-2 text-chalk/70",
  "src/components/admin/events/BasicsTab.tsx mb-2 text-chalk/70",
  "src/components/admin/events/EntryRulesTab.tsx mb-1 text-chalk/70",
  "src/components/admin/events/EventQuestionDialog.tsx mb-2 text-chalk/70",
  "src/components/admin/events/EventQuestionDialog.tsx mb-2 text-chalk/70",
  "src/components/admin/events/EventQuestionDialog.tsx text-chalk/70",
  "src/components/apply/ApplyForm.tsx text-chalk/70",
  "src/components/apply/ApplyForm.tsx text-chalk/70",
  "src/components/draft/TeamCard.tsx truncate text-chalk/70",
  "src/components/profile/ProfileSection.tsx text-chalk/70",
];

/**
 * The only places in `src/**` still allowed to write `.eyebrow` by hand.
 *
 * Task 31's open criterion, closed: the class is a kit implementation detail,
 * and outside the kit there is now one way to wear it. These five are inside
 * `components/ui`, where composing the class *is* the kit doing its job — the
 * same relationship `Eyebrow` itself has with it. Listed rather than exempted
 * by directory so that a sixth is a decision somebody takes on purpose.
 */
const MAY_WRITE_THE_CLASS: Record<string, string> = {
  "src/components/ui/Eyebrow.tsx": "the component. It is the class.",
  "src/components/ui/FieldShell.tsx":
    "the label and hint around a field, which carry their own tones (chalk/70 and dim) " +
    "and are part of the field's own shell rather than call sites of it",
  "src/components/ui/StatusPill.tsx": "a pill is eyebrow type inside a rounded fill, not a label",
  "src/components/ui/Stepper.tsx": "the unit suffix sitting inside the control",
  "src/components/ui/Table.tsx":
    "a `th`, which `as` does not take — a table header is a column label, and giving " +
    "`Eyebrow` a `th` would put it in the middle of a `tr` where only a cell is valid",
};

/* --------------------------------------------------------------------- */

let AFTER: ClassRule[];
let AFTER_CSS: string;
let PALETTE: ClassRule[];

/** Every colour the theme defines, by the name its `text-*` utility carries. */
const COLOURS = Object.keys((tailwindConfig.theme?.extend?.colors ?? {}) as Record<string, unknown>);

beforeAll(async () => {
  const source = fs.readFileSync(GLOBALS, "utf8");
  AFTER_CSS = await compile(source);
  AFTER = classRules(AFTER_CSS);
  PALETTE = classRules(await compile(source, COLOURS.map((name) => `text-${name}`).join(" ")));
});

/* --------------------------------------------------------------------- */
/* The mechanism                                                         */
/* --------------------------------------------------------------------- */

describe("the eyebrow colour cascade", () => {
  it("leaves .eyebrow declaring no colour, so this is a utility against a utility", () => {
    /*
     * The premise, asserted rather than quoted. `.eyebrow` declining to declare
     * `color` is Task 65's recorded decision and the reason this is a cascade
     * question between two single classes at all; a `color` added to the class
     * would beat every call site at once and make the rest of this file answer
     * the wrong question.
     */
    expect(indexOf(AFTER, EYEBROW)).toBeGreaterThan(-1);
    expect(AFTER.find((rule) => rule.cls === EYEBROW)!.colour).toBeNull();
  });

  it("still emits the colour utilities alphabetically, so the hazard is real", () => {
    /*
     * Without this the file could pass vacuously. If Tailwind ever emitted
     * `text-dim` first, the old component would have been right all along and
     * every assertion below would hold for a reason that has nothing to do with
     * the fix. The order *is* the defect, so the order is measured: a tone that
     * sorts before `text-dim` is emitted before it, and one that sorts after is
     * emitted after it.
     */
    const dim = indexOf(AFTER, DEFAULT_COLOUR);
    expect(dim).toBeGreaterThan(-1);

    for (const earlier of ["text-body", "text-chalk", "text-chalk/70", "text-chalk/80"]) {
      expect(indexOf(AFTER, earlier), `${earlier} is not emitted before ${DEFAULT_COLOUR}`).toBeLessThan(dim);
    }
    for (const later of ["text-flare", "text-hot", "text-muted", "text-success", "text-union"]) {
      expect(indexOf(AFTER, later), `${later} is not emitted after ${DEFAULT_COLOUR}`).toBeGreaterThan(dim);
    }
  });

  it("is proven on text-chalk/70 and text-dim together, which is the criterion", () => {
    /*
     * Task 69's first acceptance criterion, as one test. `text-chalk/70` is the
     * tone that lost; `text-dim` written by hand is the tone that is *also* the
     * default, and it has to go on resolving to dim with the default suppressed
     * — a fix that dropped the default without the caller's class taking over
     * would show up here and nowhere else.
     */
    const before = rendered("mb-2 text-chalk/70");
    const after = renders("mb-2 text-chalk/70");

    expect(before).toContain(DEFAULT_COLOUR);
    expect(after).not.toContain(DEFAULT_COLOUR);
    expect(after).toContain(EYEBROW);

    const chalk = resolve(AFTER, ["text-chalk/70"]);
    expect(chalk).toMatch(/--chalk-rgb/);
    expect(resolve(AFTER, before)).toBe(resolve(AFTER, [DEFAULT_COLOUR]));
    expect(resolve(AFTER, after)).toBe(chalk);

    expect(resolve(AFTER, renders(DEFAULT_COLOUR))).toBe(resolve(AFTER, [DEFAULT_COLOUR]));
  });

  it("takes any colour the theme defines, whatever its alphabetical position", () => {
    /*
     * The criterion generalised from the two tones that prompted it to the whole
     * palette, against a stylesheet that also carries the tokens nobody has
     * written yet — because a token nobody has written is exactly the one that
     * will be written badly, and a usage-driven sweep cannot see it. If a colour
     * is added to `tailwind.config.ts` and not to the component's regex, this is
     * the test that fails.
     */
    expect(COLOURS.length).toBeGreaterThan(25);

    for (const name of COLOURS) {
      const utility = `text-${name}`;
      const own = resolve(PALETTE, [utility]);
      expect(own, `${utility} is not emitted even with the palette as content`).not.toBeNull();
      expect(resolve(PALETTE, renders(utility)), `<Eyebrow className="${utility}">`).toBe(own);
    }
  });

  it("agrees with the stylesheet about every text-* an eyebrow actually wears", () => {
    /*
     * The hole the theme sweep above cannot see, and it is a real one: `colors`
     * sits under `extend` in `tailwind.config.ts`, so **Tailwind's own palette is
     * still live here** — the whole of it compiles, and not one of those names is
     * in the component's list. The theme sweep walks the names this site defines;
     * this one walks every `text-*` actually written on an eyebrow, from the
     * class lists the call-site sweep collects, and holds the component's sniff
     * to the stylesheet's own answer: a class whose emitted rule declares `color`
     * must read as a colour, and one whose rule does not must not.
     *
     * So the day somebody writes a colour from outside the palette on an eyebrow,
     * this fails and names it, rather than that eyebrow quietly rendering dim —
     * which is the entire shape of the defect this file exists for. It is scoped
     * to eyebrows on purpose: what the rest of the site paints with is
     * `design-tokens.test.ts`'s question, not this component's.
     */
    const declared = new Map(AFTER.map((rule) => [rule.cls, rule.colour]));
    const wrong: string[] = [];
    let colours = 0;

    for (const site of callSites()) {
      for (const list of site.lists) {
        for (const token of list.split(/\s+/).filter(Boolean)) {
          if (!token.startsWith("text-") || !declared.has(token)) continue;
          const isColour = declared.get(token) !== null;
          if (isColour) colours += 1;
          if (NAMES_A_COLOUR.test(token) !== isColour) {
            wrong.push(`${site.where}: ${token} declares ${declared.get(token) ?? "no colour"}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);

    // A floor, so a sweep that found no `text-*` at all could not pass this.
    expect(colours).toBeGreaterThan(40);
  });

  it("keeps its default where a call site writes a text-* that is not a colour", () => {
    /*
     * The other half, and the half an over-eager sniff breaks. `text-12` is a
     * size, `text-right` an alignment, `text-balance` a wrapping rule: none of
     * them says anything about colour, so the default has to survive all three.
     * `text-right` is not hypothetical — `ScheduleTab` writes it on an eyebrow
     * beside a computed tone.
     */
    for (const token of ["text-12", "text-hero", "text-right", "text-balance", "text-ellipsis"]) {
      expect(renders(token), `<Eyebrow className="${token}">`).toContain(DEFAULT_COLOUR);
      expect(resolve(AFTER, renders(token))).toBe(resolve(AFTER, [DEFAULT_COLOUR]));
    }

    // And the names cannot collide by accident: a font-size step named after a
    // colour would make every `text-<that step>` suppress the default.
    const sizes = Object.keys((tailwindConfig.theme?.fontSize ?? {}) as Record<string, unknown>);
    expect(sizes.length).toBeGreaterThan(10);
    expect(sizes.filter((size) => COLOURS.includes(size))).toEqual([]);
  });

  it("takes text-inherit, for a label that follows whatever it sits in", () => {
    /*
     * The other half of Task 69's conversion, and the design rule said out loud.
     * Thirty-three sites were hand-written `.eyebrow` spans with no colour on
     * them: a class that declares none, so they inherited. Converting them to a
     * component that supplies `text-dim` would have *darkened* all thirty-three,
     * which is why Task 32 left them — so they carry `text-inherit` instead,
     * which is the same computed colour as declaring none and says the thing
     * the absence of a class was only implying.
     *
     * `inherit`, `current` and `transparent` are not palette tokens, so the
     * theme sweep above cannot cover them and they are asserted here. Each has
     * to suppress the default: `text-dim` beside a `text-inherit` would be
     * decided by the alphabet, and it happens to favour `inherit` — a fix that
     * works by luck of spelling is this task's own defect wearing a hat.
     */
    for (const keyword of ["inherit", "current", "transparent"]) {
      const utility = `text-${keyword}`;
      expect(renders(utility), `<Eyebrow className="${utility}">`).not.toContain(DEFAULT_COLOUR);
      expect(resolve(PALETTE, renders(utility))).toBe(resolve(PALETTE, [utility]));
    }

    // And `color: inherit` is what a bare `.eyebrow` already resolved to: the
    // class declares nothing, so the element takes its parent's colour either
    // way. That equivalence is the whole claim of the conversion.
    expect(resolve(AFTER, ["text-inherit"])).toBe("inherit");
    expect(resolve(AFTER, [EYEBROW])).toBeNull();
  });

  it("renders a dt and a button, which the bare class was being used for", () => {
    /*
     * Task 69's third criterion. Both tags are on the list because the site was
     * already writing `.eyebrow` on them by hand and `as` would not take them:
     * four definition-list labels, and the two `Alert` dismiss controls.
     *
     * The `type` is the part worth a test rather than a comment. A `<button>`
     * with no `type` defaults to `submit`, so an eyebrow dismiss control
     * standing inside a form would submit it — the two call sites wrote
     * `type="button"` themselves, and a third would eventually not. The
     * component writes it, and writes it nowhere else.
     */
    const button = renderToStaticMarkup(
      createElement(Eyebrow, { as: "button", className: "text-inherit" }, "Dismiss")
    );
    expect(button).toBe(
      '<button type="button" class="eyebrow text-inherit">Dismiss</button>'
    );

    const dt = renderToStaticMarkup(createElement(Eyebrow, { as: "dt" }, "Capacity"));
    expect(dt).toBe('<dt class="eyebrow text-dim">Capacity</dt>');

    // Nothing else gets a `type`, which would be an invalid attribute on a div.
    expect(renderToStaticMarkup(createElement(Eyebrow, null, "x"))).not.toContain("type=");
  });

  it("renders the same class list it always did where no colour is passed", () => {
    /*
     * The fix has to be invisible to the other 247 call sites, and "invisible" is
     * stronger here than "resolves to the same colour": the class attribute
     * itself is unchanged, in the same order, so nothing downstream of it can
     * shift either. `page-header.test.ts` asserts that string literally; this is
     * what says it is still allowed to.
     */
    for (const className of [undefined, "mb-2", "mb-2 text-12", "flex items-center gap-2"]) {
      expect(renders(className), `<Eyebrow className=${JSON.stringify(className)}>`).toEqual(
        rendered(className)
      );
    }
    expect(renders(undefined, "span")).toEqual([EYEBROW, DEFAULT_COLOUR]);
  });
});

/* --------------------------------------------------------------------- */
/* Every eyebrow on the site                                             */
/* --------------------------------------------------------------------- */

describe("every eyebrow on the site", () => {
  it("finds the call sites, so an empty sweep cannot pass", () => {
    const sites = callSites();

    // A floor rather than an equality: adding an eyebrow is not a failure. 297
    // is what the site has today — 258 before Task 69 converted the 39 that had
    // been writing the class by hand — and 171 of them carry a `className`.
    expect(sites.length).toBeGreaterThanOrEqual(290);
    expect(sites.filter((site) => site.written !== "").length).toBeGreaterThanOrEqual(170);

    /*
     * And the sweep sees every opening tag there is. `attributesAt` walks the
     * source rather than matching it, but a bug in the walker would drop call
     * sites quietly, and a sweep that has quietly shrunk is the failure mode
     * this whole file is written against.
     */
    let tags = 0;
    for (const file of sourceFiles()) {
      if (path.basename(file) === "Eyebrow.tsx") continue;
      tags += [...fs.readFileSync(file, "utf8").matchAll(/<Eyebrow[\s\n>]/g)].length;
    }
    expect(sites.length).toBe(tags);

    // Every computed className written down is one the sweep actually met, so a
    // stale entry cannot sit in `COMPUTED` covering nothing.
    const met = new Set(sites.map((site) => site.key).filter(Boolean));
    expect([...met].sort()).toEqual(Object.keys(COMPUTED).sort());
  });

  it("writes no colour the resolver cannot see", () => {
    /*
     * The honest limit of the resolver, as an assertion rather than a footnote.
     * It reads top-level single-class rules, so a `lg:text-chalk` (emitted inside
     * `@media`) or a `!` on a colour would win by something other than source
     * order and this file would be answering the wrong question about it. The
     * `lg:inline` on the draft-room role is fine — a variant that is not a
     * colour cannot enter a colour's cascade. None of the other kind is written
     * today, and the last test in this file holds the `!` half site-wide.
     */
    const odd: string[] = [];
    for (const site of callSites()) {
      for (const list of site.lists) {
        for (const token of list.split(/\s+/).filter(Boolean)) {
          if (!token.includes("text-")) continue;
          if (token.includes(":") || token.startsWith("!")) odd.push(`${site.where}: ${token}`);
        }
      }
    }
    expect(odd).toEqual([]);
  });

  it("never overrides a colour the call site names", () => {
    /*
     * The durable form of the whole task, and it needs no history: for every
     * call site, what the component renders resolves to the same colour as the
     * bare class plus that call site's own classes would. The component adds a
     * colour where none is named and gets out of the way where one is — which is
     * what the docblock promises, said as a measurement over all 297 of them.
     *
     * The two sides differ at exactly the sites that name no colour, and there
     * the bare class resolves to `null` (inherited) while the component supplies
     * dim. That is the default, not an override, so those are the only ones
     * excluded — and the count of them is asserted so this cannot pass by
     * excluding everything.
     */
    const named: CallSite[] = [];
    const quiet: CallSite[] = [];

    for (const site of callSites()) {
      for (const list of site.lists) {
        const classes = list.split(/\s+/).filter(Boolean);
        const bare = resolve(AFTER, [EYEBROW, ...classes]);
        if (bare === null) {
          quiet.push(site);
          expect(resolve(AFTER, renders(list)), `${site.where} names no colour`).toBe(
            resolve(AFTER, [DEFAULT_COLOUR])
          );
          continue;
        }
        named.push(site);
        expect(resolve(AFTER, renders(list)), `${site.where} ${list}`).toBe(bare);
      }
    }

    expect(named.length).toBeGreaterThanOrEqual(50);
    expect(quiet.length).toBeGreaterThanOrEqual(120);
  });

  it("changes the rendered colour of the seventeen that asked for one, and nothing else", () => {
    /*
     * Task 69's second and fourth criteria in one pass, over every call site and
     * every branch of every computed className rather than over the eleven a grep
     * finds. `before` is the old component's class list, `after` the real one's;
     * the comparison is the colour each resolves to out of the compiled sheet, so
     * a site writing a tone that already won reads as unchanged — which it is.
     *
     * Seventeen now, not eleven, and the extra six are a conversion rather than a
     * defect: they were hand-written `.eyebrow` spans rendering the chalk they
     * asked for, and this comparison asks what the *old component* would have
     * done with them, which is eat it. That is the answer to why Task 32 could
     * not convert them. `WOULD_HAVE_BEEN_EATEN` keeps the two groups apart.
     */
    const changed: { where: string; written: string; from: string | null; to: string | null }[] = [];
    const same: CallSite[] = [];

    for (const site of callSites()) {
      let moved = false;
      for (const list of site.lists) {
        const from = resolve(AFTER, rendered(list));
        const to = resolve(AFTER, renders(list));
        if (from === to) continue;
        moved = true;
        changed.push({ where: `${site.file} ${list}`, written: list, from, to });
      }
      if (!moved) same.push(site);
    }

    // The count first, because it is the claim.
    expect(changed.map((site) => site.where).sort()).toEqual(WOULD_HAVE_BEEN_EATEN);

    // Each one moves off dim and onto the tone its own class list names, and each
    // class list is a decision somebody took rather than a diff somebody accepted.
    const dim = resolve(AFTER, [DEFAULT_COLOUR]);
    for (const site of changed) {
      expect(site.from, `${site.where} did not render dim before`).toBe(dim);
      expect(DECIDED[site.written], `${site.where} has no recorded decision`).toBeTruthy();
      expect(site.to, site.where).toBe(
        resolve(AFTER, [site.written.split(/\s+/).find((token) => token.startsWith("text-"))!])
      );
    }

    // And the rest are untouched — the majority of the claim, and the half a grep
    // for `text-chalk` could not have made.
    expect(same.length).toBeGreaterThanOrEqual(270);
  });

  it("leaves nobody outside the kit writing the class by hand", () => {
    /*
     * Task 31's criterion, carried through Task 32 and closed here: outside
     * `components/ui` there is one way to wear `.eyebrow`, and it is this
     * component. Thirty-nine call sites were writing the class directly, and
     * every one of them was a colour decision rather than a rename — which is
     * why this could not be a sweep until the component could carry a colour.
     *
     * Matched on the class list rather than on `className=`, so a `cx("eyebrow",
     * …)` cannot slip past: that is the exact form of the one site Task 32's own
     * grep missed. `.ts` files are read too, because `board.ts` and `labels.ts`
     * author class strings.
     */
    const written: string[] = [];
    for (const file of markup(/\.tsx?$/)) {
      const rel = relative(file);
      if (rel.startsWith("src/components/ui/")) continue;
      written.push(...writesTheClass(file).map((line) => `${rel}:${line}`));
    }
    expect(written).toEqual([]);

    /*
     * And inside the kit it is written in exactly five files, each with a reason
     * — read off the directory rather than listed, so a sixth is a decision
     * somebody takes on purpose instead of a line nobody noticed. Composing the
     * class is what a kit component is allowed to do; `Eyebrow` is one of the
     * five itself.
     */
    const inKit = markup(/\.tsx?$/)
      .filter((file) => relative(file).startsWith("src/components/ui/"))
      .filter((file) => writesTheClass(file).length > 0)
      .map(relative);

    expect(inKit.sort()).toEqual(Object.keys(MAY_WRITE_THE_CLASS).sort());
    for (const [rel, why] of Object.entries(MAY_WRITE_THE_CLASS)) {
      expect(why.length, `${rel} has no reason`).toBeGreaterThan(20);
    }
  });
});

/* --------------------------------------------------------------------- */

describe("the cascade stays clean", () => {
  it("fixes this with source order rather than an override, anywhere in src", () => {
    /*
     * Task 69's last criterion. A `!`-prefixed utility can only reach an element
     * through a class list, and in this repo a class list is a double-quoted
     * string — `className="…"`, a `cx()` argument, or a constant one of those
     * reads — so every double-quoted literal in `src/**` is scanned for a token
     * starting with `!`. Splitting each line on `"` and taking the odd pieces is
     * the whole of the parser, and it is used rather than a regex over the line
     * because a regex spans the code *between* two literals: `!== "x"` and
     * `!v.includes("y")` both read as a `!` token to anything that does not know
     * where a string starts.
     *
     * **This is deliberately not measured off the compiled stylesheet, and the
     * reason is worth recording.** The obvious version of this test — "no
     * `!important` in the emitted CSS" — fails today, and not because anybody
     * wrote one. Tailwind's content scanner reads `src/**` as text, so a
     * TypeScript negation is a class candidate: `if (!field)`, `!hidden` and
     * `!stage` have between them produced `.\!field`, `.\!hidden` and `.\!stage`
     * in the output, around twenty `!important` declarations on three rules no
     * element in the repo wears. They are harmless — nothing matches them — but
     * they mean the compiled sheet cannot answer this question, and a guard that
     * fails for a reason unrelated to its criterion is a guard somebody deletes.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles(/\.tsx?$/)) {
      const rel = relative(file);
      for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
        const pieces = line.split('"');
        for (let at = 1; at < pieces.length; at += 2) {
          for (const token of pieces[at].split(/\s+/)) {
            if (/^![a-z[]/.test(token)) offenders.push(`${rel}:${i + 1}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // And the stylesheet itself writes none by hand, which the emitted CSS
    // cannot be asked but the source can.
    expect(IMPORTANT.test(fs.readFileSync(GLOBALS, "utf8"))).toBe(false);
    expect(AFTER_CSS.length).toBeGreaterThan(10_000);
  });
});
