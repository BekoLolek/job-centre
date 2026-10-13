import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MyEventRow } from "../MyEventCard";

/*
 * The attendance section of a member's own event card (UC-13 5-8).
 *
 * What the server decides is pinned in `src/lib/__tests__/events.test.ts`:
 * `setConfirmation` refuses a late answer whatever any screen renders. What is
 * left is this card's own rule — whether to *offer* an answer — and it is worth
 * a test of its own, because the failure it guards against is silent. A card
 * that keeps the three chips up after the deadline looks fine, saves nothing,
 * and tells the member "could not reach the server" is a lie about why.
 *
 * The other half is the one that would be a real bug: **Withdraw must survive
 * the lock.** R-54 is not an answer and UC-13 extensions E3 keeps it open, and
 * the reason closing the answer is acceptable at all is that somebody taken ill
 * the day before can still give their seat up. A refactor that folded the
 * deadline into `editable` would close both at once and pass every pure test
 * in the suite.
 *
 * `useRouter` and the action module are mocked for the reason `poll-list.test.ts`
 * mocks them: importing the actions would drag the database and the session
 * into a node test that only wants to render markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

vi.mock("@/app/me/events/actions", () => ({
  setMyAvailabilityAction: vi.fn(),
  setMyConfirmationAction: vi.fn(),
  withdrawFromEventAction: vi.fn(),
}));

const { default: MyEventCard } = await import("../MyEventCard");

/** The rendered card as a reader sees it: no tags, no HTML entities. */
function text(row: MyEventRow): string {
  return renderToStaticMarkup(createElement(MyEventCard, { row }))
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ");
}

function row(over: Partial<MyEventRow> = {}): MyEventRow {
  return {
    applicationId: "application-1",
    eventId: "event-1",
    slug: "spring-lan",
    title: "Spring LAN",
    type: "tournament",
    eventStatus: "published",
    startsAt: "2026-05-20T17:00:00.000Z",
    endsAt: null,
    status: "accepted",
    waitlistPosition: null,
    seats: {
      capacity: 8,
      accepted: 4,
      waitlisted: 0,
      seatsLeft: 4,
      full: false,
      overCapacity: false,
    },
    days: [],
    availability: {},
    confirmation: null,
    confirmationClosesAt: "2026-05-18T17:00:00.000Z",
    confirmationsOpen: true,
    past: false,
    action: {
      kind: "accepted",
      label: "You're in",
      href: "/events/spring-lan",
      detail: "You hold a seat.",
      tone: "success",
      primary: false,
    },
    ...over,
  };
}

const ANSWERS = ["I'll be there", "Not sure yet", "I can't make it"];

describe("before the answer closes", () => {
  it("offers all three answers", () => {
    const rendered = text(row());
    for (const answer of ANSWERS) expect(rendered).toContain(answer);
  });

  it("says when the answer closes, and that withdrawing outlives it", () => {
    const rendered = text(row());
    expect(rendered).toContain("You can change this until");
    expect(rendered).toContain("two days before the start");
    expect(rendered).toContain("you can still withdraw");
  });

  it("promises that the unsure answer keeps the seat", () => {
    // R-199's whole bargain. A member who thinks "not sure" might cost them
    // their seat will not use it, and then the organisers are back to guessing
    // from silence.
    expect(text(row())).toContain('"Not sure yet" keeps it');
  });

  it("claims no deadline for an event with no start date", () => {
    // UC-13 7a: nothing closes, so there is nothing to warn about — and
    // certainly no "closes" sentence with a blank date in it.
    const rendered = text(row({ startsAt: null, confirmationClosesAt: null }));
    for (const answer of ANSWERS) expect(rendered).toContain(answer);
    expect(rendered).not.toContain("You can change this until");
  });
});

describe("after the answer closes", () => {
  const shut = { confirmationsOpen: false } as const;

  it("stops offering the three answers", () => {
    const rendered = text(row({ ...shut, confirmation: "in" }));
    for (const answer of ANSWERS) expect(rendered).not.toContain(answer);
  });

  it("reads the member's last answer back to them", () => {
    expect(text(row({ ...shut, confirmation: "in" }))).toContain("You said you'll be there");
    expect(text(row({ ...shut, confirmation: "maybe" }))).toContain("You said you are not sure");
    expect(text(row({ ...shut, confirmation: "out" }))).toContain("You said you cannot make it");
  });

  it("says so, rather than leaving a silent member wondering", () => {
    const rendered = text(row({ ...shut, confirmation: null }));
    expect(rendered).toContain("You did not answer");
    expect(rendered).toContain("Your seat is still yours");
  });

  it("still offers Withdraw, which the deadline does not govern", () => {
    // The assertion this file exists for. Both sides of the lock, because the
    // bug would be a change that closed the way out along with the answer.
    expect(text(row({ ...shut, confirmation: "in" }))).toContain("Withdraw");
    expect(text(row({ ...shut, confirmation: null }))).toContain("Withdraw");
    expect(text(row())).toContain("Withdraw");
  });

  it("points a member who can no longer make it at withdrawing", () => {
    expect(text(row({ ...shut, confirmation: "in" }))).toContain("withdraw below");
  });
});
