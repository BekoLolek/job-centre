import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSIZED_ROSTER_NOTE } from "@/components/draft/TeamCard";
import { DEFAULT_DRAFT_CONFIG } from "@/lib/draft-policy";
import { type RosterSizing, eventShapeFrom, rosterSizingFrom, teamFormatFrom } from "@/lib/events-policy";
import type { DraftTabData } from "../types";

/*
 * The Draft tab's places-on-a-team readout (R-248 / UC-49 4, 4a).
 *
 * The figure used to be a draft rule with a box of its own on this tab, and
 * `draft_configs.roster_target` defaulting to six is how the player view came
 * to show six places on a team the Format panel had sized at three. Task 106
 * stopped the tab saving it but left the box — a disabled stepper with a
 * change handler that did nothing — and said naming where the figure is set
 * was this task's. So two things are asserted: that there is **no input** for
 * the figure in any of the panel's three states, and that the readout says
 * where it is set.
 *
 * "No input" is checked against the `aria-label`s of every `<input>` in the
 * markup rather than against a word in the text, because the mutation this
 * guards against is somebody putting the stepper back: a stepper carries its
 * label on the input, and a text search for "Places on a team" passes whether
 * the words are over a figure or over a box.
 *
 * The router and the action module are mocked for the reason
 * `teams-tab-placement.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/draft-actions", () => ({
  movePoolPlayerAction: vi.fn(),
  saveDraftConfigAction: vi.fn(),
  saveDraftPrivacyAction: vi.fn(),
  seedDraftPoolAction: vi.fn(),
}));

const { default: DraftTab } = await import("../DraftTab");

/**
 * The three states, through the real reader over a stored shape rather than
 * literals, for `rosterSizingFrom`'s reason: a hand-built sizing is the first
 * place target and cap could disagree.
 */
const STATED: RosterSizing = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 6 } },
  }),
  0
);
/** Eighteen into four is 5, 5, 4, 4: a cap of five, no target. */
const CAPPED: RosterSizing = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 4 } },
  }),
  18
);
/** One person into four sides is a deal the planner refuses: no figure. */
const UNSIZED: RosterSizing = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 4 } },
  }),
  1
);

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
    privateDraft: false,
  };
}

function markup(sizing: RosterSizing): string {
  return renderToStaticMarkup(
    createElement(DraftTab, { eventId: "event-1", applicants: [], data: tabData(sizing) })
  );
}

/** The tab as an admin reads it: no tags, no entities. */
function text(sizing: RosterSizing): string {
  return markup(sizing)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rarr;|&#x2192;/g, "→")
    .replace(/&mdash;|&#x2014;/g, "—")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** What every `<input>` on the tab is labelled. */
function inputLabels(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*\baria-label="([^"]*)"/g)].map((match) => match[1]);
}

describe("the Draft tab's places-on-a-team readout", () => {
  it.each([
    ["a stated target", STATED],
    ["a cap with no target", CAPPED],
    ["no figure at all", UNSIZED],
  ])("offers no box for the figure under %s", (_state, sizing) => {
    const labels = inputLabels(markup(sizing));

    // The boxes that *are* rules are still there, so an empty sweep cannot pass.
    expect(labels).toContain("Minimum bid");
    expect(labels).not.toContain("Roster target");
    expect(labels).not.toContain("Places on a team");
    expect(labels.some((label) => /roster|places/i.test(label))).toBe(false);
  });

  it("prints a stated target as the figure, says what each team drafts, and names Setup → Format", () => {
    const rendered = text(STATED);

    expect(rendered).toContain("Places on a team 6");
    expect(rendered).toContain("Including the captain (§14), so each team drafts 5 more.");
    expect(rendered).toContain("Set in Setup → Format, not here.");
  });

  it("prints a cap as the most a roster holds, and names Setup → Format", () => {
    const rendered = text(CAPPED);

    expect(rendered).toContain("Places on a team up to 5");
    expect(rendered).toContain(
      "The most a roster holds, captain included (§14): Setup → Format sizes this event by a count of teams, so the sides come out uneven."
    );
    expect(rendered).toContain("Change the sizing there.");
    expect(rendered).not.toContain("drafts 4 more");
  });

  it("says the panel has no figure, in the words every roster surface uses, rather than a zero", () => {
    const rendered = text(UNSIZED);

    expect(rendered).toContain(`Places on a team ${UNSIZED_ROSTER_NOTE}`);
    expect(rendered).not.toContain("drafts 0 more");
    expect(rendered).not.toContain("Places on a team 0");
  });

  it("is still a readout while a draft is running — the places are not a rule the lock covers (UC-49 4a)", () => {
    /*
     * `started` locks every draft rule on the tab (UC-16 1a). The places on a
     * team are not one of those rules any more — they are not stored as one —
     * so the lock has nothing to say about them: no box appears, and the
     * readout neither vanishes into the lock alert nor changes its words.
     * Holds by construction today because `RosterReadout` never reads
     * `started`; asserted so that folding it into the `rulesLocked` block
     * later is a failure rather than a drift.
     */
    const data = { ...tabData(STATED), started: true };
    const html = renderToStaticMarkup(
      createElement(DraftTab, { eventId: "event-1", applicants: [], data })
    );
    const rendered = html
      .replace(/<[^>]*>/g, " ")
      .replace(/&rarr;|&#x2192;/g, "→")
      .replace(/&nbsp;|\s+/g, " ");

    expect(rendered).toContain("This draft has started, so its rules are fixed");
    expect(inputLabels(html).some((label) => /roster|places/i.test(label))).toBe(false);
    expect(rendered).toContain("Places on a team 6");
    expect(rendered).toContain("Set in Setup → Format, not here.");
  });

  it("points the short-pool warning at Setup → Format rather than at a control this tab no longer has", () => {
    // Two teams of one captain each against a cap of six is ten slots and an
    // empty pool, which is the warning's trigger.
    const data = tabData(STATED);
    data.teams = ["a", "b"].map((id) => ({
      id,
      name: `Team ${id}`,
      seed: null,
      captainUserId: `cap-${id}`,
      balanceStart: 1000,
      balance: 1000,
      members: [{ teamId: id, userId: `cap-${id}`, price: 0, isCaptain: true }],
      roster: {
        size: 1,
        captainCount: 1,
        target: 6,
        cap: 6,
        slotsLeft: 5,
        full: false,
        overfilled: false,
        minPerSlot: 0,
        reserved: 0,
      },
    }));

    const rendered = renderToStaticMarkup(
      createElement(DraftTab, { eventId: "event-1", applicants: [], data })
    )
      .replace(/<[^>]*>/g, " ")
      .replace(/&rarr;|&#x2192;/g, "→")
      .replace(/&nbsp;|\s+/g, " ");

    expect(rendered).toContain("There are 10 slots to fill");
    expect(rendered).not.toContain("lower the roster target");
    expect(rendered).toContain("lower the places on a team in Setup → Format");
  });
});
