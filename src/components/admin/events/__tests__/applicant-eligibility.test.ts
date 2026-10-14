import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { eligibility } from "@/lib/events-policy";
import {
  DETAIL_HANDLERS,
  LADDER,
  applicant,
  applicantDay,
  applicantsEvent,
} from "./applicants-fixture";

/*
 * What the Applicants tab tells a manager about eligibility (R-59 / UC-14 3b).
 *
 * The gate folds a waiver in on purpose — `canEnter` is "may this person play",
 * and after a waiver the answer is yes. The *screen* has one more thing to say,
 * and `Eligibility.enterWaived`'s docblock says exactly what it is: "a waiver
 * rendered as though the member met the bar hides the one fact a manager may
 * later want to revisit". The collapsed row is what a manager scans down on the
 * night, so a waived member who reads "Eligible" there is a decision that has
 * vanished into the one list which was supposed to show it.
 *
 * The other half is the tint on the captain line in the expanded applicant.
 * `setCaptains` enforces `meetsCaptainRule` (R-59 / UC-15 3a) and `CaptainsTab`
 * reads the same answer; `canCaptain` folds the entry rule back in, so reading
 * it here warns about a captain rule that is met and that nobody is holding
 * against them.
 *
 * The router and the action modules are mocked for the reason
 * `day-names.test.ts` mocks them: importing the actions would drag the database
 * and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
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

const { default: ApplicantsTab, ApplicantDetail, eligibilityNote } = await import(
  "../ApplicantsTab"
);

type Row = ReturnType<typeof applicant>;

/** The table as a manager reads it: no tags, no entities. */
function tab(rows: Row[]): string {
  return renderToStaticMarkup(
    createElement(ApplicantsTab, {
      event: applicantsEvent([applicantDay()]),
      applicants: rows,
    })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&middot;|&#xB7;/g, "·")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** What the line says for one member, which is the rule on its own. */
function note(over: Parameters<typeof applicant>[0]): string {
  return eligibilityNote(applicant(over).eligibility).label;
}

/* ------------------------------------------------------------------ */
/* The collapsed row (UC-14 2)                                        */
/* ------------------------------------------------------------------ */

describe("the one line the applicants table gives each member", () => {
  it("never calls a waived member eligible — and it reaches the reader", () => {
    const rendered = tab([applicant({ rank: "Gold I", waived: { enter: true, captain: false } })]);

    // They may play; the waiver is what says so, and the line says which.
    expect(rendered).toContain("Entry waived");
    expect(rendered).not.toContain("Eligible");
  });

  it("still says Eligible to somebody who clears the bar on their own", () => {
    expect(tab([applicant({ rank: "Platinum I" })])).toContain("Eligible");
    expect(note({ rank: "Platinum I" })).toBe("Eligible");
  });

  it("keeps saying who is below the bar", () => {
    expect(tab([applicant({ rank: "Gold I" })])).toContain("Below the bar");
    expect(note({ rank: "Gold I" })).toBe("Below the bar");
  });

  it("names the waived rule, whichever one it was", () => {
    expect(note({ rank: "Gold I", waived: { enter: true, captain: false } })).toBe(
      "Entry waived"
    );
    expect(note({ rank: "Gold I", waived: { enter: true, captain: true } })).toBe(
      "Can captain · entry waived"
    );
    expect(note({ rank: "Platinum I", waived: { enter: false, captain: true } })).toBe(
      "Can captain · waived"
    );
  });

  it("reports a waiver on a rule the member now clears as nothing at all", () => {
    // `enterWaived` is "a waiver is the *only* reason they are in", so somebody
    // who has since climbed the ladder is eligible on their own merits and the
    // line says so. The waiver is still there to withdraw in the drawer.
    expect(note({ rank: "Diamond I", waived: { enter: true, captain: true } })).toBe(
      "Can captain"
    );
  });

  it("is a line the gate itself cannot give, which is why it exists", () => {
    const event = applicantsEvent([]);
    const waived = eligibility(event, { rank: "Gold I" }, LADDER, { enter: true, captain: false });
    const clears = eligibility(event, { rank: "Platinum I" }, LADDER);

    // Both are `canEnter`. Only one of them met the bar.
    expect(waived.canEnter).toBe(true);
    expect(clears.canEnter).toBe(true);
    expect(eligibilityNote(waived).label).not.toBe(eligibilityNote(clears).label);
  });
});

/* ------------------------------------------------------------------ */
/* The expanded applicant: the captain line's tint (UC-15 3a)          */
/* ------------------------------------------------------------------ */

describe("the captain hint in the expanded applicant", () => {
  /**
   * The tint on the captain line, which is the whole of what is being asserted:
   * where `meetsCaptainRule` and `canCaptain` disagree, `captainReason` is the
   * *entry* refusal either way, so the colour is the only thing that differs.
   */
  function captainTint(row: Row): string | undefined {
    const markup = renderToStaticMarkup(
      createElement(ApplicantDetail, {
        row,
        event: applicantsEvent([applicantDay()]),
        name: "Filler Fay",
        ...DETAIL_HANDLERS,
      })
    );
    return markup.match(/<p class="mt-1 text-12 (text-[\w-]+)"/)?.[1];
  }

  it("does not warn about a captain rule the member meets", () => {
    /*
     * Below the entry bar, waived past the *captain* rule and not past the
     * entry one: `meetsCaptainRule` is true — which is all `setCaptains` asks —
     * while `canCaptain` is false, because it folds the entry rule back in.
     * This is the one case where the two disagree, and the tint used to read
     * the one the server does not enforce.
     */
    const row = applicant({ rank: "Gold I", waived: { enter: false, captain: true } });
    expect(row.eligibility.meetsCaptainRule).toBe(true);
    expect(row.eligibility.canCaptain).toBe(false);

    expect(captainTint(row)).toBe("text-muted");
  });

  it("still warns about one they do not meet", () => {
    const row = applicant({ rank: "Platinum I" });
    expect(row.eligibility.meetsCaptainRule).toBe(false);

    expect(captainTint(row)).toBe("text-union");
  });
});
