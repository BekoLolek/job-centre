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
 *
 * ## The door is here, not only on the page (R-253 / UC-50 2)
 *
 * A private draft's room, pool and lots are served to its captains and its
 * managers and to nobody else — and "served" means every payload, not every
 * page. The page at `./page.tsx` guards itself so it can *say* the draft is
 * private; this guards the data, because `loadRoomAction` is the poll the
 * browser calls once a second and a server action is a public endpoint. A
 * guard on the page alone would turn a member away at the URL and hand them
 * every lot and every bid the moment they called the poll directly. Next's own
 * guidance for this is to check "close to your data source", and every payload
 * the room is ever built from comes through {@link loadRoom}.
 */

import { eq } from "drizzle-orm";
import { type User, db, events } from "@/db";
import {
  type DraftRoomView,
  type DraftViewer,
  getDraftSnapshot,
  getDraftView,
  viewerFor,
} from "@/lib/draft";
import { type BidCheck, canPlaceBid, mayWatchPrivateDraft } from "@/lib/draft-policy";
import { privateDraftFrom } from "@/lib/events-policy";
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
    // The team's own roster carries the sizing the snapshot was built with, so
    // the sentence counts the same places `canPlaceBid` just did.
    ceiling: ceilingFor(team, snapshot.config, team.roster).sentence,
  };
}

/**
 * The whole room for one viewer, or `null` when there is none for them.
 *
 * `viewerFor` decides the role — admin, captain, player or observer — and the
 * signed-out visitor is an observer, which §11 puts in the same row as everyone
 * else for watching. The "admin" role is the console, and a host of this event
 * gets it too; `viewerFor` asks `canManageEvent`, not `isAdmin`.
 *
 * `null` for two reasons, which a caller cannot tell apart and does not need
 * to: the event has gone, or the draft is private and this viewer is not one
 * of the people it is served to (R-253 / UC-50 2; see the module comment). The
 * page distinguishes them *before* calling this, by asking the same two
 * questions, because it has a sentence to choose; the poll just stops.
 */
export async function loadRoom(
  eventId: string,
  user: User | null,
  now: Date = new Date()
): Promise<RoomPayload | null> {
  const viewer: DraftViewer = await viewerFor(eventId, user?.id ?? null, user?.isAdmin ?? false);
  if (await closedTo(eventId, viewer)) return null;

  const view = await getDraftView(eventId, viewer, { now });
  if (!view) return null;

  return { view, standing: await standingFor(eventId, viewer, view, now) };
}

/**
 * Whether a private draft's doors are shut to this viewer (R-253 / UC-50 2).
 *
 * One small read of `events.config` per payload, made only for the viewers
 * the flag can turn away: a manager or a captain is let in whatever it says,
 * so for them nothing is read. The read is the flag *as it stands now*, which
 * is what lets 2c hold with nothing to backfill — the next poll after the
 * doors reopen is served, and the next poll after they close is not.
 */
async function closedTo(eventId: string, viewer: DraftViewer): Promise<boolean> {
  if (mayWatchPrivateDraft(viewer)) return false;
  const [row] = await db
    .select({ config: events.config })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return privateDraftFrom(row?.config);
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
