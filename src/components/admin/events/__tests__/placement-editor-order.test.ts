import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EventParticipants, RecordedPlacement } from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";

/*
 * The two zones of the finishing order — UC-33 3e, 3f (Task 117).
 *
 * "In the order" holds the rows with a place, as they read; "Took part, not
 * placed" holds the rest. Dragging between them is the feature, and there is
 * no DOM here to drag in, so what is asserted is the state the screen opens
 * with and the controls it offers: which rows sit in which zone, that every
 * row in the order has a visible up/down control naming it at the 44px floor,
 * and that a drag handle is offered when the season is open and not when it is
 * closed. The rules the controls call are `placement-order.test.ts`'s.
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

const SOLO: EventParticipants = {
  teamed: false,
  rows: [
    { id: "ana", name: "Ana", members: [{ userId: "ana", name: "Ana" }] },
    { id: "ben", name: "Ben", members: [{ userId: "ben", name: "Ben" }] },
    { id: "cal", name: "Cal", members: [{ userId: "cal", name: "Cal" }] },
  ],
};

/** Red (Ana, Ben) and Blue (Cal, Dee): two of each, so adjacency can be seen. */
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
    {
      id: "blue",
      name: "Blue",
      members: [
        { userId: "cal", name: "Cal" },
        { userId: "dee", name: "Dee" },
      ],
    },
  ],
};

function editor(
  participants: EventParticipants,
  placements: RecordedPlacement[],
  status: EventChampionship["season"]["status"] = "published"
): string {
  return renderToStaticMarkup(
    createElement(PlacementEditor, {
      eventId: "event-1",
      counting: { ...COUNTING, season: { ...COUNTING.season, status } },
      participants,
      placements,
    })
  );
}

const IN_ORDER = '<h3 class="eyebrow text-dim">In the order</h3>';
const NOT_PLACED = '<h3 class="eyebrow text-dim">Took part, not placed</h3>';

/** The place boxes between two points of the markup, by whose they are. */
function boxesBetween(markup: string, from: number, to: number): string[] {
  return [...markup.slice(from, to).matchAll(/aria-label="([^"]*?)(?:&#x27;|')s place"/g)].map(
    (match) => match[1]
  );
}

/** The boxes in each zone, in the order they read. */
function zones(markup: string): { ordered: string[]; unplaced: string[] } {
  const order = markup.indexOf(IN_ORDER);
  const rest = markup.indexOf(NOT_PLACED);
  const left = markup.indexOf("No longer in the event");
  expect(order).toBeGreaterThan(-1);
  expect(rest).toBeGreaterThan(order);
  return {
    ordered: boxesBetween(markup, order, rest),
    unplaced: boxesBetween(markup, rest, left === -1 ? markup.length : left),
  };
}

/** The opening tag of the button whose label this is, or null. */
function control(markup: string, label: string): string | null {
  const hit = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup);
  return hit ? hit[0] : null;
}

describe("the two zones", () => {
  it("opens with the placed rows in place order and the rest below, in participant order", () => {
    const markup = editor(SOLO, [
      { id: "cal", position: 1, kind: "member", name: "Cal" },
      { id: "ana", position: 2, kind: "member", name: "Ana" },
    ]);

    expect(zones(markup)).toEqual({ ordered: ["Cal", "Ana"], unplaced: ["Ben"] });
    // The recorded place is in its box.
    expect(markup).toMatch(/aria-label="Cal(?:&#x27;|')s place"[^>]*value="1"/);
  });

  it("says what each zone is for when it is empty", () => {
    // UC-33 3b, named on the screen for the first time: nobody placed is a
    // real state, and so is everybody placed.
    const nobody = editor(SOLO, []);
    expect(zones(nobody)).toEqual({ ordered: [], unplaced: ["Ana", "Ben", "Cal"] });
    expect(nobody).toContain("Nobody is placed yet");
    expect(nobody).not.toContain("Everybody has a place");

    const everybody = editor(
      SOLO,
      SOLO.rows.map((row, index) => ({
        id: row.id,
        position: index + 1,
        kind: "member" as const,
        name: row.name,
      }))
    );
    expect(zones(everybody)).toEqual({ ordered: ["Ana", "Ben", "Cal"], unplaced: [] });
    expect(everybody).toContain("Everybody has a place");
    expect(everybody).not.toContain("Nobody is placed yet");
  });

  it("keeps both zones in one list, so a row crossing between them is moved, not remade", () => {
    /*
     * React does not carry a key across parents: two `<ul>`s would unmount a
     * row the moment its box took it over the line, destroying the input
     * under the caret — "12" typed from below would commit "1" and lose the
     * "2". So the zones are one list with the lower heading as a row of it,
     * and that is a fact about the markup: one `<ul>`, the heading inside an
     * `<li>`, the placed rows before it and the rest after.
     */
    const markup = editor(SOLO, [
      { id: "cal", position: 1, kind: "member", name: "Cal" },
      { id: "ana", position: 2, kind: "member", name: "Ana" },
    ]);

    expect(markup.match(/<ul\b/g)).toHaveLength(1);
    const heading = markup.indexOf(NOT_PLACED);
    expect(markup.lastIndexOf("<li", heading)).toBeGreaterThan(markup.lastIndexOf("</ul>", heading));
    expect(markup.slice(markup.lastIndexOf("<li", heading), heading)).not.toContain("</li>");
    expect(zones(markup)).toEqual({ ordered: ["Cal", "Ana"], unplaced: ["Ben"] });
  });

  it("draws no zones when nobody is in the event, only who has left", () => {
    // Replaces Task 116's pin of the literal empty `<ul>`: with no rows there
    // is nothing to drag, so the zones are not drawn and the left-over block
    // stands alone with its box.
    const markup = editor({ teamed: false, rows: [] }, [
      { id: "dee", position: 1, kind: "member", name: "Dee" },
    ]);

    expect(markup).not.toContain(IN_ORDER);
    expect(markup).not.toContain(NOT_PLACED);
    expect(markup).toContain("No longer in the event");
    expect(boxesBetween(markup, 0, markup.length)).toEqual(["Dee"]);
    expect(markup).not.toContain("Nobody took part yet");
  });

  it("keeps somebody who has left out of both zones", () => {
    const markup = editor(SOLO, [{ id: "dee", position: 1, kind: "member", name: "Dee" }]);

    expect(zones(markup)).toEqual({ ordered: [], unplaced: ["Ana", "Ben", "Cal"] });
    expect(markup).toContain("No longer in the event");
    expect(control(markup, "Move Dee up")).toBeNull();
  });
});

describe("a teamed event's players", () => {
  it("read as one list with their team on the second line, teammates adjacent", () => {
    const markup = editor(TEAMED, [{ id: "cal", position: 1, kind: "member", name: "Cal" }]);

    expect(zones(markup)).toEqual({ ordered: ["Cal"], unplaced: ["Ana", "Ben", "Dee"] });
    // No heading per team any more — the team is a line under the name.
    expect(markup).not.toContain('<h3 class="eyebrow text-dim">Red</h3>');
    expect(markup).not.toContain('<h3 class="eyebrow text-dim">Blue</h3>');
    const ben = markup.search(/aria-label="Ben(?:&#x27;|')s place"/);
    const dee = markup.search(/aria-label="Dee(?:&#x27;|')s place"/);
    expect(markup.slice(ben, dee)).toContain(">Red</p>");
    expect(markup.slice(dee)).toContain(">Blue</p>");
  });

  it("still says who a team's place pays when the teams are the subject", () => {
    const markup = editor(TEAMED, []);

    expect(zones(markup)).toEqual({ ordered: [], unplaced: ["Red", "Blue"] });
    expect(markup).toContain(">Ana, Ben</p>");
  });
});

describe("moving without a mouse", () => {
  const PLACED: RecordedPlacement[] = [
    { id: "ana", position: 1, kind: "member", name: "Ana" },
    { id: "ben", position: 2, kind: "member", name: "Ben" },
  ];

  it("gives every row in the order an up and a down control that names it", () => {
    const markup = editor(SOLO, PLACED);

    expect(control(markup, "Move Ana up")).toContain("disabled");
    expect(control(markup, "Move Ana down")).not.toContain("disabled");
    expect(control(markup, "Move Ben up")).not.toContain("disabled");
    expect(control(markup, "Move Ben down")).toContain("disabled");
    // Not placed: nothing to move among. Typing a place is how Cal gets in.
    expect(control(markup, "Move Cal up")).toBeNull();
    expect(control(markup, "Move Cal down")).toBeNull();
  });

  it.each(["Move Ana up", "Move Ana down", "Move Ben up", "Move Ben down"])(
    "sizes %s at the 44px floor",
    (label) => {
      const markup = editor(SOLO, PLACED);

      const classes = /class="([^"]*)"/.exec(control(markup, label)!)![1].split(/\s+/);
      expect(classes).toContain("min-h-11");
      expect(classes).toContain("min-w-11");
    }
  );

  it("offers a drag handle on every row while the season is open", () => {
    const markup = editor(SOLO, PLACED);

    expect(markup.match(/draggable="true"/g)).toHaveLength(SOLO.rows.length);
  });

  it("offers neither handle nor move when the season is closed", () => {
    const markup = editor(SOLO, PLACED, "closed");

    expect(markup).not.toContain('draggable="true"');
    expect(control(markup, "Move Ana down")).toContain("disabled");
    expect(control(markup, "Move Ben up")).toContain("disabled");
  });
});
