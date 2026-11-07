import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DRAFT_CONFIG } from "@/lib/draft-policy";
import { eventShapeFrom, rosterSizingFrom, teamFormatFrom } from "@/lib/events-policy";
import type { DraftTabData } from "../types";

/*
 * The Draft tab's "who can watch" control (R-253 / UC-50 1, 1a).
 *
 * Two things are asserted about it, because each is a drift the rest of the
 * tab invites:
 *
 *  - **It is not under the rules lock.** Every other control on this tab is
 *    disabled once `started` is true (UC-16 1a). The flag is deliberately not
 *    a rule — an admin watching an auction go badly has to be able to close
 *    the doors mid-draft — so the two chips stay enabled while the lock alert
 *    is up. The mutation this guards against is somebody passing
 *    `disabled={rulesLocked}` to it like its neighbours.
 *  - **It says what it does**, naming what goes dark and what stays public,
 *    so the admin is not left to find out from a captain.
 *
 * 1a — "the control is not offered on an event with no draft" — is the Draft
 * tab's own rule (`tabHiddenBecause`), proved in `shape-tabs.test.ts`; a
 * control on a tab the event does not have is not offered.
 *
 * Mocked as `draft-tab-readout.test.ts` mocks, for its reason.
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

const SIZING = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 6 } },
  }),
  0
);

function tabData(over: Partial<DraftTabData> = {}): DraftTabData {
  return {
    teams: [],
    config: DEFAULT_DRAFT_CONFIG,
    sizing: SIZING,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: {},
    started: false,
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
    privateDraft: false,
    ...over,
  };
}

function markup(over: Partial<DraftTabData> = {}): string {
  return renderToStaticMarkup(
    createElement(DraftTab, { eventId: "event-1", applicants: [], data: tabData(over) })
  );
}

function text(over: Partial<DraftTabData> = {}): string {
  return markup(over)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rarr;|&#x2192;/g, "→")
    .replace(/&mdash;|&#x2014;/g, "—")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** Every `<button>` in a stretch of markup, as `[attributes, label]`. */
function buttons(html: string): Array<{ attributes: string; label: string }> {
  return [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)].map((match) => ({
    attributes: match[1],
    label: match[2].replace(/<[^>]*>/g, "").trim(),
  }));
}

/**
 * The watching section alone — from its heading to the Money heading that
 * follows it. Scoped because "Everyone" is also a bid-visibility chip further
 * down the tab, and a sweep over the whole markup would count that one.
 */
function watching(html: string): string {
  const start = html.indexOf("Who can watch the draft");
  const end = html.indexOf(">Money<", start);
  if (start < 0 || end < 0) throw new Error("the watching section is not on the tab");
  return html.slice(start, end);
}

const EVERYONE = "Everyone";
const CAPTAINS = "Captains and managers only";

/**
 * The `disabled` *attribute*, as React renders it (`disabled=""`) — not the
 * word, which every chip carries in its class list (`disabled:opacity-35`).
 * A `toContain("disabled")` here passes on an enabled chip.
 */
const DISABLED = /\sdisabled(=""|\s|$)/;

describe("the Draft tab's who-can-watch control", () => {
  it("offers the two answers, with the draft public by default", () => {
    const chips = buttons(watching(markup()));
    expect(chips.map((chip) => chip.label)).toEqual([CAPTAINS, EVERYONE]);
    expect(chips.find((chip) => chip.label === EVERYONE)?.attributes).toContain('aria-pressed="true"');
    expect(chips.find((chip) => chip.label === CAPTAINS)?.attributes).toContain('aria-pressed="false"');
  });

  it("shows the stored answer when the draft is private", () => {
    const chips = buttons(watching(markup({ privateDraft: true })));
    expect(chips.find((chip) => chip.label === CAPTAINS)?.attributes).toContain('aria-pressed="true"');
    expect(chips.find((chip) => chip.label === EVERYONE)?.attributes).toContain('aria-pressed="false"');
  });

  it("says what goes dark and what stays public", () => {
    const rendered = text({ privateDraft: true });
    expect(rendered).toContain("Who can watch the draft");
    expect(rendered).toContain("captains");
    expect(rendered).toMatch(/teams and their rosters stay/i);
    expect(rendered).toMatch(/not posted/i);
  });

  it("stays enabled once the draft has started — the flag is not a rule the lock covers", () => {
    const html = markup({ started: true });
    const rendered = text({ started: true });

    expect(rendered).toContain("This draft has started, so its rules are fixed");
    // A neighbouring rule chip *is* locked, so an unlocked sweep cannot pass vacuously.
    const sealed = buttons(html).find((button) => button.label === "Sealed");
    expect(sealed?.attributes).toMatch(DISABLED);

    const chips = buttons(watching(html));
    expect(chips.map((chip) => chip.label)).toEqual([CAPTAINS, EVERYONE]);
    for (const chip of chips) expect(chip.attributes).not.toMatch(DISABLED);
  });
});
