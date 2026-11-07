import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemberLike, TeamLike } from "@/components/draft";
import { UNSIZED_ROSTER_NOTE } from "@/components/draft/TeamCard";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import {
  type EventShape,
  type RosterSizing,
  eventShapeFrom,
  rosterSizingFrom,
  teamFormatFrom,
} from "@/lib/events-policy";
import { applicant } from "./applicants-fixture";
import type { DraftTabData } from "../types";

/*
 * What the Teams tab says the places on a team are (R-248 / UC-49 4).
 *
 * Three surfaces on the tab print the figure: the Rosters eyebrow ("N places
 * a team, captain included"), the badge on each roster, and the "on the
 * roster" line under each named team. All three collapsed `cap` to zero or
 * printed it raw, so an event the Format panel had not sized yet read "0
 * places a team" over badges reading "1/" — a roster of nothing rather than a
 * decision nobody has made. Each surface is asserted in each of the panel's
 * three states, in the team card's own words for the second and third so a
 * figure never looks like two things on two screens.
 *
 * The router and the action module are mocked for the reason
 * `teams-tab-placement.test.ts` mocks them.
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

const { default: TeamsTab } = await import("../TeamsTab");

const CONFIG = DEFAULT_DRAFT_CONFIG;

/** The three states as stored shapes, so the tab's `shape` and `data.sizing` agree. */
const STATED: EventShape = eventShapeFrom({
  eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 3 } },
});
const COUNTED: EventShape = eventShapeFrom({
  eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 4 } },
});

function who(index: number): ApplicantView {
  const userId = `user-${index}`;
  return applicant({
    id: `application-${userId}`,
    userId,
    status: "accepted",
    displayName: `Player ${index}`,
    member: { id: userId, displayName: `Player ${index}`, avatarUrl: null, discordId: userId },
  });
}

/** A team of one captain, its roster from the real `rosterState` over `sizing`. */
function team(sizing: RosterSizing): TeamLike {
  const members: MemberLike[] = [{ teamId: "team-a", userId: "user-1", price: 0, isCaptain: true }];
  return {
    id: "team-a",
    name: "Rivals Red",
    seed: null,
    captainUserId: "user-1",
    balanceStart: CONFIG.defaultBalance,
    balance: CONFIG.defaultBalance,
    roster: rosterState({ id: "team-a" }, members, CONFIG, sizing),
    members,
  };
}

/** The tab as a manager reads it, over `accepted` people and the shape they are sized by. */
function text(shape: EventShape, accepted: number): string {
  const sizing = rosterSizingFrom(shape, accepted);
  const applicants = Array.from({ length: accepted }, (_, index) => who(index + 1));
  const data: DraftTabData = {
    teams: [team(sizing)],
    config: CONFIG,
    sizing,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: { "user-1": { displayName: "Player 1" } },
    started: false,
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
  };
  return renderToStaticMarkup(
    createElement(TeamsTab, { eventId: "event-1", applicants, data, shape })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rarr;|&#x2192;/g, "→")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

describe("the places on a team, on the Teams tab", () => {
  it("states a target as the places, with the roster counted against it", () => {
    expect(rosterSizingFrom(STATED, 3)).toEqual({ target: 3, cap: 3 });
    const rendered = text(STATED, 3);

    expect(rendered).toContain("3 places a team, captain included");
    expect(rendered).toContain("1/3 on the roster");
    expect(rendered).toContain("Rivals Red 1/3");
  });

  it("states a cap as the most a team holds, in the team card's words", () => {
    expect(rosterSizingFrom(COUNTED, 18)).toEqual({ target: null, cap: 5 });
    const rendered = text(COUNTED, 18);

    expect(rendered).toContain("Up to 5 places a team, captain included");
    expect(rendered).toContain("1 on the roster, up to 5");
    expect(rendered).toContain("Rivals Red 1 of up to 5");
    expect(rendered).not.toContain("1/5");
  });

  it("says the panel has no figure, in the shared words, rather than 0 places a team", () => {
    expect(rosterSizingFrom(COUNTED, 1)).toEqual({ target: null, cap: null });
    const rendered = text(COUNTED, 1);

    expect(rendered).toContain(`Rosters ${UNSIZED_ROSTER_NOTE}`);
    expect(rendered).not.toContain("0 places a team");
    expect(rendered).not.toContain("places a team");
    // Neither "1/" badge nor "1/ on the roster": a count with nothing under it.
    expect(rendered).not.toMatch(/\d\/(\s|$)/);
    expect(rendered).toContain("Rivals Red 1 ");
    expect(rendered).toContain("1 on the roster Captain Player 1");
  });
});
