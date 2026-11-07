import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EventParticipants, RecordedPlacement } from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";

/*
 * Which subject the finishing order opens on — UC-52 2, 2a.
 *
 * The editor is told nothing: whether a teamed event's places are the teams'
 * or the players' is read off what is recorded, because the ids in the order
 * already say which it is. These tests render the three cases and assert
 * which boxes are offered. Switching is a click, and there is no DOM here, so
 * what is asserted is the state the screen opens in; the write it then makes
 * is `championship-results.test.ts`'s.
 *
 * The router and the action module are mocked for `table-order.test.ts`'s
 * reason: importing the actions would drag the database and the session into a
 * node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/actions", () => ({
  saveEventPlacementsAction: vi.fn(),
}));

const { default: PlacementEditor } = await import("../PlacementEditor");

const COUNTING: EventChampionship = {
  id: "counting-1",
  eventId: "event-1",
  title: "Rivals night",
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

/** Red (Ana, Ben) and Blue (Cal), as the draft left them. */
const TEAMED: EventParticipants = {
  teamed: true,
  rows: [
    {
      id: "red",
      name: "Red",
      members: [
        { userId: "ana", name: "Ana" },
        { userId: "ben", name: "Ben" },
      ],
    },
    { id: "blue", name: "Blue", members: [{ userId: "cal", name: "Cal" }] },
  ],
};

const SOLO: EventParticipants = {
  teamed: false,
  rows: [
    { id: "ana", name: "Ana", members: [{ userId: "ana", name: "Ana" }] },
    { id: "ben", name: "Ben", members: [{ userId: "ben", name: "Ben" }] },
  ],
};

function editor(participants: EventParticipants, placements: RecordedPlacement[]): string {
  return renderToStaticMarkup(
    createElement(PlacementEditor, {
      eventId: "event-1",
      counting: COUNTING,
      participants,
      placements,
    })
  );
}

/** The place boxes on the screen, by whose they are. */
function boxesIn(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]*?)(?:&#x27;|')s place"/g)].map((match) => match[1]);
}

/** Which of the two chips is lit, if the choice is offered at all. */
function litChoice(markup: string): string | null {
  const lit = /<button[^>]*aria-pressed="true"[^>]*>(A place for each \w+)</.exec(markup);
  return lit ? lit[1] : null;
}

describe("a teamed event's finishing order", () => {
  it("opens on the teams when nothing is recorded", () => {
    const markup = editor(TEAMED, []);

    expect(boxesIn(markup)).toEqual(["Red", "Blue"]);
    expect(litChoice(markup)).toBe("A place for each team");
    expect(markup).toContain("Type each team");
  });

  it("opens on the teams when the recorded places are the teams'", () => {
    const markup = editor(TEAMED, [{ id: "red", position: 1, kind: "team", name: "Red" }]);

    expect(boxesIn(markup)).toEqual(["Red", "Blue"]);
    expect(litChoice(markup)).toBe("A place for each team");
  });

  it("opens on the players when a recorded place is a player's", () => {
    // UC-52 2, read from what is recorded rather than stored anywhere.
    const markup = editor(TEAMED, [{ id: "ana", position: 1, kind: "member", name: "Ana" }]);

    expect(boxesIn(markup)).toEqual(["Ana", "Ben", "Cal"]);
    expect(litChoice(markup)).toBe("A place for each player");
    expect(markup).toContain("Type each player");
    // Ana's recorded place is in her box.
    expect(markup).toMatch(/aria-label="Ana(?:&#x27;|')s place"[^>]*value="1"/);
  });

  it("gives each player their team as the line under their name, not as a heading", () => {
    // Task 116 grouped the players under a heading per team; Task 117 took
    // the headings away, because a finishing order across teams cannot also
    // be grouped by team. The team is the row's second line instead, which is
    // what `placement-editor-order.test.ts` asserts in full. Held here too so
    // the subject tests cannot pass against a heading coming back.
    const markup = editor(TEAMED, [{ id: "ana", position: 1, kind: "member", name: "Ana" }]);

    expect(markup).not.toContain('<h3 class="eyebrow text-dim">Red</h3>');
    const ben = markup.search(/aria-label="Ben(?:&#x27;|')s place"/);
    const cal = markup.search(/aria-label="Cal(?:&#x27;|')s place"/);
    expect(markup.slice(ben, cal)).toContain(">Red</p>");
  });

  it("places nothing for a team with nobody on it", () => {
    // Task 116's "draws no heading for a team with nobody on it" retired with
    // the headings. What is left to hold is that an empty roster adds no box.
    const markup = editor(
      { ...TEAMED, rows: [...TEAMED.rows, { id: "grey", name: "Grey", members: [] }] },
      [{ id: "ana", position: 1, kind: "member", name: "Ana" }]
    );

    expect(boxesIn(markup)).toEqual(["Ana", "Ben", "Cal"]);
    expect(markup).not.toContain(">Grey<");
  });

  it("does not list the other subject's recorded places as people who have left", () => {
    // UC-52 4: the team places are what a player order replaces, not somebody
    // who withdrew — so they get no box, and the screen says they will go.
    const markup = editor(TEAMED, [
      { id: "red", position: 1, kind: "team", name: "Red" },
      { id: "ana", position: 1, kind: "member", name: "Ana" },
    ]);

    expect(boxesIn(markup)).toEqual(["Ana", "Ben", "Cal"]);
    expect(markup).not.toContain("No longer in the event");
    expect(markup).toContain("replaces the 1 place recorded for the teams");
  });
});

describe("an event with no teams", () => {
  it("is not offered the choice, and lists the players as before", () => {
    // UC-52 2a: every place is already a player's.
    const markup = editor(SOLO, [{ id: "ana", position: 2, kind: "member", name: "Ana" }]);

    expect(litChoice(markup)).toBeNull();
    expect(markup).not.toContain("A place for each");
    expect(boxesIn(markup)).toEqual(["Ana", "Ben"]);
    expect(markup).toContain("Type each player");
  });

  it("still shows a place recorded for somebody who has since left", () => {
    // Pinned: the current behaviour, which UC-52 must not disturb.
    const markup = editor(SOLO, [{ id: "dee", position: 3, kind: "member", name: "Dee" }]);

    expect(boxesIn(markup)).toEqual(["Ana", "Ben", "Dee"]);
    expect(markup).toContain("No longer in the event");
  });

  it("still shows who has left when everyone placed has since withdrawn", () => {
    // Task 116 pinned the literal empty `<ul>` this case used to draw above
    // "No longer in the event". Task 117 retired that pin: the list is now two
    // zones, drawn only when there is somebody to drag between them
    // (`placement-editor-order.test.ts`). What this case must still do is show
    // the place, with its box, and not call the event empty.
    const markup = editor({ teamed: false, rows: [] }, [
      { id: "dee", position: 1, kind: "member", name: "Dee" },
    ]);

    expect(markup).not.toContain("Nobody took part yet");
    expect(markup).toContain("No longer in the event");
    expect(boxesIn(markup)).toEqual(["Dee"]);
  });

  it("still shows a team's place when the teams have since been deleted", () => {
    // Pinned too: with no teams there is no other subject to replace, so a
    // team place left behind is somebody who has left, with a box, as before.
    const markup = editor(SOLO, [{ id: "red", position: 1, kind: "team", name: "Red" }]);

    expect(boxesIn(markup)).toEqual(["Ana", "Ben", "Red"]);
    expect(markup).toContain("No longer in the event");
    expect(markup).not.toContain("replaces the");
  });
});
