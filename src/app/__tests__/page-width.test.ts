import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The site has one content width, and it lives in `src/components/ui/Page.tsx`.
 *
 * This file exists for the same reason `design-tokens.test.ts` does. The width
 * had drifted to **nine** values — 860, 880, 900, 1000, 1100, 1200, 1400, 1500
 * and a `max-w-lg` — because every new page copied whichever neighbour the
 * author happened to have open and nudged it. None of those is wrong on its
 * own; having nine of them is, and it is invisible until you click between two
 * pages and watch the left edge of the text jump.
 *
 * The first version of this file watched the `<main>` tag and nothing else,
 * which a review broke in one move: leave `<main>` bare and put
 * `mx-auto max-w-[900px]` on the div inside it. Same tenth width, same jumping
 * edge, four green tests. So the rule here is not about a tag. It is that a
 * page either hands its width to `Page` or is named below with a reason, and
 * that no page centres a width container of its own at any depth.
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "src/app");
const PAGE = path.join(ROOT, "src/components/ui/Page.tsx");

/**
 * Pages that legitimately do not use `Page`, each with the reason it does not.
 *
 * Both are sign-in screens, and both are the only two routes on the site with
 * no `AppHeader` over them — there is no page column to line up with, because
 * there is no page furniture at all. Adding to this list is meant to be
 * uncomfortable: a route here is a route the width rule does not cover.
 */
const NO_SHELL: Record<string, string> = {
  "src/app/signin/page.tsx":
    "Full-bleed split screen: a 1.15fr/1fr grid across the whole viewport, with " +
    "no max-width anywhere. Constraining it to the content column would put the " +
    "Discord button in a 1100px box floating in the middle of a black page.",
  "src/app/dev-login/page.tsx":
    "A single centred card, sized to the short form on it rather than to the " +
    "site's content column, and reachable only when DEV_LOGIN=1 in development. " +
    "Its cap is `max-w-lg` — Tailwind's own token on the card, not a tenth " +
    "hand-picked pixel width, and not on a container that centres the page.",
};

/**
 * Routes whose shell is rendered by a component they hand off to, and which
 * one. The `<Page>` is real, it is just one file further in.
 *
 * Separate from `NO_SHELL` because these are not exceptions to the width rule
 * — they obey it — and the difference matters when you are reading the list to
 * find out which routes are not covered. The check follows the pointer: the
 * named component has to render `Page`, or this is a broken promise rather
 * than a delegation.
 */
const DELEGATES: Record<string, string> = {
  "src/app/events/[slug]/draft/page.tsx": "src/app/events/[slug]/draft/DraftRoom.tsx",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  (function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // This file quotes the patterns it bans, so it cannot scan itself.
      else if (/\.tsx?$/.test(entry.name) && full !== __filename) out.push(full);
    }
  })(dir);
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** Every route's entry file — `page.tsx` under `src/app`, at any depth. */
function routeFiles(): string[] {
  return sourceFiles(APP).filter((file) => path.basename(file) === "page.tsx");
}

/**
 * The opening tag of every `<main>` in a file, as one string each.
 *
 * Multi-line, because the draft room's `<main>` used to spread its class list
 * over four lines and a line-at-a-time scan walked straight past it.
 */
function mainTags(source: string): string[] {
  return [...source.matchAll(/<main\b[^>]*>/gs)].map((m) => m[0]);
}

/**
 * Every `className` in a file, as one string per element: the quoted value, or
 * the whole `{…}` expression with its braces balanced.
 *
 * One element, not one literal, is the unit. `cx("mx-auto flex", wide &&
 * "max-w-[900px]")` is a single element wearing both classes, and testing the
 * literals separately would see a centred element and a wide one and pass.
 */
function classNames(source: string): string[] {
  const out: string[] = [];
  const re = /className=/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const start = m.index + m[0].length;
    const open = source[start];
    if (open === '"' || open === "'") {
      const end = source.indexOf(open, start + 1);
      if (end === -1) continue;
      out.push(source.slice(start, end + 1));
      re.lastIndex = end + 1;
    } else if (open === "{") {
      let depth = 0;
      let i = start;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
      out.push(source.slice(start, i + 1));
      re.lastIndex = i + 1;
    }
  }
  return out;
}

/**
 * Every class named anywhere inside one `className`, whatever is quoting it.
 *
 * The first version of this matched double-quoted literals only, which left it
 * blind to the single widest thing on the site before this task: DraftRoom's
 * `mx-auto grid max-w-[1500px] …` — a template literal, spanning lines, with
 * an interpolation in the middle of it. A guard that cannot see the drift it
 * was written to prevent is decoration. So punctuation is flattened to
 * whitespace rather than parsed: backticks, apostrophes, `cx(`, `&&` and a
 * ternary's two branches all fall apart into tokens, and every class is seen.
 */
function classesIn(expr: string): string[] {
  return expr
    .replace(/[`"'{}$()?:,&|]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The `className`s in a file that centre a width container: `mx-auto` and a
 * `max-w-*` on the same element, in either order.
 *
 * That pair, not `max-w-` alone, is what defines a page column — `max-w-2xl`
 * on a paragraph is the measure and is exactly right, and `max-w-lg` on a card
 * inside a centred flex row is a card. What must not exist outside `Page` is an
 * element that both sets a width and centres itself in its parent.
 */
function centresAWidth(text: string): boolean {
  const classes = classesIn(text);
  return (
    classes.some((c) => /^(?:[a-z]+:)?mx-auto$/.test(c)) &&
    classes.some((c) => /^(?:[a-z]+:)?max-w-/.test(c))
  );
}

/**
 * Two passes, because each catches what the other cannot.
 *
 * Per `className`, which is what sees a pair split across the arguments of one
 * `cx(...)` — two literals, one element.
 *
 * Then every string literal in the file, whatever it is attached to, which is
 * what sees the pair when it never reaches a `className=` at all:
 *
 *     const LOCAL_SHELL = "mx-auto max-w-[900px]";
 *     …
 *     <Page className={LOCAL_SHELL}>
 *
 * That is not a contrived evasion. Hoisting a class string to a named constant
 * is the pattern this very task taught the codebase — `PAGE_SHELL` is one —
 * so copying it into a page is the likeliest way a tenth width comes back, and
 * the same blindness would cover a helper's return value or a class table in a
 * sibling `.ts`. The first version of this file scanned literals and would
 * have caught it; the rewrite that added the `cx` coverage lost it. Both now.
 */
function widthContainers(source: string): string[] {
  const out = new Set<string>();
  for (const expr of classNames(source)) {
    if (centresAWidth(expr)) out.add(expr.replace(/\s+/g, " ").slice(0, 140));
  }
  for (const [, , body] of source.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
    if (centresAWidth(body)) out.add(`"${body.trim()}"`.slice(0, 140));
  }
  return [...out];
}

describe("one page width", () => {
  const routes = routeFiles();
  const app = sourceFiles(APP);

  it("finds every route, and knows the exceptions are real files", () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const file of [...Object.keys(NO_SHELL), ...Object.keys(DELEGATES)]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is listed but missing`).toBe(true);
    }
  });

  /* A delegation that does not deliver is worse than no delegation. */
  it("has every delegate actually render Page", () => {
    for (const [route, component] of Object.entries(DELEGATES)) {
      const full = path.join(ROOT, component);
      expect(fs.existsSync(full), `${route} delegates to ${component}, which is missing`).toBe(
        true
      );
      expect(fs.readFileSync(full, "utf8"), component).toMatch(/<Page\b/);
    }
  });

  it("has a Page component that owns the width", () => {
    const source = fs.readFileSync(PAGE, "utf8");
    expect(source).toMatch(/export const PAGE_SHELL = "[^"]*\bmax-w-\[\d+px\]/);
    expect(source).toContain("<main");
  });

  /*
   * The rule the other tests are corners of: a route renders `Page`, hands off
   * to something named in `DELEGATES` that does, or is named in `NO_SHELL`
   * with a reason somebody wrote down. Nothing else.
   *
   * An earlier version only objected to a route that opened its own `<main>`,
   * which let a new `page.tsx` returning a bare `<div>` through with no shell
   * at all — the drift this file exists to stop, arriving by the one route it
   * was not watching. `<Page>` is now required outright.
   */
  it("renders Page on every route that is not a named exception", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const rel = relative(file);
      const source = fs.readFileSync(file, "utf8");
      const usesPage = /<Page\b/.test(source);
      if (rel in NO_SHELL) {
        if (usesPage) offenders.push(`${rel}: listed as having no shell, but renders <Page>`);
        continue;
      }
      if (rel in DELEGATES) {
        if (mainTags(source).length > 0) {
          offenders.push(`${rel}: delegates its shell, but opens a <main> of its own`);
        }
        /*
         * The exemption is conditional on the delegation it claims. Without
         * this the pointer is only followed one way: this route could stop
         * rendering `DraftRoom` and return a bare `<div>`, and it would still
         * pass — exempt, no `<main>` — while `DraftRoom.tsx` sitting untouched
         * kept the delegate test green. That is the bare-`<div>` hole again,
         * surviving on the one route allowed to skip `<Page>`.
         */
        const delegate = path.basename(DELEGATES[rel], ".tsx");
        /*
         * The JSX tag, not the bare name. `source.includes("DraftRoom")` is
         * satisfied by this route's own `DraftRoomPage`, so the obvious check
         * passes a page that has deleted the import and returned a `<div>` —
         * which is precisely the mutation it is here to catch.
         */
        if (!new RegExp(`<${delegate}\\b`).test(source)) {
          offenders.push(
            `${rel}: exempt because it delegates to ${delegate}, which it never renders`
          );
        }
        continue;
      }
      if (!usesPage) {
        offenders.push(
          `${rel}: renders no <Page>. Use it, or add the route to DELEGATES or NO_SHELL.`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("caps no <main> outside Page", () => {
    const offenders: string[] = [];
    for (const file of app) {
      for (const tag of mainTags(fs.readFileSync(file, "utf8"))) {
        if (/\bmax-w-/.test(tag)) offenders.push(`${relative(file)}: ${tag.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The bypass. `<main>` bare, `mx-auto max-w-[900px]` on the div inside it,
   * and the page is 900px wide again with every other test green. The pair is
   * banned at any depth, in any file under `src/app`, exceptions included —
   * neither sign-in screen centres a width container either.
   */
  it("centres no width container of its own, at any depth", () => {
    const offenders: string[] = [];
    for (const file of app) {
      for (const body of widthContainers(fs.readFileSync(file, "utf8"))) {
        offenders.push(`${relative(file)}: "${body}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * `Page` owns the vertical padding as well as the width, and `cx` is a
   * string join that has never heard of Tailwind: `<Page className="py-12">`
   * emits `py-8 py-12` and the stylesheet's own ordering picks the winner.
   * Both halves of the shell are refused here rather than left to that.
   */
  it("is never handed a width or a padding through Page's className", () => {
    const offenders: string[] = [];
    for (const file of app) {
      for (const [, attrs] of fs.readFileSync(file, "utf8").matchAll(/<Page\b([^>]*)>/gs)) {
        if (/\b(max-w-|mx-auto|p[xy]-|w-\[)/.test(attrs)) {
          offenders.push(`${relative(file)}: <Page ${attrs.trim().replace(/\s+/g, " ")}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The header has to line up with the page under it, and the only way to be
   * sure of that is for both to be the same string. They were not: the bar was
   * `max-w-[1400px] px-5 sm:px-8` over pages at `max-w-[1400px] px-4 sm:px-6`,
   * so the wordmark sat 8px further in than the `<h1>` it introduced.
   */
  it("shares the shell with every bar that spans the page", () => {
    const bars = [
      "src/components/AppHeader.tsx",
      "src/components/DevLoginBanner.tsx",
      "src/app/events/[slug]/draft/DraftRoom.tsx",
    ];
    for (const bar of bars) {
      const source = fs.readFileSync(path.join(ROOT, bar), "utf8");
      expect(source, bar).toContain("PAGE_SHELL");
      expect(source.match(/\bmax-w-\[\d+px\]/g), bar).toBeNull();
    }
  });
});
