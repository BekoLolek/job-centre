import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import { eventShapeFrom, rosterSizingFrom } from "@/lib/events-policy";
import type { RosterSizing } from "@/lib/events-policy";
import TeamCard, { UNSIZED_ROSTER_NOTE } from "../TeamCard";
import type { MemberLike, TeamLike } from "../types";

/*
 * What a team card says about the places on a team (R-250 / UC-49 1a, 1b).
 *
 * `rosterSizingFrom` has three answers and the card has to say three different
 * things, because the figure means something different each time:
 *
 *  - a **stated target** ("Players on a team") is a decision, so the card
 *    reads `4/6 on the roster`, counts what is left to fill and draws the empty
 *    places — exactly as it did before the other two states existed;
 *  - a **cap with no target** ("How many teams") is a consequence of the
 *    accepted count, uneven by arithmetic, so the card reads `4 on the roster,
 *    up to 5`, draws no empty place and marks nobody short — a place that may
 *    not exist is not a place to promise;
 *  - **no figure at all** (a count of teams with fewer accepted than sides)
 *    is said in words, because `0/ on the roster` reads as a roster of nothing
 *    rather than a panel that has not decided yet.
 *
 * Every roster here comes from the real `rosterState` over the real
 * `rosterSizingFrom`, never a literal: a hand-written `{ target, cap }` is the
 * one way a fixture can describe a state the rule never produces.
 */

const CONFIG = DEFAULT_DRAFT_CONFIG;

function sizing(mode: "teams" | "perTeam", value: number, accepted: number): RosterSizing {
  return rosterSizingFrom(
    eventShapeFrom({ eventShape: { teamEvent: true, draft: true, sizing: { mode, value } } }),
    accepted
  );
}

/** State 1: six a side, stated. Holds whoever is accepted. */
const STATED_SIX = sizing("perTeam", 6, 0);
/** State 2: eighteen into four is 5, 5, 4, 4 — the cap is five, no target. */
const CAP_FIVE = sizing("teams", 4, 18);
/** State 3: four teams and three accepted — nothing to derive. */
const UNSIZED = sizing("teams", 4, 3);

const players = {
  "cap-a": { displayName: "Ada Captain" },
  "p-1": { displayName: "Bo" },
  "p-2": { displayName: "Cy" },
  "p-3": { displayName: "Di" },
  "p-4": { displayName: "Ed" },
  "p-5": { displayName: "Fay" },
};

/** A captain plus `bought` priced players, in a fixed order. */
function members(teamId: string, bought: number): MemberLike[] {
  const rows: MemberLike[] = [{ teamId, userId: "cap-a", price: 0, isCaptain: true }];
  for (let index = 1; index <= bought; index += 1) {
    rows.push({ teamId, userId: `p-${index}`, price: 100 * index, isCaptain: false });
  }
  return rows;
}

/** A team of a captain and `bought` players, sized by `under`. */
function team(bought: number, under: RosterSizing, id = "t-red"): TeamLike {
  const rows = members(id, bought);
  return {
    id,
    name: "Rivals Red",
    seed: 1,
    captainUserId: "cap-a",
    balanceStart: 1000,
    balance: 1000 - rows.reduce((total, row) => total + row.price, 0),
    roster: rosterState({ id }, rows, CONFIG, under),
    members: rows,
  };
}

/** A team with nobody on it at all, sized by `under`. */
function emptyTeam(under: RosterSizing, id = "t-blue"): TeamLike {
  return {
    id,
    name: "Rivals Blue",
    seed: null,
    captainUserId: null,
    balanceStart: 1000,
    balance: 1000,
    roster: rosterState({ id }, [], CONFIG, under),
    members: [],
  };
}

function markup(subject: TeamLike): string {
  return renderToStaticMarkup(
    createElement(TeamCard, { team: subject, players, showRoster: true, warnNoCaptain: true })
  );
}

function text(subject: TeamLike): string {
  return markup(subject)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/**
 * Anything that would read as a figure for the places on a team: `4/6`, a
 * bare `0`, "to fill", an empty place drawn in. None of it may appear on a
 * card that has no figure to print.
 */
const LOOKS_LIKE_A_FIGURE = /\d+\/|\/\d+|\b0\b|on the roster|to fill|Empty slot|per roster/;

/* ------------------------------------------------------------------ */
/* State 1 — a stated target, unchanged                               */
/* ------------------------------------------------------------------ */

describe("a roster with a stated target", () => {
  /*
   * While Task 108 was built, this block also held a byte pin: the card for
   * this exact fixture, captured by rendering it at `8caa1ee` before the other
   * two states existed, and asserted with `toBe` against the markup after.
   * It proved that the overwhelmingly common case came out *identical*, not
   * merely "still says 4/6", and two reviews confirmed it. It was then
   * removed, because kept it would have been a snapshot test: it would fail
   * on the first legitimate class change in `Badge`, `Eyebrow`, `Money` or
   * `RosterList` — none of which is this card's decision — and be regenerated
   * without thought. State 1 is owned by behaviour below.
   */

  it("reads x/y, counts what is left to fill, and draws the empty places", () => {
    const card = text(team(3, STATED_SIX));
    expect(card).toContain("4/6 on the roster");
    expect(card).toContain("2 to fill");
    expect(card.match(/Empty slot/g)).toHaveLength(2);
  });

  it("still holds the stated figure with nobody on the team (UC-49 1b)", () => {
    const card = text(emptyTeam(STATED_SIX));
    expect(card).toContain("0/6 on the roster");
    expect(card).toContain("6 to fill");
    expect(card.match(/Empty slot/g)).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* State 2 — a cap with no target (UC-49 1a)                          */
/* ------------------------------------------------------------------ */

describe("a roster capped by a count of teams", () => {
  it("reads what it holds and the most it may hold, not x/y", () => {
    const card = text(team(3, CAP_FIVE));
    expect(card).toContain("4 on the roster, up to 5");
    expect(card).not.toMatch(/\d+\/\d+/);
  });

  it("draws no empty place — a place that may not exist is not promised", () => {
    expect(text(team(3, CAP_FIVE))).not.toContain("Empty slot");
    expect(text(emptyTeam(CAP_FIVE))).not.toContain("Empty slot");
  });

  it("marks nobody short or over for holding what another team holds", () => {
    // 5, 5, 4, 4: a team of four and a team of five are both legal sides.
    const four = text(team(3, CAP_FIVE));
    const five = text(team(4, CAP_FIVE));
    expect(four).not.toContain("to fill");
    expect(four).not.toContain("Over target");
    expect(five).not.toContain("to fill");
    expect(five).not.toContain("Over target");
  });

  it("still says a team at the cap is full — it can hold no more", () => {
    expect(text(team(4, CAP_FIVE))).toContain("Full");
    expect(text(team(3, CAP_FIVE))).not.toContain("Full");
  });

  it("still badges a roster over the cap — that one is genuinely illegal", () => {
    expect(text(team(5, CAP_FIVE))).toContain("Over target");
  });
});

/* ------------------------------------------------------------------ */
/* State 3 — no figure at all (UC-49 1b)                              */
/* ------------------------------------------------------------------ */

describe("a roster the panel has not sized", () => {
  it("has one sentence for it, and the sentence says who decides and where", () => {
    // "An admin decides", not "Setup → Format is where that is decided": the
    // room's header and a captain's bid box say this to people who have no
    // Setup → Format to open, the way the room already says "An admin sets
    // captains on the event's Teams tab."
    expect(UNSIZED_ROSTER_NOTE).toBe(
      "The Format panel has not sized the teams yet. An admin decides that in Setup → Format."
    );
  });

  it("says so in words rather than printing a 0 or an empty gap", () => {
    const card = text(team(0, UNSIZED));
    expect(card).toContain(UNSIZED_ROSTER_NOTE);
    expect(card).not.toMatch(LOOKS_LIKE_A_FIGURE);
  });

  it("does not read as a roster of nothing when the team is empty", () => {
    const card = text(emptyTeam(UNSIZED));
    expect(card).toContain(UNSIZED_ROSTER_NOTE);
    expect(card).not.toMatch(LOOKS_LIKE_A_FIGURE);
  });

  it("is never badged full or over — there is nothing to be full of", () => {
    const card = text(team(2, UNSIZED));
    expect(card).not.toContain("Full");
    expect(card).not.toContain("Over target");
  });
});
