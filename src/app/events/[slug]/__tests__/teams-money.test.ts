import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMoney } from "@/components/draft";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import type { TeamWithRoster } from "@/lib/draft";
import type { EventBoard } from "@/lib/event-board";
import { eventShapeFrom, rosterSizingFrom } from "@/lib/events-policy";
import TeamsTab from "../TeamsTab";

/*
 * No money on the page of a night that had no auction (R-254 / UC-51).
 *
 * > **UC-51 2.** System shows each team and its roster, with no price beside
 * > a player, no balance on a card, no spent total and no paragraph
 * > explaining balances.
 * > **1a.** The event has a draft — every figure stays exactly as it is today.
 * > **2a.** A drafted night where every price happens to be zero — the
 * > figures stay. The question is whether an auction was run, not what it
 * > produced.
 *
 * ## The signal is the board's draft flag, and the zero-price case proves it
 *
 * Teams can be filled three ways (R-220), and on a night filled by hand or at
 * random every price is zero and every balance is its starting figure — so
 * "hide the money when every price is zero" would pass UC-51 2 and be wrong,
 * because it would also strip a drafted night whose captains all paid
 * nothing. The 2a test is the one that dies under that mutation: it is drafted,
 * every price is zero, and it still wants its balances and its paragraph.
 *
 * ## The drafted case was pinned before the change, then released
 *
 * While this task was built, this file also held a sha256 digest of the
 * drafted `pricedTeams` fixture's markup
 * (`c28bc944f94a6f3c9feec5b07c88a930c0ecdc08f9a89d88f0480d106d257931`),
 * captured at `dda2220` before a single line moved, and asserted with `toBe`
 * against the markup after. It proved that the common case came out
 * *identical* rather than merely "still says Total spent". It was then taken
 * out, for `team-card.test.ts`'s reason and one more: a digest over this tab
 * is a digest over `TeamCard`, `RosterList`, `PlayerChip`, `Money`, `Badge`
 * and `Eyebrow`, none of which is this tab's decision, and a roster chip
 * change was landing in the same tree. The drafted case is owned by the
 * behaviour tests below.
 *
 * Rendered with `renderToStaticMarkup` over a fixture board rather than the
 * route, because nothing here needs a database: the tab is a pure function of
 * `EventBoard`, and `event-board.test.ts` is where the flag's read from
 * `events.config` is proven.
 */

const CONFIG = DEFAULT_DRAFT_CONFIG;

/** Three a side, stated — the common shape, so the cards draw their empty places as usual. */
const THREE_A_SIDE = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 3 } },
  }),
  0
);

const players = {
  "cap-red": { displayName: "Ada Captain" },
  "cap-blue": { displayName: "Bo Captain" },
  "p-1": { displayName: "Cy" },
  "p-2": { displayName: "Di" },
  "p-3": { displayName: "Ed" },
};

const STAMP = new Date("2026-01-01T00:00:00Z");

/** A team of its captain and `prices.length` bought players at those prices. */
function team(id: string, name: string, captain: string, bought: Array<[string, number]>): TeamWithRoster {
  const members = [
    {
      id: `${id}-${captain}`,
      teamId: id,
      eventId: "event-1",
      userId: captain,
      price: 0,
      acquiredAt: STAMP,
      isCaptain: true,
      lotId: null,
    },
    ...bought.map(([userId, price]) => ({
      id: `${id}-${userId}`,
      teamId: id,
      eventId: "event-1",
      userId,
      price,
      acquiredAt: STAMP,
      isCaptain: false,
      lotId: null,
    })),
  ];
  const spent = members.reduce((total, member) => total + member.price, 0);
  return {
    id,
    eventId: "event-1",
    name,
    nameIsCustom: true,
    captainUserId: captain,
    seed: null,
    balanceStart: 1000,
    sort: 0,
    createdAt: STAMP,
    members,
    balance: 1000 - spent,
    roster: rosterState({ id }, members, CONFIG, THREE_A_SIDE),
  };
}

/** Two teams, Red having paid for both of its players and Blue for one. */
function pricedTeams(): TeamWithRoster[] {
  return [
    team("t-red", "Rivals Red", "cap-red", [
      ["p-1", 300],
      ["p-2", 150],
    ]),
    team("t-blue", "Rivals Blue", "cap-blue", [["p-3", 0]]),
  ];
}

/** The same two teams, nobody having paid anything. */
function freeTeams(): TeamWithRoster[] {
  return [
    team("t-red", "Rivals Red", "cap-red", [
      ["p-1", 0],
      ["p-2", 0],
    ]),
    team("t-blue", "Rivals Blue", "cap-blue", [["p-3", 0]]),
  ];
}

function board(draft: boolean, teams: TeamWithRoster[]): EventBoard {
  return {
    teams,
    players,
    format: null,
    matches: [],
    rounds: null,
    draft,
    has: { teams: true, schedule: false, bracket: false, results: false },
  };
}

function text(subject: EventBoard): string {
  return renderToStaticMarkup(createElement(TeamsTab, { board: subject }))
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** The sentence under the cards, as far as its figure; the figure itself is asserted apart. */
const BALANCES_PARAGRAPH = "Every price is what that player actually went for at the draft";

/* ------------------------------------------------------------------ */
/* UC-51 1a — a drafted night, exactly as it was                       */
/* ------------------------------------------------------------------ */

describe("a drafted night", () => {
  it("prices every bought player on the roster", () => {
    const page = text(board(true, pricedTeams()));
    expect(page).toContain(`Cy ${formatMoney(300)}`);
    expect(page).toContain(`Di ${formatMoney(150)}`);
    expect(page).toContain(`Ed ${formatMoney(0)}`);
  });

  it("shows what each team has left on its card", () => {
    const page = text(board(true, pricedTeams()));
    expect(page).toContain(`Left ${formatMoney(550)} ${formatMoney(1000)} − ${formatMoney(450)} spent`);
    expect(page).toContain(`Left ${formatMoney(1000)} of ${formatMoney(1000)}`);
  });

  it("totals what was spent and names the top price", () => {
    const page = text(board(true, pricedTeams()));
    expect(page).toContain(`Total spent ${formatMoney(450)}`);
    expect(page).toContain(`Top price ${formatMoney(300)}`);
  });

  it("explains the balances under the cards, with the total they add up to", () => {
    const page = text(board(true, pricedTeams()));
    expect(page).toContain(BALANCES_PARAGRAPH);
    expect(page).toContain(`the figures add up to ${formatMoney(450)} spent across every team`);
  });
});

/* ------------------------------------------------------------------ */
/* UC-51 2 — a night with no draft                                     */
/* ------------------------------------------------------------------ */

describe("a night with no draft", () => {
  it("still shows every team and its roster — the result stays public", () => {
    const page = text(board(false, freeTeams()));
    expect(page).toContain("2 teams · 3 players drafted");
    expect(page).toContain("Rivals Red");
    expect(page).toContain("Rivals Blue");
    expect(page).toContain("Ada Captain Captain");
    expect(page).toContain("Bo Captain Captain");
    expect(page).toContain("Cy");
    expect(page).toContain("Di");
    expect(page).toContain("Ed");
    expect(page).toContain("3/3 on the roster Full");
    expect(page).toContain("2/3 on the roster 1 to fill");
    expect(page).toContain("Empty slot");
  });

  it("puts no price beside a player", () => {
    const page = text(board(false, freeTeams()));
    expect(page).not.toContain(`Cy ${formatMoney(0)}`);
    expect(page).not.toContain(`Di ${formatMoney(0)}`);
    expect(page).not.toContain(`Ed ${formatMoney(0)}`);
  });

  it("puts no balance on a card", () => {
    const page = text(board(false, freeTeams()));
    expect(page).not.toContain("Left");
    expect(page).not.toContain(formatMoney(1000));
  });

  it("shows no spent total", () => {
    // Nothing is ever spent on a night with no draft, and the total already
    // stays quiet at zero — so this test hands the tab priced teams under the
    // flag. The site cannot produce that board, but it is the one board that
    // tells "hidden because the flag is off" from "hidden because nothing was
    // spent", and the flag is what the tab must key on.
    const page = text(board(false, pricedTeams()));
    expect(page).not.toContain("Total spent");
    expect(page).not.toContain("Top price");
  });

  it("shows no paragraph explaining balances", () => {
    const page = text(board(false, pricedTeams()));
    expect(page).not.toContain(BALANCES_PARAGRAPH);
    expect(page).not.toContain("spent across every team");
  });
});

/* ------------------------------------------------------------------ */
/* UC-51 2a — drafted, and every price happens to be zero              */
/* ------------------------------------------------------------------ */

describe("a drafted night where every price is zero", () => {
  it("keeps the balance on every card — an auction was run, whatever it produced", () => {
    const page = text(board(true, freeTeams()));
    expect(page).toContain(`Left ${formatMoney(1000)} of ${formatMoney(1000)}`);
  });

  it("keeps the zero beside every bought player", () => {
    const page = text(board(true, freeTeams()));
    expect(page).toContain(`Cy ${formatMoney(0)}`);
    expect(page).toContain(`Di ${formatMoney(0)}`);
    expect(page).toContain(`Ed ${formatMoney(0)}`);
  });

  it("keeps the paragraph explaining balances, adding up to nothing", () => {
    const page = text(board(true, freeTeams()));
    expect(page).toContain(BALANCES_PARAGRAPH);
    expect(page).toContain(`the figures add up to ${formatMoney(0)} spent across every team`);
  });
});
