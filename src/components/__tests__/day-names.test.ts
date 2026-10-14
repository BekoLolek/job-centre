import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dayName } from "@/lib/events-policy";
import type { EventDay } from "@/db/schema";
import type { ApplyDay, ApplyFormProps } from "@/components/apply/ApplyForm";
import type { MyEventRow } from "@/components/me/MyEventCard";
import type { ScheduleDayRow } from "@/app/events/[slug]/ScheduleTab";
import {
  DETAIL_HANDLERS,
  applicant,
  applicantDay,
  applicantsEvent,
} from "@/components/admin/events/__tests__/applicants-fixture";

/*
 * What a day is called, on every surface that names one (UC-08 E3).
 *
 * `dayName` in `src/lib/events-policy.ts` is the rule — the manager's label,
 * or "Day N" — and the day-sequence refusals name days with it, so a refusal
 * ("Saturday starts before Friday") and the page agree about which day they
 * are talking about. These three components each used to carry their own copy,
 * and the copy was a *different* rule: `label ?? \`Day N\`` only catches null,
 * so a day labelled with spaces rendered as a blank where `dayName` renders
 * "Day 1". A blank is the worst of the three possible outputs — it is not
 * obviously broken, it just quietly stops answering "which day is this?".
 *
 * This file is one test per surface, which is the point of it being one file:
 * the copies came back once already, and a drift that reinstated any of them
 * has to fail here. Each renders the real component, because the bug is in
 * what reaches the reader — a pure test of `dayName` cannot see a call site
 * that does not call it.
 *
 * **Each day is named from its stored `dayIndex`, not its position in the
 * array handed to the component.** So every fixture below sits a day with
 * `dayIndex: 1` or `2` at position 0: a component numbering from the position
 * would call it "Day 1", and renaming every day on the screen the moment a
 * list is filtered or reordered is the failure that would otherwise go
 * unnoticed.
 *
 * `useRouter` and the action modules are mocked for the reason
 * `attendance-lock.test.ts` mocks them: importing the actions would drag the
 * database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/events/[slug]/apply/actions", () => ({
  applyToEventAction: vi.fn(),
}));

vi.mock("@/app/me/events/actions", () => ({
  setMyAvailabilityAction: vi.fn(),
  setMyConfirmationAction: vi.fn(),
  withdrawFromEventAction: vi.fn(),
}));

vi.mock("@/app/admin/events/actions", () => ({
  decideApplicationAction: vi.fn(),
  saveApplicationNoteAction: vi.fn(),
  setApplicantAvailabilityAction: vi.fn(),
}));

vi.mock("@/app/admin/events/waiver-actions", () => ({
  listEntryWaiversAction: vi.fn(async () => ({ ok: true, data: { waivers: [] } })),
  revokeEntryWaiverAction: vi.fn(),
  waiveEntryRuleAction: vi.fn(),
  waiveEnterRuleByHandleAction: vi.fn(),
}));

const { default: ApplyForm } = await import("@/components/apply/ApplyForm");
const { default: MyEventCard } = await import("@/components/me/MyEventCard");
const { default: ScheduleTab } = await import("@/app/events/[slug]/ScheduleTab");
const { ApplicantDetail } = await import("@/components/admin/events/ApplicantsTab");

/** The rendered surface as a reader sees it: no tags, no entities. */
function text(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** A day whose label is spaces: the case `??` gets wrong and `dayName` does not. */
const BLANK_LABEL = "   ";

function applyDay(over: Partial<ApplyDay> = {}): ApplyDay {
  return {
    id: "day-1",
    dayIndex: 1,
    label: BLANK_LABEL,
    startsAt: "2026-05-21T17:00:00.000Z",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* The apply form (UC-12 5)                                           */
/* ------------------------------------------------------------------ */

function applyForm(days: ApplyDay[]): string {
  const props: ApplyFormProps = {
    eventId: "event-1",
    slug: "spring-lan",
    questions: [],
    days,
    rankLadder: [],
    availability: {},
    willWaitlist: false,
    entryMode: "first_come",
  };
  return text(createElement(ApplyForm, props));
}

describe("the apply form's day rows", () => {
  it("calls a day labelled with spaces Day N", () => {
    const rendered = applyForm([applyDay()]);

    expect(rendered).toContain("Day 2");
    // From `dayIndex`, not the position: this day is first in the array.
    expect(rendered).not.toContain("Day 1");
  });

  it("leaves a real label alone", () => {
    const rendered = applyForm([applyDay({ label: "Finals night" })]);

    expect(rendered).toContain("Finals night");
    expect(rendered).not.toContain("Day 2");
  });

  it("trims a label rather than printing the padding", () => {
    expect(applyForm([applyDay({ label: "  Sunday  " })])).toContain("Sunday");
  });

  it("names an unlabelled day the same way", () => {
    expect(applyForm([applyDay({ label: null })])).toContain("Day 2");
  });
});

/* ------------------------------------------------------------------ */
/* A member's own event card (UC-13 5)                                */
/* ------------------------------------------------------------------ */

function myEventCard(days: ApplyDay[]): string {
  const row: MyEventRow = {
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
    days,
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
  };
  return text(createElement(MyEventCard, { row }));
}

describe("the day rows on a member's own event card", () => {
  it("calls a day labelled with spaces Day N", () => {
    const rendered = myEventCard([applyDay()]);

    expect(rendered).toContain("Day 2");
    expect(rendered).not.toContain("Day 1");
  });

  it("leaves a real label alone", () => {
    const rendered = myEventCard([applyDay({ label: "Finals night" })]);

    expect(rendered).toContain("Finals night");
    expect(rendered).not.toContain("Day 2");
  });
});

/* ------------------------------------------------------------------ */
/* The schedule tab's running order (UC-11 2)                         */
/* ------------------------------------------------------------------ */

/**
 * With no matches drawn the schedule falls back to the organiser's day plan,
 * which is the list that names days.
 */
function scheduleTab(days: ScheduleDayRow[]): string {
  return text(
    createElement(ScheduleTab, { matches: [], dayBySlot: {}, days })
  );
}

function scheduleDay(over: Partial<ScheduleDayRow> = {}): ScheduleDayRow {
  return {
    id: "day-1",
    dayIndex: 2,
    label: BLANK_LABEL,
    startsAt: "2026-05-22T17:00:00.000Z",
    ...over,
  };
}

describe("the schedule tab's planned days", () => {
  it("calls a day labelled with spaces Day N", () => {
    // Each row prints the day's *position* ("Day 3") beside its *name*, and
    // for an unlabelled day the two are the same words — so the assertion is
    // that both are there. With the old `??` the name was the raw spaces and
    // only the position came out, which is what the second expectation pins.
    const rendered = scheduleTab([scheduleDay()]);

    expect(rendered).toMatch(/Day 3\s+Day 3/);
    expect(rendered).not.toMatch(/Day 1/);
  });

  it("leaves a real label alone, beside the day's number", () => {
    const rendered = scheduleTab([scheduleDay({ label: "Finals night" })]);

    expect(rendered).toMatch(/Day 3\s+Finals night/);
  });

  it("names an unlabelled day the same way", () => {
    expect(scheduleTab([scheduleDay({ label: null })])).toMatch(/Day 3\s+Day 3/);
  });
});

/* ------------------------------------------------------------------ */
/* The applicant's days in the admin drawer (UC-14 extensions E2)      */
/* ------------------------------------------------------------------ */

/**
 * The fifth surface, and the one that got away: `grep -rn 'Day \${'` could not
 * see it, because the number was JSX (`Day {index + 1}`) rather than a template
 * literal — so the acceptance criterion in docs/plan.md, Task 51 was weaker
 * than the rule it stood for, and this call site kept both defects the task was
 * written to remove: the `??` that lets a whitespace label through, and the
 * array position in place of the stored `dayIndex`.
 *
 * It is reached by expanding an applicant, so a static render of the tab never
 * contains it; `ApplicantDetail` is exported for that reason.
 */
function applicantDays(days: EventDay[]): string {
  return text(
    createElement(ApplicantDetail, {
      row: applicant(),
      event: applicantsEvent(days),
      name: "Filler Fay",
      ...DETAIL_HANDLERS,
    })
  );
}

describe("the day rows beside an applicant's availability", () => {
  it("calls a day labelled with spaces Day N", () => {
    const rendered = applicantDays([applicantDay({ label: BLANK_LABEL })]);

    expect(rendered).toContain("Day 2");
    // From `dayIndex`, not the position: this day is first in the array.
    expect(rendered).not.toContain("Day 1");
  });

  it("leaves a real label alone", () => {
    const rendered = applicantDays([applicantDay({ label: "Finals night" })]);

    expect(rendered).toContain("Finals night");
    expect(rendered).not.toContain("Day 2");
  });

  it("trims a label rather than printing the padding", () => {
    expect(applicantDays([applicantDay({ label: "  Sunday  " })])).toContain("Sunday");
  });

  it("names an unlabelled day the same way", () => {
    expect(applicantDays([applicantDay({ label: null })])).toContain("Day 2");
  });
});

/* ------------------------------------------------------------------ */
/* The rule itself                                                    */
/* ------------------------------------------------------------------ */

describe("the rule the three surfaces now share", () => {
  it("is the one in events-policy, and `??` is not it", () => {
    // Stated here as well, because it is the difference the three call sites
    // existed to get wrong: `??` passes a whitespace label straight through.
    const day = { startsAt: null, label: BLANK_LABEL };

    expect(dayName(day, 1)).toBe("Day 2");
    expect(day.label ?? `Day ${2}`).toBe(BLANK_LABEL);
  });
});
