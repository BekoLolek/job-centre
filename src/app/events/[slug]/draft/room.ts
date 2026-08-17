/**
 * What one browser is given about a live draft, assembled on the server.
 *
 * `getDraftView` already answers "what may this viewer see" — `redactDraft`
 * decides it and nothing here second-guesses that. This module adds the one
 * thing the room needs that a *view* cannot carry: the server's answer to
 * **"may you bid, and if not why not"**, which is a `BidCheck` from
 * `canPlaceBid` with its reason code intact.
 *
 * ## Why the reason has to come from here
 *
 * There are eleven distinct refusals in `draft-policy.ts` and every one of them
 * is a different sentence a captain can act on — "you have already bid" and
 * "you can afford it but then you could not fill your team" are not the same
 * problem. `placeBid` returns the message but not the code, and the room wants
 * the code to decide *shape*: a locked box, a closed banner, or an error under
 * the input. So the check is run here, against the same snapshot the write
 * would read, by calling the same function the write calls. The client is never
 * told a rule — it is told an answer.
 *
 * ## The stand-in lot
 *
 * Between spins there is no lot, and "nobody is on the block" is not a useful
 * thing to say to a captain looking at their panel — they want to know whether
 * they are *ready*. So with nothing open, the check is run against a lot that
 * has just opened with no bids on it: the question becomes "if a name came up
 * now, could you bid on it", and the answers are the standing ones — a full
 * roster, a balance that cannot meet the minimum. `lot_not_open` still exists
 * and still shows, on the submit path, where it means what it says.
 *
 * ## Two reads for a captain
 *
 * A captain's poll costs `getDraftView` plus `getDraftSnapshot`, because the
 * check needs the bids on the open lot and the redacted view deliberately does
 * not carry other teams' amounts. Rebuilding the view from the snapshot by hand
 * would save the read and cost the redaction — including the rule that the
 * player's name is withheld from *everyone* mid-spin — so it is not a trade
 * worth making. Everybody else's poll is one read.
 */

import type { User } from "@/db";
import {
  type DraftRoomView,
  type DraftViewer,
  getDraftSnapshot,
  getDraftView,
  viewerFor,
} from "@/lib/draft";
import { type BidCheck, canPlaceBid } from "@/lib/draft-policy";
// The pure module rather than the barrel: this runs on the server and has no
// business dragging every draft component into the graph for one sentence.
import { ceilingFor } from "@/components/draft/ceiling";

/** The bid the room offers by default: the event's floor, never below zero. */
function openingAmount(minBid: number): number {
  return Math.max(minBid, 0);
}

export type BidStanding = {
  /**
   * Whether this captain could place the smallest legal bid right now, and the
   * refusal — reason and sentence — when they could not.
   */
  check: BidCheck;
  /** True when there is no lot, so the check answered a hypothetical. */
  hypothetical: boolean;
  /** §9's must-fill rule in money, from `ceilingFor`. */
  ceiling: string;
  /** The smallest legal bid, so the box can offer it rather than a blank. */
  opening: number;
};

export type RoomPayload = {
  view: DraftRoomView;
  /** Captains only. Nobody else has a bid to place. */
  standing: BidStanding | null;
};

/**
 * Ask the policy about one team's bid, with everything read fresh.
 *
 * Exported because the bid action wants the same answer for the amount that
 * was actually typed — the message a captain reads on a refusal and the
 * message the standing panel shows have to come from the same place.
 */
export async function checkBid(
  eventId: string,
  teamId: string,
  amount: number,
  now: Date = new Date()
): Promise<{ check: BidCheck; hypothetical: boolean; ceiling: string } | null> {
  const snapshot = await getDraftSnapshot(eventId, { now });
  if (!snapshot) return null;

  const team = snapshot.teams.find((row) => row.id === teamId);
  if (!team) return null;

  const lot = snapshot.lot;
  const check = canPlaceBid(
    { id: team.id, balance: team.balance },
    amount,
    lot
      ? {
          status: "open",
          openedAt: new Date(lot.openedAt),
          spin: lot.spin,
          bids: lot.bids,
        }
      : // See the module note: no lot means "could you bid if one opened now".
        { status: "open", openedAt: new Date(snapshot.now), bids: [] },
    snapshot.config,
    team.roster,
    new Date(snapshot.now)
  );

  return {
    check,
    hypothetical: lot === null,
    ceiling: ceilingFor(team, snapshot.config).sentence,
  };
}

/**
 * The whole room for one viewer.
 *
 * `viewerFor` decides the role — admin, captain, player or observer — and the
 * signed-out visitor is an observer, which §11 puts in the same row as everyone
 * else for watching.
 */
export async function loadRoom(
  eventId: string,
  user: User | null,
  now: Date = new Date()
): Promise<RoomPayload | null> {
  const viewer: DraftViewer = await viewerFor(eventId, user?.id ?? null, user?.isAdmin ?? false);
  const view = await getDraftView(eventId, viewer, { now });
  if (!view) return null;

  return { view, standing: await standingFor(eventId, viewer, view, now) };
}

async function standingFor(
  eventId: string,
  viewer: DraftViewer,
  view: DraftRoomView,
  now: Date
): Promise<BidStanding | null> {
  if (viewer.role !== "captain" || !viewer.teamId) return null;

  const opening = openingAmount(view.config.minBid);
  const answer = await checkBid(eventId, viewer.teamId, opening, now);
  if (!answer) return null;

  return {
    check: answer.check,
    hypothetical: answer.hypothetical,
    ceiling: answer.ceiling,
    opening,
  };
}
