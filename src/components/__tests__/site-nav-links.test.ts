import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The championship item in the top bar (UC-34 1, 1a / R-194).
 *
 * `currentSeason` returning null is pinned at the library boundary in
 * `src/lib/__tests__/championship-season.test.ts`, and that is a different
 * question from this one: with no season published there must be *no item*, and
 * nothing was holding the row to it. A link to `/championship` while nothing is
 * published is a promise to a 404 — and worse on a hidden season, where the
 * shape of the bar would be how a visitor learns an unpublished season exists
 * (R-189).
 *
 * The separator goes with it, which is the other half of R-194: the hairline is
 * there to set the item apart from the four, and a rule with nothing after it
 * is a rule pointing at a gap.
 *
 * Rendered rather than reasoned about, because the whole of the rule is one
 * `&&` in the markup. `usePathname` is the only thing standing between this
 * component and a plain function, so it is the only thing mocked.
 */

const state = vi.hoisted(() => ({ pathname: "/events" }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

const { default: SiteNavLinks } = await import("../SiteNavLinks");

afterEach(() => {
  state.pathname = "/events";
});

/** The bar as a reader gets it, on whichever page they are on. */
function render(championship: boolean): string {
  return renderToStaticMarkup(createElement(SiteNavLinks, { championship }));
}

describe("the championship item in the top bar", () => {
  it("is there while a season is published", () => {
    const markup = render(true);

    expect(markup).toContain("/championship");
    expect(markup).toContain("Championship");
  });

  it("is gone entirely when no season is published", () => {
    const markup = render(false);

    expect(markup).not.toContain("/championship");
    expect(markup).not.toContain("Championship");
    // The four that are always there, so this is "the one item went" rather
    // than "the nav failed to render".
    for (const href of ["/events", "/archive", "/suggestions", "/polls"]) {
      expect(markup).toContain(href);
    }
  });

  it("takes its separator with it, leaving no rule pointing at a gap", () => {
    // The hairline exists to set the item apart from the other four (R-194),
    // so it is part of the item rather than part of the row.
    const rules = (markup: string) => markup.split("bg-hair").length - 1;

    expect(rules(render(true))).toBe(1);
    expect(rules(render(false))).toBe(0);
  });

  it("stands the whole row down under /admin, season or no season", () => {
    state.pathname = "/admin/championships";

    expect(render(true)).toBe("");
    expect(render(false)).toBe("");
  });
});
