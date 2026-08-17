"use server";

/**
 * The live draft room's server actions — the whole of §11's "place a bid" and
 * "run the draft" rows.
 *
 * Thin, like every other action file here: `src/lib/draft.ts` owns the
 * transaction and the row lock, `src/lib/draft-policy.ts` owns the rules, and
 * nothing below re-decides either. What these add is the trust boundary.
 *
 * ## Nothing arrives from the client that could change the answer
 *
 * A bid carries an amount and an event id. It does **not** carry the team — the
 * team is `viewerFor`'s answer for the signed-in user, so a captain cannot bid
 * for somebody else by editing a payload. Nor does any admin command carry a
 * lot id: there is exactly one open lot per event and the server reads which,
 * so an award cannot be aimed at a lot that settled two minutes ago.
 *
 * ## Why these are actions and not route handlers
 *
 * checklist.md's Phase 1 note: `next dev` runs route handlers in a different
 * process from page renders, and PGlite lives inside whichever process opened
 * it, so a write from an `/api/*` route is invisible to the pages that render
 * next. Anything here that writes has to be an action.
 *
 * ## Nothing revalidates
 *
 * The room polls once a second (§3.4) and every action hands back a freshly
 * built payload, so `revalidatePath` would buy nothing and cost a router
 * refresh in the middle of a spin — a re-render of the page everybody is
 * watching, at the one moment it must not flicker.
 */

import type { DraftPoolKind } from "@/db/schema";
import {
  awardLot,
  clearBid,
  discardLot,
  getDraftSnapshot,
  moveToReserve,
  openLot,
  placeBid,
  viewerFor,
  voidLastLot,
  voidLot,
} from "@/lib/draft";
import type { BidRefusalReason } from "@/lib/draft-policy";
import { getCurrentUser, requireAdmin, requireUser } from "@/lib/session-guards";
import { type RoomPayload, checkBid, loadRoom } from "./room";

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * One poll. Deliberately readable signed out — §11 puts the whole room in the
 * same row for watching, and an observer who is refused the payload is an
 * observer staring at a frozen wheel.
 */
export async function loadRoomAction(eventId: string): Promise<RoomPayload | null> {
  const user = await getCurrentUser();
  return loadRoom(eventId, user);
}

/* ------------------------------------------------------------------ */
/* Bidding                                                            */
/* ------------------------------------------------------------------ */

export type BidOutcome = {
  ok: boolean;
  /** The server's sentence. Never a generic one — it is `canPlaceBid`'s own. */
  error: string | null;
  /** Which of the eleven refusals it was, when the check is the thing that refused. */
  reason: BidRefusalReason | null;
  /** The room as it stands afterwards, refused or not. */
  payload: RoomPayload | null;
};

/**
 * A captain's bid.
 *
 * `placeBid` is the authority — it re-reads the balance, the roster and the
 * standing bid inside the event's row lock and refuses with `canPlaceBid`'s
 * own message. When it does refuse, the same check is run again outside the
 * lock purely to recover *which* refusal it was, so the panel can choose
 * between an error under the input and a state (a locked box, a closed lot).
 * The sentence shown is always the write's, never the second check's, because
 * the write is the one that saw the real numbers.
 */
export async function placeBidAction(eventId: string, amount: number): Promise<BidOutcome> {
  const user = await requireUser();
  const viewer = await viewerFor(eventId, user.id, user.isAdmin);

  if (viewer.role !== "captain" || !viewer.teamId) {
    return {
      ok: false,
      error: "Only a captain can bid, and only for their own team.",
      reason: null,
      payload: await loadRoom(eventId, user),
    };
  }

  const snapshot = await getDraftSnapshot(eventId);
  const lot = snapshot?.lot ?? null;
  if (!lot) {
    return {
      ok: false,
      error: "Nobody is on the block right now.",
      reason: "lot_not_open",
      payload: await loadRoom(eventId, user),
    };
  }

  const result = await placeBid(lot.id, viewer.teamId, amount);
  if (!result.ok) {
    const classified = await checkBid(eventId, viewer.teamId, amount);
    return {
      ok: false,
      error: result.error,
      reason: classified && !classified.check.ok ? classified.check.reason : null,
      payload: await loadRoom(eventId, user),
    };
  }

  return { ok: true, error: null, reason: null, payload: await loadRoom(eventId, user) };
}

/* ------------------------------------------------------------------ */
/* Running it                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything the admin console can do, as data.
 *
 * No lot ids and no prices. The lot is whichever one is open, and the price is
 * always the winning team's own bid — `awardLot` refuses to take a figure from
 * the caller, so the number on the record is one a captain actually offered.
 */
export type AdminCommand =
  | { type: "spin"; kind: DraftPoolKind }
  /** §9's admin-pick selection: this player, now. `openLot` checks they are in that pool. */
  | { type: "pick"; userId: string; kind: DraftPoolKind }
  | { type: "award"; teamId: string }
  | { type: "discard" }
  | { type: "reserve" }
  | { type: "clearBid"; teamId: string }
  | { type: "clearBids" }
  | { type: "cancel" }
  | { type: "undo" };

export type AdminOutcome = {
  ok: boolean;
  error: string | null;
  /** A quiet confirmation for things whose effect is not obvious on screen. */
  note: string | null;
  payload: RoomPayload | null;
};

export async function runDraftAction(
  eventId: string,
  command: AdminCommand
): Promise<AdminOutcome> {
  const admin = await requireAdmin();
  const done = async (
    ok: boolean,
    error: string | null = null,
    note: string | null = null
  ): Promise<AdminOutcome> => ({
    ok,
    error,
    note,
    payload: await loadRoom(eventId, admin),
  });

  // The open lot is read here rather than taken from the button that was
  // pressed: by the time a click arrives the lot it was aimed at may have
  // settled, and awarding the wrong lot is not a mistake anybody can see.
  const snapshot = await getDraftSnapshot(eventId);
  if (!snapshot) return done(false, "That event no longer exists.");
  const lotId = snapshot.lot?.id ?? null;

  switch (command.type) {
    case "spin": {
      const result = await openLot(eventId, { kind: command.kind, openedBy: admin.id });
      return result.ok ? done(true) : done(false, result.error);
    }

    case "pick": {
      const result = await openLot(eventId, {
        userId: command.userId,
        kind: command.kind,
        openedBy: admin.id,
      });
      return result.ok ? done(true) : done(false, result.error);
    }

    case "award": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      const result = await awardLot(lotId, command.teamId, { closedBy: admin.id });
      return result.ok
        ? done(true, null, `Awarded for ${result.data.lot.price ?? 0}.`)
        : done(false, result.error);
    }

    case "discard": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      const result = await discardLot(lotId, { closedBy: admin.id });
      return result.ok ? done(true) : done(false, result.error);
    }

    case "reserve": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      const result = await moveToReserve(lotId, { closedBy: admin.id });
      return result.ok ? done(true) : done(false, result.error);
    }

    case "clearBid": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      const result = await clearBid(lotId, command.teamId);
      if (!result.ok) return done(false, result.error);
      return done(
        true,
        null,
        result.data.cleared ? "Bid cleared — they can enter another." : "There was no bid to clear."
      );
    }

    case "clearBids": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      // One call per bid rather than a bulk delete: `clearBid` is the tested
      // path and it re-checks that the lot is still open every time.
      let cleared = 0;
      for (const bid of snapshot.lot?.bids ?? []) {
        const result = await clearBid(lotId, bid.teamId);
        if (!result.ok) return done(false, result.error);
        if (result.data.cleared) cleared += 1;
      }
      return done(true, null, cleared === 1 ? "1 bid cleared." : `${cleared} bids cleared.`);
    }

    case "cancel": {
      if (!lotId) return done(false, "Nobody is on the block right now.");
      const result = await voidLot(lotId, { voidedBy: admin.id });
      return result.ok
        ? done(true, null, "Lot cancelled. Nobody paid anything.")
        : done(false, result.error);
    }

    case "undo": {
      const result = await voidLastLot(eventId, { voidedBy: admin.id });
      if (!result.ok) return done(false, result.error);
      const { refunded, returnedTo } = result.data;
      const parts: string[] = [];
      if (refunded !== null) parts.push(`${refunded} given back`);
      if (returnedTo) parts.push(`player returned to the ${returnedTo} pool`);
      return done(true, null, parts.length > 0 ? `Undone — ${parts.join(", ")}.` : "Undone.");
    }
  }
}
