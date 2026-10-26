import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FinishingOrder } from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import type { ChampionshipTabData } from "../types";

/*
 * The championship panel over a round-scored night — UC-46 5, 5b, and the
 * decision Task 91 owes about a hand-typed order the night has outgrown.
 *
 * The panel does not hide: "where did these places come from" is the question
 * an admin will ask, and the answer is the table, read-only, with the total
 * beside each place and the Results tab named as the place to correct one. The
 * typed editor is what an ordinary night still gets, asserted here too so the
 * branch is held from both sides.
 *
 * The router and the action module are mocked for `teams-tab-placement.test.ts`'s
 * reason: importing the actions would drag the database and the session into a
 * node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/actions", () => ({
  addEventToChampionshipAction: vi.fn(),
  removeEventFromChampionshipAction: vi.fn(),
  saveEventChampionshipAction: vi.fn(),
  saveEventPlacementsAction: vi.fn(),
}));

const { default: ChampionshipTab } = await import("../ChampionshipTab");

const COUNTING: EventChampionship = {
  id: "counting-1",
  eventId: "event-1",
  title: "Popsauce night",
  weight: 1,
  pointsTable: null,
  season: {
    id: "season-1",
    name: "Autumn season",
    status: "published",
    pointsTable: [25, 18, 15],
    participationPoints: 1,
    countBest: null,
  },
};

const PLAYERS = {
  teamed: false,
  rows: [
    { id: "ana", name: "Ana", members: [{ userId: "ana", name: "Ana" }] },
    { id: "ben", name: "Ben", members: [{ userId: "ben", name: "Ben" }] },
    { id: "cal", name: "Cal", members: [{ userId: "cal", name: "Cal" }] },
  ],
};

/** A night's table: Ana and Ben level on 20, Cal third on 13. */
const TABLE: FinishingOrder = {
  source: "table",
  places: [
    { id: "ana", position: 1, kind: "member", name: "Ana", total: 20 },
    { id: "ben", position: 1, kind: "member", name: "Ben", total: 20 },
    { id: "cal", position: 3, kind: "member", name: "Cal", total: 13 },
  ],
  shadowed: [],
};

function panel(order: FinishingOrder): string {
  const data: ChampionshipTabData = {
    counting: COUNTING,
    seasons: [],
    result: { participants: PLAYERS, order },
  };
  return renderToStaticMarkup(createElement(ChampionshipTab, { eventId: "event-1", data }));
}

describe("the championship panel over a round-scored night", () => {
  it("shows the derived order read-only, with the total beside each place", () => {
    const markup = panel(TABLE);

    const ana = markup.indexOf("Ana");
    const ben = markup.indexOf("Ben");
    const cal = markup.indexOf("Cal");
    expect(ana).toBeGreaterThan(-1);
    expect(ben).toBeGreaterThan(ana);
    expect(cal).toBeGreaterThan(ben);
    // 1st twice, 3rd once, and never a 2nd: the tie is shown as the table has it.
    expect(markup.match(/>1st</g)).toHaveLength(2);
    expect(markup).toContain(">3rd<");
    expect(markup).not.toContain(">2nd<");
    expect(markup).toContain("20");
    expect(markup).toContain("13");
    // Nothing to type: no place box for anybody, and no instruction to type one.
    // (The weight box above the order is still an input, so "no input at all"
    // would be the wrong assertion.)
    expect(markup).not.toMatch(/aria-label="[^"]*s place"/);
    expect(markup).not.toContain("Type each");
  });

  it("says where the places came from and where to correct one", () => {
    const markup = panel(TABLE);

    expect(markup).toContain("scored in rounds");
    expect(markup).toContain("Results tab");
    expect(markup).toContain("/admin/events/event-1?tab=results");
    expect(markup).toContain("correct the round");
  });

  it("says a night with no round scored yet has no places yet", () => {
    const markup = panel({ source: "table", places: [], shadowed: [] });

    expect(markup).toContain("No round has been scored yet");
    expect(markup).not.toContain(">1st<");
  });

  it("names a hand-typed order the night has outgrown, and says it is kept but not read", () => {
    const markup = panel({
      ...TABLE,
      shadowed: [
        { id: "cal", position: 1, kind: "member", name: "Cal" },
        { id: "ana", position: 2, kind: "member", name: "Ana" },
      ],
    });

    expect(markup).toContain("typed by hand");
    expect(markup).toContain("2 places");
    expect(markup).toContain("Cal 1st, Ana 2nd");
    expect(markup).toContain("kept but not read");
  });

  it("says nothing about a typed order when there is none to shadow", () => {
    const markup = panel(TABLE);

    expect(markup).not.toContain("typed by hand");
    expect(markup).not.toContain("kept but not read");
  });
});

describe("the championship panel over an ordinary night", () => {
  it("still offers the typed order, and says nothing about rounds", () => {
    const markup = panel({
      source: "typed",
      places: [{ id: "ana", position: 1, kind: "member", name: "Ana" }],
    });

    expect(markup).toContain("Type each player");
    expect(markup).toMatch(/aria-label="Ana(&#x27;|')s place"/);
    expect(markup).not.toContain("scored in rounds");
    expect(markup).not.toContain("typed by hand");
  });
});
