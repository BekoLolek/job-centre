import { describe, expect, it } from "vitest";
import { applicationsOpen, eligibility } from "@/lib/events-policy";
import { formatSummary } from "../labels";
import { untilText } from "../Countdown";
import { viewerAction } from "../viewer";

/**
 * The call to action is the one thing on the public side that four different
 * pages render from four different sets of facts, so it is the one thing worth
 * pinning down: a member who is already in must never be shown Apply, and a
 * closed event must never show a button that cannot work.
 *
 * The `ApplicationsState` inputs are built by `applicationsOpen()` rather than
 * hand-written, so a change to the policy shows up here as a failure rather
 * than as a fixture that quietly stops resembling reality.
 */

const LADDER = ["Gold I", "Platinum III", "Platinum II", "Diamond III"];

const NOW = new Date("2026-09-01T12:00:00.000Z");

function openState(seats = { accepted: 0 }, capacity: number | null = 8) {
  return applicationsOpen(
    {
      status: "published",
      signupOpensAt: null,
      signupClosesAt: new Date("2026-09-20T12:00:00.000Z"),
      startsAt: new Date("2026-09-25T12:00:00.000Z"),
      capacity,
      config: {},
    },
    NOW,
    seats
  );
}

function closedState() {
  return applicationsOpen(
    {
      status: "published",
      signupOpensAt: null,
      signupClosesAt: new Date("2026-08-01T12:00:00.000Z"),
      startsAt: new Date("2026-09-25T12:00:00.000Z"),
      capacity: 8,
      config: {},
    },
    NOW
  );
}

describe("viewerAction", () => {
  it("invites a signed-out visitor to sign in rather than showing a dead button", () => {
    const action = viewerAction({ slug: "cup", signedIn: false, state: openState() });
    expect(action.kind).toBe("signin");
    expect(action.href).toBe("/signin");
    expect(action.primary).toBe(true);
  });

  it("offers Apply while there are seats", () => {
    const action = viewerAction({ slug: "cup", signedIn: true, state: openState() });
    expect(action.kind).toBe("apply");
    expect(action.href).toBe("/events/cup/apply");
  });

  it("says the waitlist out loud when the seats are gone", () => {
    const state = openState({ accepted: 8 });
    expect(state.open && state.willWaitlist).toBe(true);

    const action = viewerAction({ slug: "cup", signedIn: true, state });
    expect(action.kind).toBe("waitlist");
    expect(action.href).toBe("/events/cup/apply");
    expect(action.label).toMatch(/waitlist/i);
  });

  it("never offers Apply to somebody who already has a seat", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState(),
      application: { status: "accepted", waitlistPosition: null },
    });
    expect(action.kind).toBe("accepted");
    expect(action.label).toBe("You're in");
    expect(action.href).toBe("/me/events");
  });

  it("names the queue position", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState({ accepted: 8 }),
      application: { status: "waitlisted", waitlistPosition: 3 },
    });
    expect(action.kind).toBe("queued");
    expect(action.label).toBe("You're #3 in the queue");
  });

  it("falls back to a wordless queue label when the position is missing", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState({ accepted: 8 }),
      application: { status: "waitlisted", waitlistPosition: null },
    });
    expect(action.label).toBe("You're in the queue");
  });

  it("gives the reason when applications are shut, and offers nothing to press", () => {
    const action = viewerAction({ slug: "cup", signedIn: true, state: closedState() });
    expect(action.kind).toBe("closed");
    expect(action.href).toBeNull();
    expect(action.detail).toMatch(/closed/i);
  });

  it("shows the rank gate before an application rather than after it", () => {
    const gate = eligibility(
      { minRankToEnter: "Platinum III", minRankToCaptain: null },
      { rank: "Gold I" },
      LADDER
    );

    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState(),
      eligibility: gate,
    });

    expect(action.kind).toBe("blocked");
    expect(action.href).toBe("/me/profile");
    // The sentence is the gate's own — "you need X, you are Y".
    expect(action.detail).toContain("Platinum III");
    expect(action.detail).toContain("Gold I");
  });

  it("lets a member who clears the gate straight through", () => {
    const gate = eligibility(
      { minRankToEnter: "Platinum III", minRankToCaptain: null },
      { rank: "Diamond III" },
      LADDER
    );
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState(),
      eligibility: gate,
    });
    expect(action.kind).toBe("apply");
  });

  it("treats a withdrawn application as somebody who may come back", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState(),
      application: { status: "withdrawn", waitlistPosition: null },
    });
    expect(action.kind).toBe("reapply");
    expect(action.href).toBe("/events/cup/apply");
  });

  it("does not invite a withdrawn member back once signups have closed", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: closedState(),
      application: { status: "withdrawn", waitlistPosition: null },
    });
    expect(action.kind).toBe("closed");
  });

  it("says so, quietly, when an admin declined them", () => {
    const action = viewerAction({
      slug: "cup",
      signedIn: true,
      state: openState(),
      application: { status: "declined", waitlistPosition: null },
    });
    expect(action.kind).toBe("declined");
    expect(action.href).toBeNull();
  });
});

describe("formatSummary", () => {
  it("says a tournament's shape in plain words", () => {
    expect(
      formatSummary({
        type: "tournament",
        config: { teams: 8, draft: true, bracket: true },
        days: 4,
        capacity: 48,
      })
    ).toEqual(["Tournament", "8 teams", "bid draft", "bracket", "4 days", "48 seats"]);
  });

  it("says nothing about teams or brackets for a Jackbox night", () => {
    expect(formatSummary({ type: "jackbox", config: {}, days: 1, capacity: 12 })).toEqual([
      "Jackbox",
      "one day",
      "12 seats",
    ]);
  });

  it("calls an uncapped event uncapped rather than showing a blank", () => {
    expect(formatSummary({ type: "casual", config: null, days: 0, capacity: null })).toEqual([
      "Casual",
      "no seat limit",
    ]);
  });

  it("mentions a switched-off waitlist, since it changes what full means", () => {
    expect(
      formatSummary({ type: "custom", config: { waitlist: false }, days: 0, capacity: 4 })
    ).toContain("no waitlist");
  });
});

describe("untilText", () => {
  const from = new Date("2026-09-01T12:00:00.000Z");

  it("counts days and hours when there is a while to go", () => {
    expect(untilText(new Date("2026-09-04T16:00:00.000Z"), from)).toBe("3d · 4h");
  });

  it("drops to hours and minutes inside a day", () => {
    expect(untilText(new Date("2026-09-01T14:30:00.000Z"), from)).toBe("2h · 30m");
  });

  it("shows seconds only in the last hour", () => {
    expect(untilText(new Date("2026-09-01T12:22:05.000Z"), from)).toBe("22m · 05s");
    expect(untilText(new Date("2026-09-01T12:00:09.000Z"), from)).toBe("9s");
  });

  it("has nothing to say once the instant has passed", () => {
    expect(untilText(new Date("2026-09-01T11:59:59.000Z"), from)).toBeNull();
    expect(untilText(from, from)).toBeNull();
  });
});
