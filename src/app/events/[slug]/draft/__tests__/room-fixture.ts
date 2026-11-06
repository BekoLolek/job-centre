import {
  DEFAULT_DRAFT_CONFIG,
  type DraftSnapshot,
  type DraftViewer,
  type TeamMemberView,
  type TeamStanding,
  draftComplete,
  maxBidFor,
  redactDraft,
  rosterState,
} from "@/lib/draft-policy";
import type { DraftRoomView } from "@/lib/draft";
import { eventShapeFrom, rosterSizingFrom } from "@/lib/events-policy";
import type { RosterSizing } from "@/lib/events-policy";

/**
 * A draft room's view, built the way the server builds it.
 *
 * The room's surfaces take a `DraftRoomView`, and the honest way to make one
 * without a database is the server's own path minus the reads: a
 * `DraftSnapshot` whose every standing comes from the real `rosterState` over
 * the real `rosterSizingFrom`, put through the real `redactDraft`. A view
 * typed by hand could carry a `roster` the rule never produces — a cap with
 * no target but empty places drawn — and a screen tested against it would be
 * tested against nothing.
 */

export const CONFIG = DEFAULT_DRAFT_CONFIG;
export const T0 = 1_700_000_000_000;

/** The Format panel's figure for a stored shape, by the real reader. */
export function sizing(mode: "teams" | "perTeam", value: number, accepted: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({ eventShape: { teamEvent: true, draft: true, sizing: { mode, value } } }),
    accepted
  );
}

/** State 1: six a side, stated — a target. */
export const STATED_SIX = sizing("perTeam", 6, 0);
/** State 2: eighteen into four is 5, 5, 4, 4 — a cap of five, no target. */
export const CAP_FIVE = sizing("teams", 4, 18);
/** State 3: four teams and three accepted — nothing to derive. */
export const UNSIZED = sizing("teams", 4, 3);

export const PLAYERS = {
  "cap-red": { id: "cap-red", displayName: "Ada Captain", avatarUrl: null, handle: null },
  "cap-blue": { id: "cap-blue", displayName: "Bo Captain", avatarUrl: null, handle: null },
  "p-1": { id: "p-1", displayName: "Cy", avatarUrl: null, handle: null },
  "p-2": { id: "p-2", displayName: "Di", avatarUrl: null, handle: null },
  "p-3": { id: "p-3", displayName: "Ed", avatarUrl: null, handle: null },
  "p-4": { id: "p-4", displayName: "Fay", avatarUrl: null, handle: null },
  "p-5": { id: "p-5", displayName: "Gus", avatarUrl: null, handle: null },
  rook: { id: "rook", displayName: "Rook", avatarUrl: null, handle: null },
};

/** A captain plus `bought` priced players on one team. */
function members(teamId: string, captain: string, bought: number): TeamMemberView[] {
  const rows: TeamMemberView[] = [{ teamId, userId: captain, price: 0, isCaptain: true }];
  for (let index = 1; index <= bought; index += 1) {
    rows.push({ teamId, userId: `p-${index}`, price: 100 * index, isCaptain: false });
  }
  return rows;
}

function standing(
  id: string,
  name: string,
  captain: string,
  bought: number,
  under: RosterSizing
): TeamStanding {
  const rows = members(id, captain, bought);
  const balance = 1000 - rows.reduce((total, row) => total + row.price, 0);
  const roster = rosterState({ id }, rows, CONFIG, under);
  return {
    id,
    name,
    captainUserId: captain,
    balanceStart: 1000,
    seed: null,
    sort: 0,
    balance,
    roster,
    members: rows,
    maxBid: maxBidFor({ balance }, CONFIG, roster),
    bid: null,
  };
}

export type RoomFixture = {
  /** The Format panel's figure the whole room is sized by. */
  under: RosterSizing;
  /** Players bought by Rivals Red, the captain's own team. Default three. */
  redBought?: number;
  /** No teams at all — the room before the Teams tab has been visited. */
  noTeams?: boolean;
  /** A lot on the block, with the wheel already settled. Default none. */
  lotOpen?: boolean;
};

/** The unredacted draft, as `getDraftSnapshot` would have built it. */
export function snapshot({
  under,
  redBought = 3,
  noTeams = false,
  lotOpen = false,
}: RoomFixture): DraftSnapshot {
  const teams = noTeams
    ? []
    : [
        standing("t-red", "Rivals Red", "cap-red", redBought, under),
        standing("t-blue", "Rivals Blue", "cap-blue", 3, under),
      ];
  const main = [{ userId: "rook", kind: "main" as const, sort: 0 }];
  return {
    now: T0,
    config: CONFIG,
    sizing: under,
    teams,
    lot: lotOpen
      ? {
          id: "lot-1",
          playerUserId: "rook",
          fromKind: "main",
          openedAt: T0 - 5_000,
          spin: null,
          bids: [],
          endsAt: null,
        }
      : null,
    history: [],
    pools: { main, reserve: [] },
    activeKind: "main",
    completion: draftComplete({ main: main.length, reserve: 0 }, teams, CONFIG, under),
  };
}

export const CAPTAIN_OF_RED: DraftViewer = { role: "captain", userId: "cap-red", teamId: "t-red" };
export const OBSERVER: DraftViewer = { role: "observer", userId: null, teamId: null };

/** The room as `viewer` sees it, through the real redaction. */
export function roomView(fixture: RoomFixture, viewer: DraftViewer = OBSERVER): DraftRoomView {
  return { ...redactDraft(snapshot(fixture), viewer), eventId: "event-1", players: PLAYERS };
}

/** Markup with the tags stripped, so a sentence can be read across elements. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}
