import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostApplication } from "@/lib/hosting";

/*
 * The queue an admin decides from (UC-21 1 to 3a).
 *
 * The component is rendered rather than reasoned about, because the thing worth
 * pinning is what the screen offers: the three steps of the use case as three
 * controls, in order, with the event chosen and not assumed. The two modules it
 * cannot have here are mocked — the router (there is no Next request) and the
 * actions (`"use server"`, and nothing is clicked in a static render).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/admin/host/actions", () => ({
  approveHostApplicationAction: async () => ({ ok: true, data: { eventId: "" } }),
  createEventFromApplicationAction: async () => ({ ok: true, data: {} }),
  declineHostApplicationAction: async () => ({ ok: true, data: null }),
}));

const { default: HostQueue, NO_EVENT_CHOSEN, NO_REASON_GIVEN } = await import("../HostQueue");

const WAITING: HostApplication = {
  id: "application-1",
  status: "pending",
  title: "Friday REPO night",
  gameName: "REPO",
  gameId: null,
  summary: "Six of us, a few rounds, prizes for whoever survives longest.",
  format: null,
  expectedPlayers: 12,
  proposedWhen: null,
  playerInfoNeeded: "In-game name\nDo you own the DLC?",
  decisionNote: null,
  decidedAt: null,
  eventId: null,
  eventSlug: null,
  createdAt: new Date("2026-03-01T18:00:00Z"),
  by: { id: "member-1", name: "Ada", handle: "ada" },
};

function render(
  applications: HostApplication[],
  events: Array<{ id: string; title: string; status: string }> = []
): string {
  return renderToStaticMarkup(createElement(HostQueue, { applications, events }));
}

describe("the card for an application nobody has decided", () => {
  it("offers the event first — built from the application, not from a blank form", () => {
    // UC-21 2. The button is the step, and the two things it prefills are the
    // two the form made required.
    const markup = render([WAITING]);

    expect(markup).toContain("Create event from this application");
    expect(markup).toContain("In-game name");
    expect(markup).toContain("Do you own the DLC?");
  });

  it("makes the admin choose which event the approval links", () => {
    // UC-21 3: "Admin approves, linking that event". Nothing is preselected —
    // an approval that silently invented an event would be a second empty one.
    const markup = render([WAITING], [
      { id: "event-1", title: "Friday REPO night", status: "draft" },
      { id: "event-2", title: "Rivals ladder", status: "published" },
    ]);

    expect(markup).toContain("Friday REPO night · draft");
    expect(markup).toContain("Rivals ladder · published");
    // The empty prompt is what is selected, and no event is.
    expect(markup).toContain('<option value="" selected="">Choose the event…</option>');
    expect(markup).not.toMatch(/<option value="event-\d" selected/);
  });

  it("says a decline needs a reason before anything is sent (UC-21 3a)", () => {
    const markup = render([WAITING]);

    expect(markup).toContain("Required to decline");
    expect(NO_REASON_GIVEN).toMatch(/reason/);
    expect(NO_EVENT_CHOSEN).toMatch(/Create the event/);
  });

  it("shows what the admin judges it on — the players and the summary", () => {
    // R-167, R-168 / UC-20 E1, from the other end: they are kept because this
    // is the screen they were for.
    const markup = render([WAITING]);

    expect(markup).toContain("12 players");
    expect(markup).toContain("Six of us, a few rounds");
  });
});

describe("the queue with nothing waiting", () => {
  it("says where applications come from rather than showing an empty card", () => {
    expect(render([])).toContain("/host");
  });
});
