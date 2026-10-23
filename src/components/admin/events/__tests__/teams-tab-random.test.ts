import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemberLike, TeamLike } from "@/components/draft";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import { eventShapeFrom, teamFormatFrom } from "@/lib/events-policy";
import { applicant } from "./applicants-fixture";
import type { DraftTabData } from "../types";

/*
 * The Teams tab's format panel and its random-teams button — UC-41 1, 2, 3b, 4,
 * 4a, 4b.
 *
 * ## Why this renders the tab rather than only calling the functions
 *
 * `random-teams.test.ts` already proves `planTeams`. What it cannot prove is
 * that this screen *calls* it, or calls it with the right two numbers — and a
 * passing test of a pure function beside a screen that quietly stopped using
 * it is a known way for a whole feature to disappear while the suite stays
 * green. So every claim below about what the admin reads is asserted against
 * the real rendered markup, with the real `planTeams` behind it: delete the
 * plan sentence, feed it the applicant count instead of the accepted count, or
 * size it from the unsaved chip instead of the stored format, and one of these
 * fails.
 *
 * `acceptedCount` is also asserted directly, because a rule tested only
 * through markup passes the moment the number it looks for appears anywhere on
 * the page.
 *
 * **Nothing here asserts a refusal based on a team's role composition.** The
 * comp is stated and never enforced (R-215 / UC-41 2), and the two tests in
 * "the comp is stated, never enforced" are about the screen *saying* so.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/draft-actions", () => ({
  placeOnRosterAction: vi.fn(),
  previewTeamCountAction: vi.fn(),
  previewTeamsAction: vi.fn(),
  randomiseTeamsAction: vi.fn(),
  removeFromRosterAction: vi.fn(),
  saveNightFormatAction: vi.fn(),
  saveTeamsAction: vi.fn(),
  setTeamCountAction: vi.fn(),
}));

const { default: TeamsTab, acceptedCount } = await import("../TeamsTab");

const CONFIG = { ...DEFAULT_DRAFT_CONFIG, rosterTarget: 6 };

function team(id: string, name: string, members: MemberLike[] = []): TeamLike {
  return {
    id,
    name,
    seed: null,
    captainUserId: members.find((row) => row.isCaptain)?.userId ?? null,
    balanceStart: CONFIG.defaultBalance,
    balance: CONFIG.defaultBalance,
    roster: rosterState({ id }, members, CONFIG),
    members,
  };
}

/** `count` applicants, all accepted unless `status` says otherwise. */
function people(count: number, status: ApplicantView["status"] = "accepted"): ApplicantView[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${status}-${index}`;
    return applicant({
      id: `application-${id}`,
      userId: id,
      status,
      displayName: `Player ${index}`,
      member: {
        id,
        displayName: `Player ${index}`,
        avatarUrl: null,
        discordId: `d-${id}`,
      },
    });
  });
}

function tabData(over: Partial<DraftTabData> = {}): DraftTabData {
  return {
    teams: [],
    config: CONFIG,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: {},
    started: false,
    // The real reader, not a literal: a hand-written format is what lets the
    // screen and the rule it prints drift apart.
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
    ...over,
  };
}

/** The raw markup, for the things that live in attributes. */
function markup(applicants: ApplicantView[], data: DraftTabData): string {
  // The shape an event that never saw the Format panel has: sized by its own
  // comp, through the real reader, so 3v3 fixtures still plan at three.
  const shape = eventShapeFrom({ teamFormat: data.teamFormat.format });
  return renderToStaticMarkup(
    createElement(TeamsTab, { eventId: "event-1", applicants, data, shape })
  );
}

/** The tab as a manager reads it: no tags, no entities. */
function render(applicants: ApplicantView[], data: DraftTabData): string {
  return markup(applicants, data)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2019;|&rsquo;/g, "’")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Who the shuffle counts                                            */
/* ------------------------------------------------------------------ */

describe("the people the shuffle has to work with", () => {
  it("counts the accepted applicants", () => {
    expect(acceptedCount(people(12))).toBe(12);
  });

  it.each(["waitlisted", "declined", "pending", "withdrawn"] as const)(
    "does not count a %s applicant — the write would not deal them",
    (status) => {
      expect(acceptedCount(people(5, status))).toBe(0);
    }
  );

  it("counts only the accepted ones in a mixed list", () => {
    expect(acceptedCount([...people(7), ...people(4, "waitlisted")])).toBe(7);
  });

  it("plans from the accepted count, not the applicant count", () => {
    // Twelve accepted beside four waitlisted is two full teams, not three
    // teams with two short. Rendered, because this is the mistake a screen
    // makes rather than a library.
    const screen = render([...people(12), ...people(4, "waitlisted")], tabData());
    expect(screen).toContain("12 accepted players make 2 teams of 6, 6");
    expect(screen).not.toContain("3 teams");
  });
});

/* ------------------------------------------------------------------ */
/* The comp is stated, never enforced (R-215 / UC-41 2)               */
/* ------------------------------------------------------------------ */

describe("the comp is stated, never enforced", () => {
  it("states 2-2-2 at 6v6, and says the sizing lives on the Format panel", () => {
    // Since Task 81 the chip states the comp and sizes nothing; the Format
    // panel sizes the teams, and this sentence says where.
    const screen = render(people(12), tabData());
    expect(screen).toContain("6v6 states a 2-2-2 comp.");
    expect(screen).toContain("Teams are sized in Setup → Format, not here.");
  });

  it("states 1-1-1 at 3v3", () => {
    const screen = render(
      people(12),
      tabData({ teamFormat: teamFormatFrom({ teamFormat: "3v3" }) })
    );
    expect(screen).toContain("3v3 states a 1-1-1 comp.");
  });

  it("says in as many words that it is not enforced", () => {
    // Asserted on the whole clause rather than on the word "enforced", which a
    // screen could satisfy while promising the opposite.
    expect(render(people(12), tabData())).toContain(
      "The comp is stated, never enforced — nobody is assigned a role, and a team that fields three Duelists is not refused."
    );
  });

  it("offers both formats, each labelled with the comp it implies", () => {
    // Both comps are on screen whichever is stored, so the admin reads what
    // the other choice would mean before making it — and there is no second
    // team size in the component for the plan to be drawn from by mistake.
    const screen = render(people(12), tabData());
    expect(screen).toContain("6v6 · 2-2-2");
    expect(screen).toContain("3v3 · 1-1-1");
  });

  it("marks the stored format as the chosen one", () => {
    const raw = markup(people(12), tabData());
    expect(raw).toContain('aria-label="Run this night as 6v6, a 2-2-2 comp"');
    expect(raw).toContain('aria-label="Run this night as 3v3, a 1-1-1 comp"');
    // The stored one is the pressed one.
    expect(raw).toMatch(/aria-pressed="true"[^>]*aria-label="Run this night as 6v6/);
    expect(raw).toMatch(/aria-pressed="false"[^>]*aria-label="Run this night as 3v3/);
  });

  it("marks 3v3 as chosen once that is what is stored", () => {
    const raw = markup(
      people(12),
      tabData({ teamFormat: teamFormatFrom({ teamFormat: "3v3" }) })
    );
    expect(raw).toMatch(/aria-pressed="true"[^>]*aria-label="Run this night as 3v3/);
    expect(raw).toMatch(/aria-pressed="false"[^>]*aria-label="Run this night as 6v6/);
  });
});

/* ------------------------------------------------------------------ */
/* What it says before anything is saved (UC-41 4, 4a)                */
/* ------------------------------------------------------------------ */

describe("what the screen says before the shuffle runs", () => {
  it("says how many teams an even count makes, and that none are short", () => {
    const screen = render(people(12), tabData());
    expect(screen).toContain("12 accepted players make 2 teams of 6, 6");
    expect(screen).toContain("Every team is a full 6");
  });

  it("names the short teams by position for an uneven count (UC-41 4a)", () => {
    /*
     * Sixteen at six a side: 6, 5, 5 — and the two short teams named. The
     * numbers are asserted, not the word "short": a screen that said "some
     * teams are short" would satisfy a looser check while telling the admin
     * nothing they could act on.
     */
    const screen = render(people(16), tabData());
    expect(screen).toContain("16 accepted players make 3 teams of 6, 5, 5");
    expect(screen).toContain("Teams 2, 3 are short of 6");
    expect(screen).toContain("the remainder is spread one per team rather than left on one short team");
    // And specifically not the shape the rule rejects.
    expect(screen).not.toContain("6, 6, 4");
  });

  it("reads a single short team as singular", () => {
    const screen = render(people(11), tabData());
    expect(screen).toContain("11 accepted players make 2 teams of 6, 5");
    expect(screen).toContain("Team 2 is short of 6");
  });

  it("sizes the plan at three once 3v3 is the stored format", () => {
    const screen = render(
      people(12),
      tabData({ teamFormat: teamFormatFrom({ teamFormat: "3v3" }) })
    );
    expect(screen).toContain("12 accepted players make 4 teams of 3, 3, 3, 3");
  });

  it("names how many existing teams would be discarded (UC-41 3a)", () => {
    /*
     * The count is asserted on the panel because `Modal` renders nothing while
     * it is closed, so a figure that lived only in the dialog would be a
     * figure no test here could read. The server holds the *rule* — it refuses
     * without an explicit replace, naming the same count — and that is proved
     * in `random-teams-actions.test.ts`.
     */
    const screen = render(
      people(12),
      tabData({
        teams: [
          team("t1", "Alpha", [
            { teamId: "t1", userId: "accepted-0", price: 0, isCaptain: true },
          ]),
          team("t2", "Bravo", [
            { teamId: "t2", userId: "accepted-1", price: 0, isCaptain: false },
          ]),
        ],
        // What the page would say of these rows: one place, by hand (the
        // captain is not a placement).
        fill: { route: "hand", placed: 1 },
      })
    );

    expect(screen).toContain(
      "Shuffling discards the 2 teams that already exist, with their names, seeds and 2 roster places — every one of them placed by hand."
    );
  });

  it("says nothing about discarding when there are no teams yet", () => {
    // The control: a sentence that is always on screen names nothing.
    expect(render(people(12), tabData())).not.toContain("Shuffling discards");
  });

  it("says a reshuffle is allowed (UC-41 5a)", () => {
    expect(render(people(12), tabData())).toContain(
      "Asking twice is fine: the second shuffle is a fresh one and replaces the first."
    );
  });
});

/* ------------------------------------------------------------------ */
/* The refusals, on screen rather than as an error (UC-41 3b, 4b)     */
/* ------------------------------------------------------------------ */

describe("what the screen refuses", () => {
  it("names the count and the team size when there are too few people (UC-41 4b)", () => {
    const screen = render(people(4), tabData());
    expect(screen).toContain("Only 4 players are accepted, and one team of 6 needs 6");
    // And it does not also promise a plan.
    expect(screen).not.toContain("accepted players make");
  });

  it("refuses outright once a lot has been awarded, and says why (UC-41 3b)", () => {
    const screen = render(people(12), tabData({ started: true, teams: [team("t1", "Alpha")] }));

    expect(screen).toContain("The draft has already awarded lots");
    expect(screen).toContain("Void the lots in the draft room first");
    // Not offered and then rejected: the plan sentence is replaced by the
    // refusal, so the admin is never invited to press it.
    expect(screen).not.toContain("accepted players make");
  });

  it("disables the button once a lot has been awarded", () => {
    const raw = markup(people(12), tabData({ started: true }));
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>\s*Make random teams/);
  });

  it("disables the button when there are too few people", () => {
    const raw = markup(people(4), tabData());
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>\s*Make random teams/);
  });

  it("offers the button when the numbers work and no lot has been awarded", () => {
    // The control for the two tests above: a `disabled` assertion that is true
    // of every state proves nothing.
    const raw = markup(people(12), tabData());
    expect(raw).toMatch(/<button[^>]*>\s*Make random teams/);
    expect(raw).not.toMatch(/<button[^>]*disabled[^>]*>\s*Make random teams/);
  });
});
