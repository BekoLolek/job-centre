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
 * "the most it may hold"; with no figure at all the box says so in words, in
 * place of the whole ceiling block. `BidBox` branches on `cap === null` to
 * do that, and the branch earns its keep twice: it withholds the "You can bid
 * up to" figure, which would otherwise read "You can bid up to 0" over places
 * nobody has counted, and it shows the note when `standing` is null, where
 * the fall-through would show nothing. It is not there to dodge a "full at
 * null" sentence — `ceilingFor` stopped saying that, and its sentence for
 * such a roster is now the same note.
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

function render(view: DraftRoomView, standing: BidStanding | null = standingFor(view)): string {
  return textOf(
    renderToStaticMarkup(
      createElement(BidBox, {
        view,
        standing,
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

  it("reads the ceiling under the balance word for word, as before", () => {
    // Between lots the panel is this and nothing else, so the sentence, the
    // figure above it and their order are all pinned at once.
    expect(render(roomView({ under: STATED_SIX }, CAPTAIN_OF_RED))).toBe(
      "Your bid Balance 400 Bidding opens once the wheel stops on a player. You can bid up to 399 With 2 slots left, the most Rivals Red can bid is 399 — 1 stays back to fill the other 1 slot."
    );
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
  it("reads the ceiling under the balance word for word, as before", () => {
    expect(render(roomView({ under: CAP_FIVE }, CAPTAIN_OF_RED))).toBe(
      "Your bid Balance 400 Bidding opens once the wheel stops on a player. You can bid up to 400 One slot left, so Rivals Red can bid the whole 400 on it."
    );
  });

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
    // Not full of anything either. Today that holds only because
    // `canPlaceBid` refuses an unsized roster before it refuses a full one,
    // which is another module's ordering and not this panel's to lean on.
    expect(box).not.toMatch(/\bfull\b/);
  });

  it("is told so in words between lots too", () => {
    const box = render(roomView({ under: UNSIZED }, CAPTAIN_OF_RED));
    expect(box).toContain(UNSIZED_ROSTER_NOTE);
    expect(box).not.toContain("null");
    expect(box).not.toContain("You can bid up to");
  });

  it("is shown the note where the ceiling would stand, and no bid ceiling at all", () => {
    /*
     * The positive half of the test above. `ceilingFor`'s sentence for this
     * roster is the note itself, so the `cap === null` branch in `BidBox`
     * reads as a guard against a sentence that no longer exists — and deleting
     * it puts "You can bid up to 0" above the note, a ceiling over places
     * nobody has counted. The whole panel is pinned so that nothing, figure or
     * label, can stand between the waiting line and the note.
     */
    const box = render(roomView({ under: UNSIZED }, CAPTAIN_OF_RED));
    expect(box).toBe(
      `Your bid Balance 400 Bidding opens once the wheel stops on a player. ${UNSIZED_ROSTER_NOTE}`
    );
  });

  it("is still told so when the server sent no standing", () => {
    // The branch's other job: the fall-through draws nothing without a
    // standing, and a captain of an unsized team would be told nothing.
    const box = render(roomView({ under: UNSIZED }, CAPTAIN_OF_RED), null);
    expect(box).toBe(
      `Your bid Balance 400 Bidding opens once the wheel stops on a player. ${UNSIZED_ROSTER_NOTE}`
    );
  });
});
