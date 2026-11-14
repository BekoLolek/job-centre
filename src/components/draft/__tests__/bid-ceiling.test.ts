import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT_CONFIG, canPlaceBid, rosterState } from "@/lib/draft-policy";
import { eventShapeFrom, rosterSizingFrom } from "@/lib/events-policy";
import type { RosterSizing } from "@/lib/events-policy";
import BidBox from "@/app/events/[slug]/draft/BidBox";
import type { BidStanding } from "@/app/events/[slug]/draft/room";
import {
  CAPTAIN_OF_RED,
  T0,
  roomView,
  textOf,
} from "@/app/events/[slug]/draft/__tests__/room-fixture";
import BidCeiling from "../BidCeiling";
import { UNSIZED_ROSTER_NOTE } from "../TeamCard";
import { ceilingFor } from "../ceiling";
import type { MemberLike, TeamLike } from "../types";

/*
 * The word beside each team in the admin's ceiling block (R-250 / UC-49 1b).
 *
 * The block labels every row with the places left — "3 slots left", or "full"
 * once there are none. `rosterState` offers an unsized roster no slot at all
 * (`slotsLeft` is 0 when the Format panel has no figure), so a label that
 * reads "full" off `slotsLeft` alone calls a team full when nobody has said
 * how many it holds. The sentence under the list already says the panel has
 * no figure; the row says nothing about places rather than contradict it.
 *
 * States 1 and 2 are pinned to the letter, so the fix for the third cannot
 * reword what an admin already reads for the other two.
 *
 * Every sizing comes from the real `rosterSizingFrom`, as in
 * `team-card.test.ts`: a hand-written `{ target, cap }` can describe a state
 * the rule never produces.
 */

const CONFIG = DEFAULT_DRAFT_CONFIG;

function sizing(mode: "teams" | "perTeam", value: number, accepted: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({ eventShape: { teamEvent: true, draft: true, sizing: { mode, value } } }),
    accepted
  );
}

/** State 1: six a side, stated. */
const STATED_SIX = sizing("perTeam", 6, 0);
/** State 2: eighteen into four is 5, 5, 4, 4 — the cap is five, no target. */
const CAP_FIVE = sizing("teams", 4, 18);
/** State 3: four teams and three accepted — nothing to derive. */
const UNSIZED = sizing("teams", 4, 3);

/** Rivals Red: a captain and `bought` players at 100 each, sized by `under`. */
function team(bought: number, under: RosterSizing): TeamLike {
  const members: MemberLike[] = [{ teamId: "t-red", userId: "cap-a", price: 0, isCaptain: true }];
  for (let index = 1; index <= bought; index += 1) {
    members.push({ teamId: "t-red", userId: `p-${index}`, price: 100, isCaptain: false });
  }
  return {
    id: "t-red",
    name: "Rivals Red",
    seed: null,
    captainUserId: "cap-a",
    balanceStart: 1000,
    balance: 1000 - 100 * bought,
    roster: rosterState({ id: "t-red" }, members, CONFIG, under),
    members,
  };
}

/** The one team's row and the sentence under it, as words. */
function render(bought: number, under: RosterSizing): string {
  const markup = renderToStaticMarkup(
    createElement(BidCeiling, { teams: [team(bought, under)], config: CONFIG, sizing: under })
  );
  const text = markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(text.indexOf("Rivals Red"));
}

describe("the ceiling block's word for the places left", () => {
  it("counts the slots left under a stated target, as before", () => {
    expect(render(2, STATED_SIX)).toBe(
      "Rivals Red 3 slots left Max bid 798 Held back 2 With 3 slots left, the most Rivals Red can bid is 798 — 2 stays back to fill the other 2 slots."
    );
  });

  it("says one slot, not one slots, as before", () => {
    expect(render(4, STATED_SIX)).toBe(
      "Rivals Red 1 slot left Max bid 600 One slot left, so Rivals Red can bid the whole 600 on it."
    );
  });

  it("calls a team at its stated target full, as before", () => {
    expect(render(5, STATED_SIX)).toBe(
      "Rivals Red full Max bid 0 Rivals Red is full at 6 — nothing left to buy."
    );
  });

  it("counts the slots left under a cap, as before", () => {
    expect(render(2, CAP_FIVE)).toBe(
      "Rivals Red 2 slots left Max bid 799 Held back 1 With 2 slots left, the most Rivals Red can bid is 799 — 1 stays back to fill the other 1 slot."
    );
  });

  it("calls a team at its cap full, as before", () => {
    expect(render(4, CAP_FIVE)).toBe(
      "Rivals Red full Max bid 0 Rivals Red is full at 5 — nothing left to buy."
    );
  });

  it("does not call a team full when the panel has not sized the teams", () => {
    expect(UNSIZED).toEqual({ target: null, cap: null });

    const block = render(2, UNSIZED);

    expect(block).not.toMatch(/\bfull\b/);
    // Task 112 pinned this row as "Rivals Red Max bid 0 <note>", on purpose,
    // to record the wording it found without widening its own scope. Task 141
    // is the change that pin was waiting for: a bid ceiling is derived from
    // the places on a team, so with none counted the row prints no ceiling —
    // neither the figure nor the label that would introduce one.
    expect(block).not.toContain("Max bid");
    expect(block).not.toMatch(/\d/);
    expect(block).toBe(`Rivals Red ${UNSIZED_ROSTER_NOTE}`);
  });
});

/*
 * The same team, read off the admin's ceiling block and off its captain's bid
 * box (Task 141).
 *
 * Both surfaces answer "what may this team bid". `BidBox` answers an unsized
 * team with the note in place of the whole ceiling; the block has to give the
 * same answer, and the way to hold them to that is to compare what each one
 * rendered with the other — not each with a literal, which two components can
 * both satisfy while drifting apart the day one of them is reworded.
 *
 * One team is built once, by the room's own fixture, and handed to both.
 */

/** The bid box's line between lots; whatever follows it is the box's ceiling. */
const WAITING = "Bidding opens once the wheel stops on a player.";

/** What `text` says after `marker` — and a failure if the marker is not there. */
function after(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`"${marker}" is not in: ${text}`);
  return text.slice(at + marker.length).trim();
}

/** Each surface's answer about Rivals Red's ceiling, between lots. */
function answers(under: RosterSizing): { box: string; row: string } {
  const view = roomView({ under }, CAPTAIN_OF_RED);
  const red = view.teams.find((candidate) => candidate.id === view.you.teamId);
  if (!red) throw new Error("the fixture's captain has no team");

  // The standing the server would send between lots, by the real rule — as
  // `bid-box.test.ts` builds it — rather than a check typed by hand.
  const standing: BidStanding = {
    check: canPlaceBid(
      { id: red.id, balance: red.balance },
      CONFIG.minBid,
      { status: "open", openedAt: new Date(T0), bids: [] },
      CONFIG,
      red.roster,
      new Date(T0)
    ),
    hypothetical: true,
    ceiling: ceilingFor(red, CONFIG, under).sentence,
    opening: CONFIG.minBid,
  };
  const box = textOf(
    renderToStaticMarkup(
      createElement(BidBox, {
        view,
        standing,
        spinning: false,
        onBlock: null,
        now: T0,
        bid: async () => ({ ok: true, error: null, reason: null, payload: null }),
      })
    )
  );
  const block = textOf(
    renderToStaticMarkup(createElement(BidCeiling, { teams: [red], config: CONFIG, sizing: under }))
  );

  return { box: after(box, WAITING), row: after(block, red.name) };
}

describe("the ceiling block and the bid box, on the same team", () => {
  it("give an unsized team the same answer, and no figure in it", () => {
    const { box, row } = answers(UNSIZED);

    expect(row).toBe(box);
    expect(row).not.toBe("");
    expect(row).not.toMatch(/\d/);
  });

  it("state the same ceiling in money for a sized team", () => {
    const { box, row } = answers(STATED_SIX);

    const inTheBox = box.match(/^You can bid up to (\d+) /);
    const inTheRow = row.match(/ Max bid (\d+) /);
    expect(inTheBox).not.toBeNull();
    expect(inTheRow?.[1]).toBe(inTheBox?.[1]);
  });
});
