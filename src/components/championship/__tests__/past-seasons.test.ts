import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FinishedSeason } from "@/lib/championship-season";
import PastSeasons, { noPastSeasonsText } from "../PastSeasons";

/*
 * The "Past seasons" empty state (UC-35 4).
 *
 * The list handed to `PastSeasons` never contains the season you are reading —
 * both championship routes filter it out — so an empty list is not the same
 * statement on every page. On a running season's page it means nothing has
 * ever finished; on a finished one's it means nothing *else* has, and the old
 * copy said the first thing on both, contradicted by the finished season
 * printed above it.
 *
 * The sentence is what the reader is told, so the sentence is what is pinned —
 * and the last test renders the component, because which of the two sentences
 * comes out is the half of this the pure ones cannot see. With only those,
 * inverting the one line in `PastSeasons` that chooses the branch puts the bug
 * back exactly as it was and the file stays green.
 */

describe("the past seasons empty state", () => {
  it("says no season has finished while the one being read has not", () => {
    expect(noPastSeasonsText(false)).toMatch(/^No season has finished yet\./);
  });

  it("says no *other* season has finished on a finished season's own page", () => {
    const text = noPastSeasonsText(true);

    expect(text).toMatch(/^No other season has finished yet\./);
    // The bug, stated as the thing that must not come back: on a closed
    // season's page the flat claim is false, and the page disproves it.
    expect(text).not.toMatch(/^No season has finished/);
  });

  it("promises the same thing either way — a finished season stays here for good", () => {
    for (const thisOneFinished of [false, true]) {
      expect(noPastSeasonsText(thisOneFinished)).toMatch(
        /standings and its winner, for good\.$/
      );
    }
  });
});

describe("the section a finished season's own page prints", () => {
  /** What the reader actually gets, markup and all. */
  function render(seasons: FinishedSeason[], thisOneFinished: boolean): string {
    return renderToStaticMarkup(
      createElement(PastSeasons, { seasons, thisOneFinished })
    );
  }

  it("says no *other* season has finished, on a page that is itself one", () => {
    // The component, not the sentence: the sentences above are both correct
    // whichever way round the component hands them out, and handing them out
    // the wrong way round is the bug this section was written for.
    expect(render([], true)).toContain("No other season has finished");
  });

  it("says no season has finished at all, while the one being read is running", () => {
    const markup = render([], false);

    expect(markup).toContain("No season has finished yet");
    expect(markup).not.toContain("No other season");
  });
});
