import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import { dayName } from "@/lib/events-policy";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { type MatchRecord, blankGamesFor, resolveMatches } from "@/lib/format-resolve";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
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

vi.mock("@/app/admin/events/format-actions", () => ({
  applyScheduleAction: vi.fn(),
  saveScheduleSettingsAction: vi.fn(),
}));

const { default: ApplyForm } = await import("@/components/apply/ApplyForm");
const { default: MyEventCard } = await import("@/components/me/MyEventCard");
const { default: ScheduleTab } = await import("@/app/events/[slug]/ScheduleTab");
const { ApplicantDetail } = await import("@/components/admin/events/ApplicantsTab");
const { default: AdminScheduleTab } = await import("@/components/admin/events/ScheduleTab");

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
    mode: "apply",
    profile: [],
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
/* The admin schedule tab's day hint                                  */
/* ------------------------------------------------------------------ */

/*
 * A sixth surface, found by running Task 51's own grep after the work was done.
 *
 * The hint under each start-time field is the manager's name for that day. The
 * field is labelled by position ("Day 2 start"), so a day with no name of its
 * own must show **no hint**: printing "Day 2" under "Day 2 start" says the same
 * thing twice. That is `dayLabel`'s question rather than `dayName`'s answer, and
 * it was written `?? `, which renders a label of spaces as an empty hint — the
 * original defect, one surface further on.
 *
 * **The overrun warning on the same screen is deliberately not this.** It reads
 * `dayOverruns`, which reports the Nth day of the *running order* — the warning
 * renders directly under `BlockList`'s own "Day 1 · 2 blocks" heading, and a
 * plan has days before any day row exists. Naming it from a day row was tried
 * and reverted: with one day row carrying `dayIndex: 2`, the warning was about
 * plan day 1 and would have read "Finals night" beside a heading reading "Day
 * 1". The census at the end of this file is where that distinction is held.
 */

const SPEC = generateStage("single_elim", 4, normaliseStageConfig("single_elim", { bestOf: 3 }));

/** The event's running order, long enough that a late start runs past midnight. */
function adminFormat(): FormatView {
  const teams = Array.from({ length: 4 }, (_unused, index) => ({
    id: `team-${index + 1}`,
    name: `Team ${index + 1}`,
    seed: index + 1,
  }));
  const rows: MatchRecord[] = SPEC.matches.map((match) => ({
    slot: match.slot,
    bestOf: match.bestOf,
    teamAId: null,
    teamBId: null,
    sourceA: match.sourceA,
    sourceB: match.sourceB,
    scheduledAt: null,
    finishedAt: null,
    durationMin: null,
    winnerOverrideId: null,
    firstSideChoice: "a" as const,
    games: blankGamesFor(match),
  }));
  const blocks = planBlocks([SPEC], {
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 1,
    days: 1,
    blockDays: null,
  });
  const stage: StageView = {
    id: "stage-1",
    name: "Playoffs",
    kind: "single_elim",
    sort: 0,
    config: SPEC.config,
    teamCount: teams.length,
    spec: SPEC,
    matches: resolveMatches({
      stage: SPEC,
      matches: rows,
      teams,
      seeds: teams.map((team) => team.id),
    }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: teams.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
  };
  return {
    eventId: "event-1",
    teams,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 1,
    days: 1,
  };
}

/**
 * The tab as a manager first meets it, with two planned days and a row for the
 * second only — so the hint has to land under "Day 2 start" and nowhere else.
 *
 * Times are `localInput`, and the suite pins `TZ=Europe/Budapest`, so the start
 * that renders is fixed rather than whatever the machine thinks.
 */
function adminScheduleElement(label: string | null) {
  const days = [
    applicantDay({ id: "day-1", dayIndex: 1, startsAt: new Date("2026-05-21T15:00:00.000Z") }),
    applicantDay({ id: "day-2", dayIndex: 2, startsAt: new Date("2026-05-22T15:00:00.000Z"), label }),
  ];
  return createElement(AdminScheduleTab, {
    eventId: "event-1",
    event: applicantsEvent(days),
    format: adminFormat(),
    settings: {
      timing: DEFAULT_FORMAT_TIMING,
      concurrentLobbies: 1,
      days: 2,
      blockDays: null,
    },
    matchIds: Object.fromEntries(SPEC.matches.map((match) => [match.slot, `row-${match.slot}`])),
  });
}

const adminSchedule = (label: string | null) => text(adminScheduleElement(label));

/**
 * How many hints the screen renders.
 *
 * Counted in the **markup**, not in the text, because that is the difference a
 * label of spaces makes: `?? ` renders a hint element containing whitespace,
 * and `text()` collapses whitespace, so the reader sees an empty line where the
 * text helper sees nothing at all. A mutation putting `?? ` back survives every
 * assertion over `text()` — which is how this test came to be written this way.
 */
function hintCount(label: string | null): number {
  const hints = renderToStaticMarkup(adminScheduleElement(label)).match(
    /class="eyebrow block mt-1 text-dim"/g
  );
  return hints?.length ?? 0;
}

describe("the admin schedule tab's day hint", () => {
  it("shows the manager's name under the field for that day", () => {
    // The field is "Day 2 start" and the hint under it is the name, so both are
    // there: the position is what the field edits, the name is whose day it is.
    expect(adminSchedule("Finals night")).toMatch(/Day 2 start\s+Finals night/);
  });

  it("shows nothing for a day the manager never named", () => {
    // Day 1 is unnamed in every fixture here, so the two fields sit next to each
    // other with nothing between them. Printing "Day 1" as its own hint would
    // say the field's own label back.
    expect(adminSchedule("Finals night")).toMatch(/Day 1 start\s+Day 2 start/);
  });

  it("treats a label of spaces as no name rather than as a blank hint", () => {
    // One fewer hint element on the screen, not one containing spaces. The
    // collapsed text is identical either way, so this is the only assertion
    // that can tell the two apart.
    expect(hintCount(BLANK_LABEL)).toBe(hintCount("Finals night") - 1);
    expect(hintCount(null)).toBe(hintCount(BLANK_LABEL));
    expect(adminSchedule(BLANK_LABEL)).toMatch(/Day 1 start\s+Day 2 start\s+How long/);
  });
});

/* ------------------------------------------------------------------ */
/* Every other place a day is named, and why                          */
/* ------------------------------------------------------------------ */

/*
 * Task 51's acceptance criterion was `grep -rn "Day \${" src/components src/app`
 * finding no fallback outside `dayName`, and taken literally it can never pass
 * — because there are **two** things called "day N" on this site, and only one
 * of them is an event's day:
 *
 *  - **An event's day** is the thing UC-08 E3 lets a manager name. Every
 *    surface that names one calls `dayName`, and the blocks above render each.
 *  - **A position in the running order** is the Nth day of a plan. It exists
 *    before any day row does (`settings.days` is a number; the rows are written
 *    separately), `BlockList` is handed blocks and no days at all, and "put this
 *    block on Day 2" is about the plan rather than about a name.
 *
 * So the criterion is a census rather than a prohibition: every positional use
 * is written down here with why it is positional, and anything new fails until
 * somebody either classifies it or changes it to call `dayName`. That is the
 * criterion the grep was reaching for — and it is stricter, because it also
 * sees the JSX form (`Day {n}`) that the grep could not and that let the
 * applicants drawer keep both defects through Task 51.
 */

/** Comments stripped, so prose about this rule cannot satisfy it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ");
}

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...tsxUnder(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Where a day is named by its position, keyed by path, with the reason. */
const POSITIONAL: Record<string, { count: number; why: string }> = {
  "src/app/events/[slug]/ResultsTab.tsx": {
    count: 1,
    why: "Groups played matches by the day of the running order they ran on.",
  },
  "src/app/events/[slug]/ScheduleTab.tsx": {
    count: 2,
    why:
      "One heading per day of the running order, and the planned-day list's " +
      "number printed beside the name `dayName` gives it.",
  },
  "src/components/admin/events/DaysTab.tsx": {
    count: 2,
    why:
      "The day editor itself: 'Day 1' is the row whose name is being typed, so " +
      "it has to be the position — the name is the field's value.",
  },
  "src/components/admin/events/ResultsTab.tsx": {
    count: 2,
    why:
      "The day filter and each block's heading, both over `block.day` — the " +
      "running order's day, not the event's.",
  },
  "src/components/admin/events/ScheduleTab.tsx": {
    count: 4,
    why:
      "'Day 2 start' is the field's position and its hint is the name; the " +
      "block-day picker chooses which day of the plan a block runs on; and the " +
      "overrun warning's two sentences read `dayOverruns`, which counts days of " +
      "the running order beside BlockList's own headings.",
  },
  "src/components/format/BlockList.tsx": {
    count: 2,
    why: "Handed blocks and no day rows at all: it cannot know a day's name.",
  },
};

describe("every other place a day is named", () => {
  const found = new Map<string, number>();
  for (const file of [...tsxUnder("src/app"), ...tsxUnder("src/components")]) {
    const hits = code(file).match(/Day \$\{|Day \{/g);
    if (hits) found.set(file.replace(/\\/g, "/"), hits.length);
  }

  it("found the tree it is sweeping", () => {
    // A floor, so a broken walk fails here rather than passing everything.
    expect(tsxUnder("src/components").length).toBeGreaterThan(50);
    expect(found.size).toBeGreaterThan(3);
  });

  it("is a day of the running order every time, and written down", () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(POSITIONAL).sort());

    for (const [file, count] of found) {
      expect(POSITIONAL[file].count, `${file}: ${POSITIONAL[file].why}`).toBe(count);
    }
  });

  it("keeps the census honest", () => {
    // Every entry says why, so a line added without a reason fails here.
    for (const [file, entry] of Object.entries(POSITIONAL)) {
      expect(entry.why.length, `${file} has no reason`).toBeGreaterThan(30);
      expect(found.has(file), `${file} is in the census but not in the tree`).toBe(true);
    }
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
