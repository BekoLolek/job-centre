import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import Checkbox, { type CheckboxProps } from "../Checkbox";

/**
 * The checkbox is 44x44 to the finger and 16x16 to the eye, and this is the
 * arithmetic that says so.
 *
 * The Constraints in `docs/requirements.md` put the site on a phone at ~400px,
 * and `/me/notifications` — the switches R-104 asks for, UC-25 6 — is a whole
 * column of these on exactly that screen. The drawn box is 16px, which is a
 * third of the 44px touch floor, so `Checkbox` wraps it in a `<label>` sized
 * to 44. Nothing in the suite renders a DOM, so the measurement is done the
 * way `design-tokens.test.ts` does its contrast: from the source and the
 * resolved theme, which is where the numbers actually come from.
 *
 * Four things hold the 44 up, and every one of them is somebody else's file:
 * Tailwind's `11` step, the root font size, the class lists in `Checkbox.tsx`,
 * and the width of the column the bare box sits in. Each is pinned below, so
 * the one that moves says which one moved rather than quietly costing a
 * member a tap.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const UI_DIR = path.join(ROOT, "src/components/ui");
const CHECKBOX = path.join(UI_DIR, "Checkbox.tsx");
const GLOBALS = path.join(ROOT, "src/app/globals.css");

/** The floor, in CSS pixels: WCAG 2.5.5 / the iOS and Android touch guidance. */
const TOUCH_FLOOR_PX = 44;

/**
 * What a rem is on this site.
 *
 * `globals.css` sets `font-size: 15px` on `body`, not on `html` or `:root`, so
 * a rem is still the browser's default. That distinction is the whole of the
 * arithmetic below — at 15px to the rem, `h-11` would be 41.25px and the
 * control would miss the floor by three pixels with every class list in this
 * file unchanged — so the test asserts it rather than assuming it.
 */
const ROOT_FONT_PX = 16;

const theme = resolveConfig(tailwindConfig).theme as unknown as {
  spacing: Record<string, string>;
};

/** `"2.75rem"` → `44`. Only rem and px appear in the scale this reads from. */
function toPx(value: string): number {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * ROOT_FONT_PX;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`not a length this test can measure: ${value}`);
}

/** The spacing step a utility ends in — `h-11` → `11`, `px-3` → `3`. */
function stepPx(utility: string): number {
  const step = utility.slice(utility.lastIndexOf("-") + 1);
  const value = theme.spacing[step];
  expect(value, `Tailwind has no spacing step "${step}" for ${utility}`).toBeDefined();
  return toPx(value);
}

/**
 * Every double-quoted class list in a file, as its tokens.
 *
 * Tokens rather than the literal, so the assertions below are about which
 * classes are written and not about the order somebody wrote them in — the
 * same reason `page-width.test.ts` flattens punctuation instead of parsing.
 */
function classLists(file: string): string[][] {
  return [...fs.readFileSync(file, "utf8").matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1].split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** The one class list in `Checkbox.tsx` containing `marker`, tokens and all. */
function theListWith(marker: string): string[] {
  const found = classLists(CHECKBOX).filter((tokens) => tokens.includes(marker));
  expect(
    found.length,
    `expected exactly one class list in Checkbox.tsx carrying "${marker}", found ${found.length}`
  ).toBe(1);
  return found[0];
}

describe("the checkbox hit area", () => {
  it("has a rem worth 16px, because globals.css sizes the body and not the root", () => {
    const css = fs.readFileSync(GLOBALS, "utf8");
    // Every selector that opens a block, paired with the block itself.
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!/font-size\s*:/.test(body)) continue;
      const targetsRoot = selector
        .split(",")
        .some((part) => /(^|\s)(html|:root)\s*$/.test(part.trim()));
      expect(
        targetsRoot,
        `${selector.trim().replace(/\s+/g, " ")} sets a font-size on the root — ` +
          `h-11 is no longer ${TOUCH_FLOOR_PX}px and Checkbox.tsx has to be re-measured`
      ).toBe(false);
    }
  });

  it("has a Tailwind step 11 that is exactly the touch floor", () => {
    expect(toPx(theme.spacing["11"])).toBe(TOUCH_FLOOR_PX);
  });

  it("wraps a bare box in a label that is 44 by 44", () => {
    const tokens = theListWith("h-11");
    // Inline, so the `text-center` on the table cell it usually sits in still
    // centres it: a block-level 44px box would pin itself to the left instead.
    expect(tokens).toContain("inline-flex");
    expect(tokens).toContain("items-center");
    expect(tokens).toContain("justify-center");
    expect(stepPx("h-11")).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    expect(tokens).toContain("w-11");
    expect(stepPx("w-11")).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
  });

  it("floors a labelled box at 44 by 44 too", () => {
    const tokens = theListWith("min-h-11");
    expect(tokens).toContain("flex");
    expect(tokens).toContain("items-center");
    expect(stepPx("min-h-11")).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    // The words are usually wider than 44 on their own — usually is not a
    // measurement, and a one-word label plus a 16px box and an 8px gap is 24.
    expect(tokens).toContain("min-w-11");
    expect(stepPx("min-w-11")).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
  });

  it("leaves the drawn box and its focus ring exactly where they were", () => {
    const tokens = theListWith("h-4");
    expect(tokens).toEqual(["h-4", "w-4", "shrink-0", "accent-union"]);
    expect(toPx(theme.spacing["4"])).toBe(16);

    /*
     * The third acceptance criterion of Task 38b, and the reason the hit area
     * is a wrapper rather than padding on the input. The ring is drawn on the
     * input's border box: padding it out to 44px would take the ring with it
     * and turn a tight outline into a box nearly three times the size.
     */
    const ring = theListWith("focus-visible:ring-2");
    expect(ring).toEqual([
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-union",
    ]);
    expect(classLists(CHECKBOX).flat().filter((c) => c.includes("ring-offset"))).toEqual([]);
  });

  it("passes no className down to the input, where it could resize the box", () => {
    /*
     * `className` lands on the `<label>` in both branches. It used to reach
     * the `<input>` in the bare one (`label === undefined && className`),
     * which is a call site able to resize the box — or the ring — from the
     * outside, and the one way the 44 could be undone without touching this
     * component at all.
     */
    const source = fs.readFileSync(CHECKBOX, "utf8");
    const start = source.indexOf("const box = (");
    expect(start, "Checkbox.tsx no longer builds its input as `const box`").toBeGreaterThan(-1);
    const box = source.slice(start, source.indexOf("\n  );", start));

    const args = /className=\{cx\(([\s\S]*?)\)\}/.exec(box);
    expect(args, "the input no longer takes its classes from a cx(…) call").not.toBeNull();
    expect(/\bclassName\b/.test(args![1])).toBe(false);
  });
});

/* --------------------------------------------------------------------- */
/* The control that is actually rendered                                 */
/* --------------------------------------------------------------------- */

function markup(over: Partial<CheckboxProps> = {}): string {
  const props: CheckboxProps = { checked: false, onChange: () => {}, ...over };
  return renderToStaticMarkup(createElement(Checkbox, props));
}

/** Both branches of the component: the bare box, and the box-and-words pair. */
const BOTH = [
  ["bare", {}],
  ["labelled", { label: "Email me" }],
] as const;

/**
 * The keyboard half of Task 38b's third criterion — "keyboard behaviour and
 * the focus ring are unchanged" — and the honest limit of what this file can
 * say about it.
 *
 * **It cannot press a key, and does not pretend to.** These are
 * `renderToStaticMarkup` renders in vitest's `node` environment: there is no
 * DOM, no jsdom and no testing-library, so there is nothing to dispatch a
 * `keydown` at and nothing that would handle one. An assertion here that
 * claimed to check the space bar would be an assertion about a string.
 *
 * What it *can* check is the thing the space bar depends on, and the thing no
 * assertion in this file held: that the rendered control is a **native
 * `<input type="checkbox">`**. Space-to-toggle is the browser's own activation
 * behaviour for that element — `Checkbox`'s docblock leans on it out loud
 * ("the browser already gives it the tick, the space-bar, the label
 * association") and then nothing checked it was still there. Replacing the
 * input with a `<div role="checkbox">` carrying the same class lists left
 * every other assertion in this file passing, because they all read the
 * *source* for class names and the div would still carry them, while the
 * control stopped working from the keyboard entirely.
 *
 * Genuine key handling belongs to a browser, and there is none in this suite.
 * This is the strongest statement available without one, so it is the one made.
 */
describe("the rendered control", () => {
  it.each(BOTH)("is a native checkbox input in the %s branch", (_, over) => {
    const rendered = markup(over);

    expect(rendered).toMatch(/<input\b[^>]*\btype="checkbox"/);
    // And nothing dressed up as one. A `role` on this control would mean the
    // native behaviour had been re-implemented rather than used, which is the
    // one way to lose the space bar with every class list above unchanged.
    expect(rendered).not.toMatch(/\brole=/);
  });

  it.each(BOTH)("keeps that input in the tab order in the %s branch", (_, over) => {
    // The other way to the same loss: `tabindex="-1"` takes the control out of
    // the tab order, so the space bar never gets a chance to reach it, and no
    // class list in this file would have moved.
    expect(markup(over)).not.toMatch(/tabindex/i);
  });

  it.each(BOTH)("nests the input inside the 44px label in the %s branch", (_, over) => {
    /*
     * A hit area is only a hit area if a click anywhere in it reaches the
     * control. For a wrapping `<label>` that is the *nesting* — there is no
     * `for`/`id` pair here to do it instead — so a refactor that lifted the
     * input out as a sibling would leave a 44px box that toggles nothing.
     */
    expect(markup(over)).toMatch(/^<label\b[^>]*>[\s\S]*<input\b[\s\S]*<\/label>$/);
  });
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

/**
 * **Every checkbox on the site**: each `<Checkbox … />` call site, and any raw
 * native `<input type="checkbox">` still left outside `components/ui`.
 *
 * Both, and not the first alone, because this is the sweep that is supposed to
 * notice an *unconverted* control — and while it matched `<Checkbox` it could
 * only see the ones already converted, which is a sweep that cannot fail for
 * the reason it exists. Two raw boxes sat outside `components/ui` through the
 * whole of Task 31 and this counted neither: the eyebrow-sized "Played" box in
 * `ResultsTab`, around 20px tall and well under the floor, and the one in
 * `ServerSettings`, which cleared 44px only because the label beside it
 * happened to run to two lines and had no `min-h-11` saying so.
 *
 * The whole of `components/ui` is skipped rather than `Checkbox.tsx` alone,
 * because "outside `components/ui`" is what Task 31's criterion says and the
 * kit's own text inputs are not this test's business.
 */
function callSites(): { where: string; attrs: string; raw: boolean }[] {
  const out: { where: string; attrs: string; raw: boolean }[] = [];
  for (const file of sourceFiles()) {
    if (file.startsWith(UI_DIR + path.sep)) continue;
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    for (const match of source.matchAll(/<(Checkbox|input)\b([\s\S]*?)\/>/g)) {
      const raw = match[1] === "input";
      // Every other `<input>` on the site is a text field, a date or a number,
      // and `Field` owns those; only the checkboxes belong to this file.
      if (raw && !/type=\{?"checkbox"\}?/.test(match[2])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      out.push({ where: `${rel}:${line}`, attrs: match[2], raw });
    }
  }
  return out;
}

describe("every checkbox on the site", () => {
  it("finds the call sites, so an empty sweep cannot pass", () => {
    // Five is what Task 31 planned ("add Checkbox (five uses)") and six is
    // what the site has once `ResultsTab` and `ServerSettings` are converted.
    // A floor rather than an equality, so adding one is not a failure.
    expect(callSites().length).toBeGreaterThanOrEqual(5);
  });

  it("has no raw native checkbox left outside components/ui", () => {
    /*
     * Task 31's acceptance criterion as an assertion rather than as a grep
     * somebody has to remember to run, and the one thing the sweep below could
     * not say while it matched `<Checkbox` alone. A raw box is a box with no
     * 44px hit area, no focus ring in the site's blue, and nothing above it
     * that would notice either.
     */
    expect(
      callSites()
        .filter((site) => site.raw)
        .map((site) => site.where)
    ).toEqual([]);
  });

  /*
   * `cx` is a string join that has never heard of Tailwind — the same trap
   * `page-width.test.ts` names for `<Page className="py-12">`. A `h-6` or a
   * `pb-1` handed in here emits alongside the component's own `h-11` and the
   * stylesheet's ordering picks the winner, so the size the component
   * guarantees is only a guarantee while nothing argues with it.
   *
   * `pb-1` is not hypothetical: `PollList` carried one, nudging a 20px-tall
   * label up off the bottom of an `items-end` row, and it survives the switch
   * to a 44px control as 4px of padding inside it.
   */
  it("is never handed a size or a padding through className", () => {
    const offenders: string[] = [];
    for (const { where, attrs } of callSites()) {
      for (const [, body] of attrs.matchAll(/className=(?:"([^"]*)"|\{([\s\S]*?)\})/g)) {
        for (const token of (body ?? "").replace(/[`"'{}$()?:,&|]/g, " ").split(/\s+/)) {
          if (/^(?:[a-z]+:)?(?:min-)?[hw]-|^(?:[a-z]+:)?p[xytblr]?-/.test(token)) {
            offenders.push(`${where}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The one call site whose container could squeeze the 44px box: the switch
   * columns on `/me/notifications` are a fixed width, and `TableCell` spends
   * some of it on padding. 4.5rem (72px) less `px-3` (2 x 12px) leaves 48px of
   * content box for a 44px label. Narrow the column by 5px and the label
   * overflows its cell; this is the test that says so out loud.
   */
  it("gives the notification switch columns room for a 44px label", () => {
    const list = fs.readFileSync(path.join(ROOT, "src/components/me/NotificationList.tsx"), "utf8");
    const column = /SWITCH_COL\s*=\s*"w-\[([\d.]+)rem\]"/.exec(list);
    expect(column, "NotificationList no longer declares SWITCH_COL as a rem width").not.toBeNull();

    const table = fs.readFileSync(path.join(ROOT, "src/components/ui/Table.tsx"), "utf8");
    const cell = /<td\b[\s\S]*?cx\([\s\S]*?"(px-\d+) /.exec(table);
    expect(cell, "TableCell no longer opens its class list with a px-* step").not.toBeNull();

    const content = Number(column![1]) * ROOT_FONT_PX - 2 * stepPx(cell![1]);
    expect(content, `the switch column leaves ${content}px for the label`).toBeGreaterThanOrEqual(
      TOUCH_FLOOR_PX
    );
  });
});
