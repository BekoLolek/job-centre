import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ADMIN_SECTIONS } from "../../admin/AdminNav";
import PageHeader, { type PageHeaderProps } from "../PageHeader";

/**
 * One header, on every page, with the decisions made in one file.
 *
 * `page-width.test.ts` holds the other half of Task 30 — the three widths and
 * the gutters they share. This file holds the header: that there is exactly one
 * of it, that every route wears it, that it renders what it says it renders,
 * and that an admin page's eyebrow says the same word the bar uses for that
 * section.
 *
 * **What this file cannot do, and does not pretend to.** The suite runs in
 * vitest's `node` environment — no DOM, no jsdom, no testing-library — so
 * nothing here measures a layout. Task 30's third acceptance criterion
 * ("verified at 400 px and desktop") is a browser measurement and was done in
 * one; it is recorded in the task notes, not faked here. What a
 * `renderToStaticMarkup` render *can* settle is which element each slot lands
 * in and in what order, and that is what is asserted.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const APP = path.join(ROOT, "src/app");

/* --------------------------------------------------------------------- */
/* The component                                                         */
/* --------------------------------------------------------------------- */

function markup(over: Partial<PageHeaderProps> = {}): string {
  const props: PageHeaderProps = { eyebrow: "Job Centre · Polls", title: "Polls", ...over };
  return renderToStaticMarkup(createElement(PageHeader, props));
}

describe("the one page header", () => {
  it("is a <header> with exactly one <h1>", () => {
    const rendered = markup();
    expect(rendered.startsWith("<header")).toBe(true);
    expect(rendered.match(/<h1\b/g)).toEqual(["<h1"]);
    expect(rendered).toContain(">Polls</h1>");
  });

  it("sizes that heading at the one step the scale calls a page h1", () => {
    /*
     * The decision the docblock claims, asserted: `text-36` and nothing
     * arguing with it. `font-display` is the same weight at *looser* tracking
     * than `h1`'s own rule in `globals.css`, and `leading-none` crushes a
     * wrapping two-line title at 400px into itself — both were on eleven of
     * the thirty headers this replaced, and a later edit putting either back
     * would be invisible on any one page.
     */
    const heading = /<h1\b[^>]*>/.exec(markup())![0];
    expect(/class="([^"]*)"/.exec(heading)![1].split(/\s+/)).toEqual(["text-36"]);
  });

  it("puts the eyebrow through Eyebrow rather than the bare class", () => {
    /*
     * `.eyebrow` loads after `@tailwind utilities`, so a hand-written
     * `className="eyebrow"` silently beats any `text-*` beside it — the defect
     * `Eyebrow`'s own docblock exists to record. Both carry the class, so the
     * tell is the colour the component adds.
     */
    const rendered = markup();
    expect(rendered).toMatch(/class="eyebrow text-dim [^"]*">Job Centre · Polls</);
  });

  it("draws no entrance animation", () => {
    // Six of the headers this replaced had `rise` on them. A page's header is
    // the first thing read on arrival; animating it in on every navigation is
    // the "fade in every section" tell the design rules ban.
    expect(markup({ intro: "x", aside: "y", lead: "z", banner: "b" })).not.toContain("rise");
  });

  it("renders nothing for a slot it was not given", () => {
    /*
     * The whole of it, exactly, for the smallest header there is: an eyebrow
     * and a title. Spelled out rather than counted, because what this is
     * guarding against is a *wrapper* — the intro's measure, the aside's
     * `ml-auto` rail or the banner's `mb-6` surviving as an empty box with its
     * margin — and an empty `<div>` is invisible to every assertion except the
     * one that says what the markup is.
     */
    expect(markup()).toBe(
      '<header><div class="flex flex-wrap items-end gap-x-10 gap-y-6">' +
        '<div class="flex min-w-0 flex-wrap items-center gap-5">' +
        '<div class="min-w-0">' +
        '<div class="eyebrow text-dim mb-2">Job Centre · Polls</div>' +
        '<h1 class="text-36">Polls</h1>' +
        "</div></div></div></header>"
    );
  });

  it("puts the banner above the title and the aside after it", () => {
    const rendered = markup({
      banner: createElement("img", { src: "/b.png", alt: "" }),
      intro: "What this is",
      aside: createElement("b", null, "41"),
      lead: createElement("i", null, "AB"),
    });
    const at = (needle: string) => rendered.indexOf(needle);

    expect(at("<img")).toBeGreaterThan(-1);
    expect(at("<img")).toBeLessThan(at("<i>AB</i>"));
    expect(at("<i>AB</i>")).toBeLessThan(at("<h1"));
    expect(at("<h1")).toBeLessThan(at("What this is"));
    expect(at("What this is")).toBeLessThan(at("<b>41</b>"));
  });

  it("caps the intro at a measure, and nothing else", () => {
    const intro = /class="mt-3 ([^"]*)">What this is/.exec(markup({ intro: "What this is" }));
    expect(intro, "the intro no longer opens its class list with mt-3").not.toBeNull();
    expect(intro![1].split(/\s+/)).toEqual([
      "max-w-[62ch]",
      "text-14",
      "leading-relaxed",
      "text-muted",
    ]);
  });

  it("takes no className, so no call site can nudge it", () => {
    /*
     * The type refuses this, and a type is not a test: `PageHeaderProps` could
     * grow a `className` in one line and thirty pages could start drifting
     * again. Passed through `as` the way a call site would have to, and the
     * class must not reach the markup.
     */
    const rendered = renderToStaticMarkup(
      createElement(PageHeader, {
        eyebrow: "e",
        title: "t",
        ...{ className: "mb-20 max-w-[900px]" },
      } as PageHeaderProps)
    );
    expect(rendered).not.toContain("mb-20");
    expect(rendered).not.toContain("max-w-[900px]");
  });
});

/* --------------------------------------------------------------------- */
/* Every route                                                           */
/* --------------------------------------------------------------------- */

/**
 * Every route's entry file, read off the disk.
 *
 * Enumerated rather than matched: the lesson in Task 31's `Left over` note is
 * that a sweep keyed to the *fixed* form cannot report the *unfixed* one.
 * Counting `<PageHeader` call sites would count the pages already converted and
 * be blind to the one that is not, so the list starts from the routes that
 * exist and asks each of them the question.
 */
function routeFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") out.push(full);
    }
  })(APP);
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * A file's code, with its comments taken out.
 *
 * Both of the checks below look for a JSX tag, and three files in this tree
 * discuss `<h1>` in prose — including the component that replaced them. A
 * comment that can satisfy an assertion is how the width guard came to pass
 * over a bar that had stopped using the shell, so the comments go first.
 */
function code(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * The attributes of every `<PageHeader …>` in a file, nested JSX excluded.
 *
 * The obvious `/<PageHeader\b([\s\S]*?)\/>/` stops at the *first* `/>` it
 * finds, which on five of these call sites is an `<EventSeats … />` inside the
 * `intro` — so every `className` on the markup passed *into* the header came
 * back as a `className` *on* it. This walks the element's own attribute list
 * instead, keeping only what sits at brace depth zero, and skipping quoted
 * strings so that a `>` inside one cannot end it early.
 */
function headerAttrs(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/<PageHeader\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let own = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
        else if (depth === 0) own += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
      else if (depth === 0) own += ch;
    }
    out.push(own);
  }
  return out;
}

/**
 * Routes whose header is rendered by a component they hand off to, and which.
 *
 * The same shape as `DELEGATES` in `page-width.test.ts`, and for the same
 * reason: these routes obey the rule, the `<PageHeader>` is one file further
 * in, and the difference between that and an exemption matters when you are
 * reading the list to find out what is not covered. Each pointer is followed —
 * the named component has to render the header, or this is a broken promise.
 *
 * All four are routes whose title, state and figures are all derived from data
 * the component already holds. Copying them up into the route file would be a
 * second place for them to disagree with what the page draws.
 */
const DELEGATES: Record<string, string> = {
  "src/app/championship/page.tsx": "src/components/championship/Season.tsx",
  "src/app/championship/[slug]/page.tsx": "src/components/championship/Season.tsx",
  "src/app/admin/events/[id]/page.tsx": "src/components/admin/events/EventEditor.tsx",
  "src/app/events/[slug]/draft/page.tsx": "src/app/events/[slug]/draft/DraftRoom.tsx",
};

/**
 * The two routes with no page shell at all, and so no page header either.
 *
 * Both are sign-in screens and both are the only routes on the site with no
 * `AppHeader` over them — there is no page column to line up with because there
 * is no page furniture at all. They are the same two `page-width.test.ts`
 * exempts from `Page`, deliberately: a route that has no `<main>` from the
 * shell has nothing for a header to sit at the top of.
 */
const NO_HEADER: Record<string, string> = {
  "src/app/signin/page.tsx":
    "Full-bleed split screen. Its heading is the wordmark at `text-hero`, drawn " +
    "twice behind complementary `lg:` breakpoints, which is a logotype rather " +
    "than a page title.",
  "src/app/dev-login/page.tsx":
    "A single centred card, sized to the short form on it, and reachable only " +
    "when DEV_LOGIN=1 in development.",
};

describe("every page's header", () => {
  const routes = routeFiles();

  it("finds every route, so an empty sweep cannot pass", () => {
    // Thirty routes at the time of writing, of which 28 take a header. A floor
    // rather than an equality, so adding a page is not a failure — but a
    // matcher that found nothing is.
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(NO_HEADER).length + Object.keys(DELEGATES).length).toBeLessThan(
      routes.length
    );

    for (const file of [...Object.keys(NO_HEADER), ...Object.keys(DELEGATES)]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is listed but missing`).toBe(true);
    }
  });

  it("has every delegate actually render PageHeader", () => {
    for (const [route, component] of Object.entries(DELEGATES)) {
      const full = path.join(ROOT, component);
      expect(fs.existsSync(full), `${route} delegates to ${component}, which is missing`).toBe(
        true
      );
      expect(code(full), component).toMatch(/<PageHeader\b/);
    }
  });

  it("renders PageHeader on every route that is not a named exception", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const rel = relative(file);
      const source = code(file);
      const wears = /<PageHeader\b/.test(source);

      if (rel in NO_HEADER) {
        if (wears) offenders.push(`${rel}: listed as having no header, but renders one`);
        continue;
      }
      if (rel in DELEGATES) {
        if (wears) {
          offenders.push(`${rel}: delegates its header, and renders one of its own as well`);
        }
        /*
         * The exemption is conditional on the delegation it claims. Without
         * this, the route could stop rendering the component and return a bare
         * `<div>` and still pass — exempt, no header — while the delegate test
         * above stayed green over an untouched file.
         *
         * The JSX tag, not the bare name: `source.includes("EventEditor")` is
         * satisfied by this route's own `EventEditorPage`.
         */
        const delegate = path.basename(DELEGATES[rel], ".tsx");
        if (!new RegExp(`<${delegate}\\b`).test(source)) {
          offenders.push(
            `${rel}: exempt because it delegates to ${delegate}, which it never renders`
          );
        }
        continue;
      }
      if (!wears) {
        offenders.push(
          `${rel}: renders no <PageHeader>. Use it, or add the route to DELEGATES or NO_HEADER.`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * One header means one heading. A page that still writes its own `<h1>` has
   * two of them the moment it also wears a `PageHeader` — which is both the
   * wrong outline for a screen reader and the exact state eleven of these
   * pages were in before the sweep, each with a different size on it.
   */
  it("leaves no route writing an <h1> of its own", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const rel = relative(file);
      if (rel in NO_HEADER) continue;
      const own = code(file).match(/<h1\b/g);
      if (own) offenders.push(`${rel}: ${own.length} hand-written <h1>`);
    }
    expect(offenders).toEqual([]);
  });

  it("hands no header a className at any call site", () => {
    const files = [...routes, ...new Set(Object.values(DELEGATES)).values()].map((f) =>
      path.isAbsolute(f) ? f : path.join(ROOT, f)
    );
    const found: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      for (const attrs of headerAttrs(code(file))) {
        found.push(relative(file));
        if (/\bclassName\s*=/.test(attrs)) offenders.push(`${relative(file)}: ${attrs.trim()}`);
      }
    }
    // The scanner has to be finding the call sites for its silence to mean
    // anything: 28 routes' worth, 24 of them in the route file itself.
    expect(found.length).toBeGreaterThanOrEqual(25);
    expect(offenders).toEqual([]);
  });
});

/* --------------------------------------------------------------------- */
/* The admin area says one thing about itself                            */
/* --------------------------------------------------------------------- */

/**
 * The admin section a route belongs to, found the way `AdminNav` lights a link:
 * longest matching `href`, with `/admin` itself matched exactly because it is a
 * prefix of every other one.
 *
 * `[id]` segments are dropped first, so `/admin/events/[id]` resolves to the
 * Events section — which is the link the bar lights while you are on it.
 */
function sectionFor(route: string): { href: string; label: string } | undefined {
  const url = route.replace(/^src\/app/, "").replace(/\/page\.tsx$/, "") || "/";
  const path_ = url.replace(/\/\[[^\]]+\]/g, "");
  return [...ADMIN_SECTIONS]
    .filter((s) => (s.href === "/admin" ? path_ === "/admin" : path_.startsWith(s.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

describe("the admin area's section label", () => {
  const adminRoutes = routeFiles()
    .map(relative)
    .filter((rel) => rel.startsWith("src/app/admin/"));

  it("finds the admin routes", () => {
    // Twelve at the time of writing. A floor, so the sweep cannot pass empty.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(12);
  });

  /*
   * Task 30: "admin pages all use AdminNav with the same section label."
   *
   * Two routes did not draw the bar at all — `/admin/availability` and
   * `/admin/host`, which are exactly the two pages UC-07 1 and UC-21 1 tell an
   * admin to open — so from either of them the rest of the admin area was
   * reachable only through the account menu.
   */
  it("draws AdminNav on every admin page", () => {
    const offenders: string[] = [];
    for (const rel of adminRoutes) {
      if (!/<AdminNav\b/.test(code(path.join(ROOT, rel)))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  /*
   * And the eyebrow says what the bar says. It did not: the Games page called
   * itself "Admin · Profiles", Championships called itself "Admin ·
   * Championships" against a link labelled "Seasons", and the host queue was
   * "Admin · Hosting" against "Hosts" — so the line telling you where you are
   * disagreed with the lit link telling you the same thing.
   */
  it("names the section the same way the bar does", () => {
    const offenders: string[] = [];
    for (const rel of adminRoutes) {
      const section = sectionFor(rel);
      expect(section, `${rel} is under /admin but matches no ADMIN_SECTIONS href`).toBeDefined();

      const file = rel in DELEGATES ? DELEGATES[rel] : rel;
      const eyebrows = [...code(path.join(ROOT, file)).matchAll(/\beyebrow="([^"]*)"/g)].map(
        (m) => m[1]
      );
      const want = `Admin · ${section!.label}`;

      if (eyebrows.length !== 1) {
        offenders.push(`${file}: ${eyebrows.length} literal eyebrow= values, expected 1`);
      } else if (eyebrows[0] !== want) {
        offenders.push(`${file}: eyebrow is "${eyebrows[0]}", the bar says "${want}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
