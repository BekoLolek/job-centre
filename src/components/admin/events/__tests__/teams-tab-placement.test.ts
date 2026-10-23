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
 * Who the Teams tab offers to place, and where (UC-15 5).
 *
 * `placeOnRoster` refuses anybody who is not an accepted applicant, and a
 * destination whose roster is full — so the screen must not offer either. "A
 * form that disagrees with the rule is worse than a form that omits it" is the
 * tab's own standing note, and the failure it guards against is specific: a
 * waitlisted member in the "accepted and not on a team" list is a manager being
 * invited to give away a seat, and the only thing that stops them is a refusal
 * they then have to interpret.
 *
 * The two rules are pure functions, so they are asserted directly *and* through
 * the rendered markup. Directly, because a rule tested only through markup
 * passes the moment the word it looks for appears anywhere on the screen;
 * through the markup, because a rule the render does not actually call is a rule
 * that is not holding.
 *
 * The router and the action module are mocked for the reason
 * `applicant-eligibility.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
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

const { default: TeamsTab, teamsOpenTo, unplacedAccepted } = await import("../TeamsTab");

const CONFIG = { ...DEFAULT_DRAFT_CONFIG, rosterTarget: 3 };

/** One member row. Price zero and not a captain unless it says so. */
function member(teamId: string, userId: string, over: Partial<MemberLike> = {}): MemberLike {
  return { teamId, userId, price: 0, isCaptain: false, ...over };
}

/**
 * A team the tab can render. `roster` comes from the real `rosterState`, not a
 * literal, for the reason the applicant fixture uses the real `eligibility`: a
 * hand-written verdict is what lets a screen and the rule it displays drift.
 */
function team(id: string, name: string, members: MemberLike[]): TeamLike {
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

function who(userId: string, status: ApplicantView["status"], name: string): ApplicantView {
  return applicant({
    id: `application-${userId}`,
    userId,
    status,
    displayName: name,
    member: { id: userId, displayName: name, avatarUrl: null, discordId: `d-${userId}` },
  });
}

function tabData(teams: TeamLike[], over: Partial<DraftTabData> = {}): DraftTabData {
  return {
    teams,
    config: CONFIG,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: {
      "cap-a": { displayName: "Ada Captain" },
      "cap-b": { displayName: "Bo Captain" },
      free: { displayName: "Free Agent" },
      queued: { displayName: "Queued Quin" },
      placed: { displayName: "Placed Pat" },
    },
    started: false,
    // The real reader rather than a literal, for the reason `roster` uses the
    // real `rosterState`: a hand-written format is what lets this screen and
    // the rule it prints drift apart.
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
    ...over,
  };
}

/** The shape an event that never saw the Format panel has — the real reader over nothing. */
const SHAPE = eventShapeFrom({});

/** The tab as a manager reads it: no tags, no entities. */
function render(applicants: ApplicantView[], data: DraftTabData): string {
  return renderToStaticMarkup(
    createElement(TeamsTab, { eventId: "event-1", applicants, data, shape: SHAPE })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Who may be placed (UC-15 5; R-61)                                  */
/* ------------------------------------------------------------------ */

describe("the people the tab offers to place", () => {
  const rosters = [member("team-a", "cap-a", { isCaptain: true }), member("team-a", "placed")];

  it("offers an accepted applicant who is on no roster", () => {
    expect(unplacedAccepted([who("free", "accepted", "Free Agent")], rosters)).toEqual(["free"]);
  });

  it.each(["waitlisted", "declined", "pending", "withdrawn"] as const)(
    "never offers a %s applicant — the server would refuse them",
    (status) => {
      expect(unplacedAccepted([who("queued", status, "Queued Quin")], rosters)).toEqual([]);
    }
  );

  it("does not offer somebody who already has a team", () => {
    // They are moved from where they are, not placed again — offering them
    // twice is how a screen asks for one person on two teams.
    expect(unplacedAccepted([who("placed", "accepted", "Placed Pat")], rosters)).toEqual([]);
  });

  it("keeps application order", () => {
    const list = unplacedAccepted(
      [
        who("free", "accepted", "Free Agent"),
        who("queued", "waitlisted", "Queued Quin"),
        who("cap-b", "accepted", "Bo Captain"),
      ],
      rosters
    );
    expect(list).toEqual(["free", "cap-b"]);
  });

  it("names the accepted one on screen and leaves the waitlisted one off it", () => {
    const data = tabData([team("team-a", "Alpha", rosters), team("team-b", "Bravo", [])]);

    const screen = render(
      [who("free", "accepted", "Free Agent"), who("queued", "waitlisted", "Queued Quin")],
      data
    );

    // Asserted on the *heading plus the name*, because "Queued Quin" absent
    // from the whole page would also be true of a page that failed to render.
    expect(screen).toContain("Accepted and not on a team");
    expect(screen).toContain("Free Agent");
    expect(screen).not.toContain("Queued Quin");
  });
});

/* ------------------------------------------------------------------ */
/* Where they may go (R-64's roster size, §14's captain in it)         */
/* ------------------------------------------------------------------ */

describe("the teams the tab offers as a destination", () => {
  it("leaves out the team they are already on", () => {
    const rosters = [member("team-a", "placed")];
    const open = teamsOpenTo(
      [
        { id: "team-a", name: "Alpha" },
        { id: "team-b", name: "Bravo" },
      ],
      rosters,
      CONFIG.rosterTarget,
      "placed"
    );
    expect(open.map((row) => row.id)).toEqual(["team-b"]);
  });

  it("leaves out a team whose roster is full", () => {
    // Three of three, captain included (§14) — `placeOnRoster` refuses it.
    const rosters = [
      member("team-a", "cap-a", { isCaptain: true }),
      member("team-a", "one"),
      member("team-a", "two"),
      member("team-b", "cap-b", { isCaptain: true }),
    ];
    const open = teamsOpenTo(
      [
        { id: "team-a", name: "Alpha" },
        { id: "team-b", name: "Bravo" },
      ],
      rosters,
      CONFIG.rosterTarget,
      "free"
    );
    expect(open.map((row) => row.id)).toEqual(["team-b"]);
  });

  it("offers every other team when nothing is full", () => {
    const open = teamsOpenTo(
      [
        { id: "team-a", name: "Alpha" },
        { id: "team-b", name: "Bravo" },
        { id: "team-c", name: "Charlie" },
      ],
      [],
      CONFIG.rosterTarget,
      "free"
    );
    expect(open.map((row) => row.id)).toEqual(["team-a", "team-b", "team-c"]);
  });

  it("offers the open team and not the full one in the rendered picker", () => {
    const rosters = [
      member("team-a", "cap-a", { isCaptain: true }),
      member("team-a", "one"),
      member("team-a", "two"),
      member("team-b", "cap-b", { isCaptain: true }),
    ];
    const data = tabData([
      team("team-a", "Alpha", rosters.filter((row) => row.teamId === "team-a")),
      team("team-b", "Bravo", rosters.filter((row) => row.teamId === "team-b")),
    ]);

    const markup = renderToStaticMarkup(
      createElement(TeamsTab, {
        eventId: "event-1",
        applicants: [who("free", "accepted", "Free Agent")],
        data,
        shape: SHAPE,
      })
    );

    // The picker's options, which is the only place a team name appears as an
    // `<option>`. Alpha is full, so it is a roster heading on the page but
    // never a destination.
    const options = [...markup.matchAll(/<option value="team-[ab]">([^<]*)<\/option>/g)].map(
      (match) => match[1]
    );
    expect(options).toContain("Bravo");
    expect(options).not.toContain("Alpha");
  });
});

/* ------------------------------------------------------------------ */
/* The count control (UC-15 1)                                        */
/* ------------------------------------------------------------------ */

describe("the team-count control", () => {
  it("offers the two-to-eight range and nothing outside it (UC-15 1 / §8.1)", () => {
    // The range `setTeamCount` enforces, on the control that submits it. The
    // attributes rather than the prose beside them: a copy edit should not be
    // able to fail this, and a control that let somebody submit nine should
    // not be able to pass it.
    const markup = renderToStaticMarkup(
      createElement(TeamsTab, {
        eventId: "event-1",
        applicants: [],
        data: tabData([]),
        shape: SHAPE,
      })
    );

    const field = markup.match(/<input[^>]*aria-label="Number of teams"[^>]*>/)?.[0];
    expect(field).toBeDefined();
    expect(field).toContain('min="2"');
    expect(field).toContain('max="8"');
    expect(render([], tabData([]))).toContain("Set team count");
  });

  it("says the draft owns rosters once it has started (UC-15 5a)", () => {
    const started = render([], tabData([team("team-a", "Alpha", [])], { started: true }));
    const setup = render([], tabData([team("team-a", "Alpha", [])]));

    expect(started).toContain("Rosters are filled in the draft room");
    expect(setup).not.toContain("Rosters are filled in the draft room");
  });
});
