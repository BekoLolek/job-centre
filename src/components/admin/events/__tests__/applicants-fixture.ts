import type { ApplicantView, EventDetail } from "@/lib/events";
import { type WaivedRules, eligibility } from "@/lib/events-policy";
import type { EventDay } from "@/db/schema";

/**
 * Fixtures for the Applicants tab, shared by the tests that render it.
 *
 * Two files need the same applicant: the eligibility line beside it, and
 * `src/components/__tests__/day-names.test.ts`, which holds every surface that
 * names a day to one rule and has to be able to reach this one. The shape is
 * literal rather than read out of a database, for the one reason that matters
 * to these tests: what is being asserted is markup, and a day whose stored
 * `dayIndex` is deliberately not its position in the array is easier to state
 * here than to arrange in Postgres.
 *
 * **The eligibility is not literal.** It is the real `eligibility()` from
 * `events-policy`, given a real ladder and the member's real rank, because a
 * hand-written verdict is exactly the thing that would let the screen and the
 * gate drift apart — which is the defect these tests exist for.
 */

/** Enough of a ladder to sit a member below both bars. */
export const LADDER = ["Gold I", "Platinum III", "Platinum I", "Diamond II", "Diamond I"];

export const ENTER_BAR = "Platinum III";
export const CAPTAIN_BAR = "Diamond II";

/** A day, with its stored index free to differ from its position in the list. */
export function applicantDay(over: Partial<EventDay> = {}): EventDay {
  return {
    id: "day-1",
    eventId: "event-1",
    dayIndex: 1,
    startsAt: new Date("2026-05-21T17:00:00.000Z"),
    label: null,
    ...over,
  };
}

/** The event the tab renders: both rank rules set, so the gate has something to say. */
export function applicantsEvent(
  days: EventDay[],
  over: Partial<EventDetail> = {}
): EventDetail {
  return {
    id: "event-1",
    slug: "spring-lan",
    title: "Spring LAN",
    type: "tournament",
    status: "published",
    description: null,
    bannerUrl: null,
    signupOpensAt: new Date("2026-04-01T17:00:00.000Z"),
    signupClosesAt: new Date("2026-05-19T17:00:00.000Z"),
    startsAt: null,
    endsAt: null,
    capacity: 8,
    gameId: "game-1",
    minRankToEnter: ENTER_BAR,
    minRankToCaptain: CAPTAIN_BAR,
    config: {},
    createdFromTemplateId: null,
    createdBy: null,
    createdAt: new Date("2026-04-01T17:00:00.000Z"),
    updatedAt: new Date("2026-04-01T17:00:00.000Z"),
    seats: {
      capacity: 8,
      accepted: 4,
      waitlisted: 0,
      seatsLeft: 4,
      full: false,
      overCapacity: false,
    },
    applicationsState: {
      open: true,
      willWaitlist: false,
      seatsLeft: 4,
      closesAt: new Date("2026-05-19T17:00:00.000Z"),
      message: "Sign-ups are open.",
    },
    game: null,
    rankLadder: LADDER,
    days,
    questions: [],
    ...over,
  };
}

/**
 * One applicant, with the verdict `getApplicationsForEvent` would have worked
 * out for them: their rank against this event's two bars, plus whatever a
 * manager has waived.
 */
export function applicant(
  over: {
    rank?: string | null;
    waived?: WaivedRules;
    displayName?: string | null;
  } & Partial<Omit<ApplicantView, "eligibility" | "waived">> = {}
): ApplicantView {
  const { rank = "Gold I", waived = { enter: false, captain: false }, displayName, ...rest } = over;
  const event = applicantsEvent([]);

  return {
    id: "application-1",
    eventId: event.id,
    userId: "member-1",
    status: "accepted",
    answers: {},
    submittedAt: new Date("2026-04-02T17:00:00.000Z"),
    decidedAt: null,
    decidedBy: null,
    waitlistPosition: null,
    note: null,
    availability: {},
    confirmation: null,
    member: {
      id: "member-1",
      displayName: displayName ?? "Filler Fay",
      avatarUrl: null,
      discordId: "discord-1",
    },
    rank,
    eligibility: eligibility(event, { rank }, LADDER, waived),
    waived,
    ...rest,
  };
}

/** The handlers the expanded applicant takes; none of them fires in a static render. */
export const DETAIL_HANDLERS = {
  onChanged: () => {},
  onError: () => {},
  waiverBusy: false,
  onWaive: () => {},
  onRevoke: () => {},
};
