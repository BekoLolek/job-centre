import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ceilingFor } from "@/components/draft/ceiling";
import { UNSIZED_ROSTER_NOTE } from "@/components/draft/TeamCard";
import { canPlaceBid } from "@/lib/draft-policy";
import type { DraftRoomView } from "@/lib/draft";
import BidBox from "../BidBox";
import type { BidStanding } from "../room";
import {
  CAPTAIN_OF_RED,
  CAP_FIVE,
  CONFIG,
  STATED_SIX,
  T0,
  UNSIZED,
  roomView,
  textOf,
} from "./room-fixture";

/*
 * What a captain's bid box says about the places on their team (R-250 /
 * UC-49 1a, 1b).
 *
 * The box prints a roster figure in two places — "your draft is done, x of y"
 * when the roster is full, and the ceiling sentence under the balance — and
 * both have to say the same thing the team card says, or a captain sees one
 * figure on the rail and another in the box. Under a cap the full line reads
 * "up to"; with no figure at all the box says so in words, because the
 * ceiling sentence for a roster with no cap would otherwise read "full at
 * null", and a captain told their team is full of nothing has been told a
 * lie with a word missing from it.
 */

/**
 * The standing the server would hand this captain — `canPlaceBid` and
 * `ceilingFor` over the team's own roster, exactly as `checkBid` in `room.ts`
 * computes it, minus the database read. A standing typed by hand could name a
 * refusal the rule would never give.
 */
function standingFor(view: DraftRoomView): BidStanding {
  const me = view.teams.find((team) => team.id === view.you.teamId);
  if (!me) throw new Error("the fixture's captain has no team");
  const lot = view.lot
    ? { status: "open" as const, openedAt: new Date(view.lot.openedAt), bids: [] }
    : { status: "open" as const, openedAt: new Date(T0), bids: [] };
  return {
    check: canPlaceBid({ id: me.id, balance: me.balance }, Math.max(CONFIG.minBid, 0), lot, CONFIG, me.roster, new Date(T0)),
    hypothetical: view.lot === null,
    ceiling: ceilingFor(me, CONFIG, me.roster).sentence,
    opening: Math.max(CONFIG.minBid, 0),
  };
}

function render(view: DraftRoomView): string {
  return textOf(
    renderToStaticMarkup(
      createElement(BidBox, {
        view,
        standing: standingFor(view),
        spinning: false,
        onBlock: "Rook",
        now: T0,
        bid: async () => ({ ok: true, error: null, reason: null, payload: null }),
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/* State 1 — a stated target, unchanged                               */
/* ------------------------------------------------------------------ */

describe("a captain whose team has a stated target", () => {
  it("is shown the ceiling in money, as before", () => {
    const box = render(roomView({ under: STATED_SIX, lotOpen: true }, CAPTAIN_OF_RED));
    expect(box).toContain("You can bid up to");
    expect(box).not.toContain(UNSIZED_ROSTER_NOTE);
  });

  it("reads x of y when the roster is full, as before", () => {
    const box = render(roomView({ under: STATED_SIX, redBought: 5, lotOpen: true }, CAPTAIN_OF_RED));
    expect(box).toContain("Your draft is done — 6 of 6 on the roster.");
  });
});

/* ------------------------------------------------------------------ */
/* State 2 — a cap with no target (UC-49 1a)                          */
/* ------------------------------------------------------------------ */

describe("a captain whose team is capped by a count of teams", () => {
  it("reads the full line as a cap, not as x of y", () => {
    const box = render(roomView({ under: CAP_FIVE, redBought: 4, lotOpen: true }, CAPTAIN_OF_RED));
    // Not "5 on the roster, up to 5": full is measured against the cap, so
    // the two numbers could only ever be the same one, and a repeated number
    // reads as a glitch. The card's "4 on the roster, up to 5" is for a team
    // that is not full.
    expect(box).toContain("Your draft is done — 5 on the roster, the most it may hold.");
    // "You can bid up to 0" is money and may stay; the roster phrase may not.
    expect(box).not.toMatch(/\d+ of \d+ on the roster|on the roster, up to \d+/);
  });
});

/* ------------------------------------------------------------------ */
/* State 3 — no figure at all (UC-49 1b)                              */
/* ------------------------------------------------------------------ */

describe("a captain whose team the panel has not sized", () => {
  it("is told so once while a lot is on the block — the refusal already says it", () => {
    const box = render(roomView({ under: UNSIZED, lotOpen: true }, CAPTAIN_OF_RED));
    // `canPlaceBid`'s `roster_unsized` message is the alert on this panel, so
    // the shared note underneath it would state the one fact twice. Either
    // sentence says the teams are not sized; exactly one of them appears.
    expect(box.match(/has not sized|does not size/g)).toHaveLength(1);
    expect(box).not.toContain("null");
    expect(box).not.toContain("You can bid up to");
    expect(box).not.toMatch(/\d+ of \d+|\d+\/\d+|up to 0\b/);
  });

  it("is told so in words between lots too", () => {
    const box = render(roomView({ under: UNSIZED }, CAPTAIN_OF_RED));
    expect(box).toContain(UNSIZED_ROSTER_NOTE);
    expect(box).not.toContain("null");
    expect(box).not.toContain("You can bid up to");
  });
});
