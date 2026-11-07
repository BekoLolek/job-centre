import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSIZED_ROSTER_NOTE } from "@/components/draft/TeamCard";
import { DEFAULT_DRAFT_CONFIG } from "@/lib/draft-policy";
import { type RosterSizing, eventShapeFrom, rosterSizingFrom, teamFormatFrom } from "@/lib/events-policy";
import { applicant, applicantDay, applicantsEvent } from "./applicants-fixture";
import type { DraftTabData } from "../types";

/*
 * What the Captains tab says a captain leaves to draft (R-248 / UC-49 4).
 *
 * The panel's sentence is built around "each team drafts N−1 more players",
 * and §14's rule — a captain fills a roster slot — is what makes the figure
 * one less than the places. That sentence has an N only when the Format panel
 * stated one. Under a count of teams the per-team figure is a cap, so "N−1
 * more" is at most that; and with no figure at all there is no N, where the
 * tab used to read "With a roster target of 0, each team drafts 0 more
 * players" — a sentence that is arithmetic over null, not a fact about the
 * event.
 *
 * The teams list is empty on purpose: a `TeamCard` prints the shared sentence
 * for the third state on its own, and a test that found those words on the
 * page could not tell the panel's sentence from the card's.
 *
 * The router and the action modules are mocked for the reason
 * `applicant-eligibility.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/draft-actions", () => ({
  saveCaptainsAction: vi.fn(),
}));

vi.mock("@/app/admin/events/waiver-actions", () => ({
  waiveEntryRuleAction: vi.fn(),
}));

const { default: CaptainsTab } = await import("../CaptainsTab");

/** The three states, through the real reader — see `draft-tab-readout.test.ts`. */
function stated(places: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({
      eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: places } },
    }),
    0
  );
}
function counted(teams: number, accepted: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({
      eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: teams } },
    }),
    accepted
  );
}

function tabData(sizing: RosterSizing): DraftTabData {
  return {
    teams: [],
    config: DEFAULT_DRAFT_CONFIG,
    sizing,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: {},
    started: false,
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
  };
}

/**
 * The tab as an admin reads it: no tags, no entities, and no gap between a
 * highlighted figure and the punctuation after it — the numbers sit in their
 * own spans, and stripping the tags would otherwise leave "6 ," behind.
 */
function text(sizing: RosterSizing): string {
  return renderToStaticMarkup(
    createElement(CaptainsTab, {
      eventId: "event-1",
      event: applicantsEvent([applicantDay()]),
      applicants: [applicant({ rank: "Diamond I" })],
      data: tabData(sizing),
    })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rarr;|&#x2192;/g, "→")
    .replace(/&mdash;|&#x2014;/g, "—")
    .replace(/&nbsp;|\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

describe("what a captain leaves to draft", () => {
  it("counts down from a stated target", () => {
    expect(text(stated(6))).toContain(
      "With a roster target of 6, each team drafts 5 more players."
    );
  });

  it("says 'player', singular, when the target leaves one", () => {
    expect(text(stated(2))).toContain(
      "With a roster target of 2, each team drafts 1 more player."
    );
  });

  it("says 'up to' under a cap, where there is no target to count down from", () => {
    const sizing = counted(4, 18);
    expect(sizing).toEqual({ target: null, cap: 5 });

    const rendered = text(sizing);

    expect(rendered).toContain("With up to 5 on a team, each team drafts up to 4 more players.");
    expect(rendered).not.toContain("roster target");
  });

  it("says the panel has no figure, in the shared words, rather than a roster target of 0", () => {
    const sizing = counted(4, 1);
    expect(sizing).toEqual({ target: null, cap: null });

    const rendered = text(sizing);

    expect(rendered).toContain(`never enter the draft pool. ${UNSIZED_ROSTER_NOTE}`);
    expect(rendered).not.toContain("roster target of 0");
    expect(rendered).not.toContain("drafts 0 more");
  });
});
