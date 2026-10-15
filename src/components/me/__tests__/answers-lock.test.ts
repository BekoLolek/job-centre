import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MyEventRow } from "../MyEventCard";
import { offersWithdraw, readable } from "./card-text";

/*
 * The answers section of a member's own event card (R-53 / UC-13 3, 4a).
 *
 * The server's half is pinned in `src/lib/__tests__/events.test.ts`:
 * `editApplicationAnswers` refuses a late edit whatever any screen renders, and
 * `withdrawApplication` accepts one whatever any screen renders. What is left
 * is this card's own rule — whether to *offer* the edit — and it is worth its
 * own file for the same reason `attendance-lock.test.ts` is, with one extra
 * reason on top.
 *
 * This card now holds **three** deadlines, and only two of them close:
 *
 *  - `confirmationsOpen` — the attendance answer, two days before the start
 *    (R-200, UC-13 7);
 *  - `answersEditable` — the answers, when sign-ups close (UC-13 4a);
 *  - **withdrawing, which closes on neither of them** (R-54, UC-13 4a,
 *    UC-13 extensions E3).
 *
 * Three booleans where there used to be two is three times the temptation to
 * tidy them into one, and the tidy version passes every pure test in the suite
 * while quietly closing the way out. So each one is asserted against the others
 * here: with sign-ups shut, Withdraw stays; with the attendance answer shut,
 * Withdraw stays; with both shut, Withdraw stays.
 *
 * `useRouter` and the action module are mocked for the reason
 * `attendance-lock.test.ts` mocks them: importing the actions would drag the
 * database and the session into a node test that only wants to render markup.
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

/** The whole rendered markup, for assertions about where a link points. */
function markup(row: MyEventRow): string {
  return renderToStaticMarkup(createElement(MyEventCard, { row }));
}

/** The rendered card as a reader sees it: no tags, no HTML entities. */
function text(row: MyEventRow): string {
  return readable(markup(row));
}

/** Is the withdraw control on the card? Shared with `attendance-lock`. */
function offers(row: MyEventRow): boolean {
  return offersWithdraw(markup(row));
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
    answersEditable: true,
    outstanding: 0,
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

describe("while sign-ups are open", () => {
  it("offers a way to change the answers, pointing at the form", () => {
    // UC-13 3. The apply page is the form — one set of questions, one set of
    // rules about them — so the card links to it rather than growing a second.
    const rendered = text(row());
    expect(rendered).toContain("Change my answers");
    expect(markup(row())).toContain('href="/events/spring-lan/apply"');
  });

  it("says a change costs them nothing", () => {
    // The promise the write actually keeps: no seat moves, no queue place
    // moves, `submittedAt` does not move.
    const rendered = text(row());
    expect(rendered).toContain("does not move your seat");
    expect(rendered).toContain("until sign-ups close");
  });

  it("asks for an answer the application is still missing", () => {
    // UC-13 2's to-do, on the card that can act on it.
    const rendered = text(row({ outstanding: 2 }));
    expect(rendered).toContain("2 answers needed");
    expect(rendered).toContain("Answer them");
  });

  it("says nothing about missing answers when there are none", () => {
    expect(text(row())).not.toContain("answers needed");
  });
});

describe("once sign-ups have closed", () => {
  const shut = { answersEditable: false } as const;

  it("stops offering the edit", () => {
    const rendered = text(row(shut));
    expect(rendered).not.toContain("Change my answers");
    expect(rendered).not.toContain("Answer them");
  });

  it("says the answers stand, rather than leaving a dead button", () => {
    const rendered = text(row(shut));
    expect(rendered).toContain("your answers stand");
    expect(rendered).toContain("running order");
  });

  it("still offers Withdraw, which sign-ups closing does not govern", () => {
    // The assertion this file exists for (R-54, UC-13 4a / E3). Asserted with
    // the answers shut, with the attendance answer shut, and with both — the
    // bug would be a change that closed the way out along with either.
    expect(offers(row(shut))).toBe(true);
    expect(offers(row({ confirmationsOpen: false }))).toBe(true);
    expect(offers(row({ ...shut, confirmationsOpen: false }))).toBe(true);
    // And it is there while everything is open, so the three above are not
    // passing because the control is simply never rendered.
    expect(offers(row())).toBe(true);
  });

  it("offers it from the queue and from an approval event's list too", () => {
    // Each status has its own sentence about what leaving costs, so each is
    // its own chance for the way out to be closed by accident.
    expect(offers(row({ ...shut, status: "waitlisted", waitlistPosition: 2 }))).toBe(true);
    expect(offers(row({ ...shut, status: "pending" }))).toBe(true);
  });

  it("points a member who can no longer make it at withdrawing", () => {
    expect(text(row(shut))).toContain("Withdrawing still works");
  });
});

describe("an application that is not open", () => {
  it("offers nothing to change", () => {
    // Nothing to edit on an application that has left: `editApplicationAnswers`
    // refuses a withdrawn or declined one, so offering the form would be
    // offering a button that cannot work.
    for (const status of ["withdrawn", "declined"] as const) {
      const rendered = text(row({ status }));
      expect(rendered).not.toContain("Change my answers");
      expect(rendered).not.toContain("your answers stand");
    }
  });

  it("offers nothing on an event that has been and gone", () => {
    expect(text(row({ past: true }))).not.toContain("Change my answers");
  });
});
