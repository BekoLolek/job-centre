import { describe, expect, it } from "vitest";
import type { ConfirmationState, EventStatus } from "@/db/schema";
import { applicationsOpen } from "@/lib/events-policy";
import {
  CONFIRMATION_CHOICES,
  EVENT_TYPE_SUGGESTIONS,
  applicationStatusLabel,
  applicationStatusTone,
  applicationsPill,
  availabilityMark,
  availabilityTone,
  confirmationBadge,
  confirmationSaid,
  confirmationTone,
  eventStatusLabel,
  eventStatusMeaning,
  eventStatusTone,
  eventTypeLabel,
} from "../labels";
import { iso, localInput, whenText } from "../when";

/**
 * The words and colours event screens are described with.
 *
 * Presentational, but not trivial: every one of these is a total function over
 * an enum, and the failure mode of a partial one is a blank pill on the one
 * status nobody tested. `applicationsPill` in particular reads a shape that
 * `applicationsOpen` produces six different ways.
 */

const EVERY_STATUS: EventStatus[] = [
  "draft",
  "published",
  "live",
  "complete",
  "cancelled",
];

describe("event status", () => {
  it("has a tone, a label and a meaning for every status", () => {
    for (const status of EVERY_STATUS) {
      expect(eventStatusTone(status)).toBeTruthy();
      expect(eventStatusLabel(status)).toMatch(/^[A-Z]/);
      expect(eventStatusMeaning(status).length).toBeGreaterThan(10);
    }
  });

  it("gives published the union-blue 'open' tone, since it is the actionable one", () => {
    expect(eventStatusTone("published")).toBe("open");
    expect(eventStatusTone("draft")).toBe("draft");
    expect(eventStatusTone("live")).toBe("live");
  });

  it("says a draft is invisible, because that is the whole of what draft means", () => {
    expect(eventStatusMeaning("draft")).toMatch(/Only admins/i);
  });
});

describe("applicationsPill", () => {
  const NOW = new Date("2026-07-01T12:00:00Z");
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

  const base = {
    signupOpensAt: null,
    signupClosesAt: null,
    startsAt: at(48),
    capacity: 2,
    config: null,
  };

  it("reads open, in seats", () => {
    const state = applicationsOpen({ ...base, status: "published" }, NOW, { accepted: 0 });
    expect(applicationsPill(state)).toEqual({ tone: "open", label: "Applications open" });
  });

  it("distinguishes a full event that still queues people", () => {
    const state = applicationsOpen({ ...base, status: "published" }, NOW, { accepted: 2 });
    expect(state.open).toBe(true);
    expect(applicationsPill(state)).toEqual({ tone: "open", label: "Waitlist only" });
  });

  it("calls a draft 'not published' rather than 'closed'", () => {
    const state = applicationsOpen({ ...base, status: "draft" }, NOW);
    expect(applicationsPill(state)).toEqual({ tone: "draft", label: "Not published" });
  });

  it("separates 'not yet' from 'too late'", () => {
    const early = applicationsOpen(
      { ...base, status: "published", signupOpensAt: at(24) },
      NOW
    );
    expect(applicationsPill(early)).toEqual({ tone: "closed", label: "Opens later" });

    const late = applicationsOpen(
      { ...base, status: "published", signupClosesAt: at(-1) },
      NOW
    );
    expect(applicationsPill(late)).toEqual({ tone: "closed", label: "Applications closed" });
  });

  it("keeps cancelled distinct from merely closed", () => {
    const state = applicationsOpen({ ...base, status: "cancelled" }, NOW);
    expect(applicationsPill(state)).toEqual({ tone: "cancelled", label: "Cancelled" });
  });

  it("closes a full event whose waitlist is switched off", () => {
    const state = applicationsOpen(
      { ...base, status: "published", config: { waitlist: false } },
      NOW,
      { accepted: 2 }
    );
    expect(state.open).toBe(false);
    expect(applicationsPill(state)).toEqual({ tone: "closed", label: "Applications closed" });
  });
});

describe("application status", () => {
  it("labels and tones all four", () => {
    expect(applicationStatusLabel("accepted")).toBe("Accepted");
    expect(applicationStatusLabel("waitlisted")).toBe("Waitlisted");
    expect(applicationStatusTone("accepted")).toBe("complete");
    expect(applicationStatusTone("declined")).toBe("cancelled");
    expect(applicationStatusTone("withdrawn")).toBe("closed");
  });

  it("tells a pending applicant their application is awaiting review", () => {
    expect(applicationStatusLabel("pending")).toBe("Awaiting review");
    expect(applicationStatusTone("pending")).toBe("open");
  });
});

describe("eventTypeLabel", () => {
  it("spells the known ones properly", () => {
    expect(eventTypeLabel("repo")).toBe("REPO");
    expect(eventTypeLabel("tournament")).toBe("Tournament");
  });

  it("title-cases anything an admin invents, rather than giving up", () => {
    // §8.1: adding a type must be a row, not a code change — including here.
    expect(eventTypeLabel("among-us-night")).toBe("Among Us Night");
    expect(eventTypeLabel("  movie_night  ")).toBe("Movie Night");
    expect(eventTypeLabel("")).toBe("");
  });

  it("suggests only types the schema's own list knows", () => {
    expect([...EVENT_TYPE_SUGGESTIONS]).toEqual([
      "tournament",
      "casual",
      "jackbox",
      "repo",
      "custom",
    ]);
  });
});

describe("availability", () => {
  it("marks each answer, and an unanswered day as unanswered", () => {
    expect(availabilityMark("yes")).toBe("✓");
    expect(availabilityMark("maybe")).toBe("~");
    expect(availabilityMark("no")).toBe("✕");
    expect(availabilityMark(null)).toBe("—");
    expect(availabilityMark(undefined)).toBe("—");
    // A value the enum does not have reads as "no answer", never as a crash.
    expect(availabilityMark("perhaps")).toBe("—");
  });

  it("tones them so the column can be read without reading it", () => {
    expect(availabilityTone("yes")).toBe("text-success");
    expect(availabilityTone("maybe")).toBe("text-union");
    expect(availabilityTone("no")).toBe("text-flare");
    expect(availabilityTone(null)).toBe("text-muted");
  });
});

/*
 * "Are you still coming?" — three answers (R-56, R-199).
 *
 * The shape that matters is totality: three enum values, and every one of them
 * has words and a tone. The admin badge in particular used to be a two-branch
 * ternary, which is how `maybe` would have arrived painted as a refusal.
 */
describe("the still-coming answer", () => {
  const EVERY_ANSWER: ConfirmationState[] = ["in", "maybe", "out"];

  it("offers the three in the order the member reads them", () => {
    expect(CONFIRMATION_CHOICES.map((choice) => choice.value)).toEqual(["in", "maybe", "out"]);
    // The unsure answer sits between the two it is unsure between, not at the
    // end where the enum happens to keep it.
    expect(CONFIRMATION_CHOICES[1].label).toBe("Not sure yet");
  });

  it("covers the enum, so a new answer cannot ship without words for it", () => {
    for (const answer of EVERY_ANSWER) {
      expect(CONFIRMATION_CHOICES.some((choice) => choice.value === answer)).toBe(true);
      expect(confirmationSaid(answer)).toMatch(/^[✓~✕] You said/);
      expect(confirmationBadge(answer)).not.toBeNull();
    }
  });

  it("reads each answer back as the member's own", () => {
    expect(confirmationSaid("in")).toBe("✓ You said you'll be there");
    expect(confirmationSaid("maybe")).toBe("~ You said you are not sure");
    expect(confirmationSaid("out")).toBe("✕ You said you cannot make it");
    // No answer is not an answer, so there is nothing to read back.
    expect(confirmationSaid(null)).toBeNull();
    expect(confirmationSaid(undefined)).toBeNull();
    expect(confirmationSaid("perhaps")).toBeNull();
  });

  it("tones them like the availability column, union for the unsure one", () => {
    expect(confirmationTone("in")).toBe("text-success");
    expect(confirmationTone("maybe")).toBe("text-union");
    expect(confirmationTone("out")).toBe("text-flare");
    expect(confirmationTone(null)).toBe("text-muted");
  });

  it("gives the manager three tones and words that say what was said", () => {
    expect(confirmationBadge("in")).toEqual({ tone: "success", label: "Coming" });
    expect(confirmationBadge("maybe")).toEqual({ tone: "union", label: "Not sure" });
    expect(confirmationBadge("out")).toEqual({ tone: "flare", label: "Not coming" });
    expect(confirmationBadge(null)).toBeNull();
  });

  it("gives every answer a tone of its own", () => {
    // The bug this replaces: a success-or-flare ternary, which would have made
    // "not sure" indistinguishable from "not coming" on the applicants list.
    const tones = EVERY_ANSWER.map((answer) => confirmationBadge(answer)?.tone);
    expect(new Set(tones).size).toBe(EVERY_ANSWER.length);
    // And none of them says "Confirmed out", which is what it used to say.
    for (const answer of EVERY_ANSWER) {
      expect(confirmationBadge(answer)?.label).not.toMatch(/^Confirmed /);
    }
  });
});

describe("when", () => {
  it("normalises everything time-shaped to an ISO string", () => {
    const date = new Date("2026-09-12T18:00:00.000Z");
    expect(iso(date)).toBe("2026-09-12T18:00:00.000Z");
    expect(iso("2026-09-12T18:00:00.000Z")).toBe("2026-09-12T18:00:00.000Z");
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
    expect(iso("   ")).toBeNull();
    expect(iso(new Date("nonsense"))).toBeNull();
  });

  it("formats an instant in the ambient zone, and says nothing about nothing", () => {
    // The suite pins TZ to Europe/Budapest, so 18:00 UTC in September is 20:00.
    // The month's abbreviation is the runtime's ("Sep" or "Sept" depending on
    // ICU data), so the clock is what is asserted rather than the spelling.
    expect(whenText("2026-09-12T18:00:00.000Z")).toMatch(/^Sat 12 Sept? · 20:00$/);
    expect(whenText(null)).toBeNull();
    expect(whenText("junk")).toBeNull();
  });

  it("round-trips into a datetime-local box", () => {
    expect(localInput(new Date("2026-09-12T18:00:00.000Z"))).toBe("2026-09-12T20:00");
    expect(localInput(null)).toBe("");
  });
});
