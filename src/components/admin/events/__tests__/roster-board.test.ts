import { describe, expect, it } from "vitest";
import type { RosterMove } from "@/app/admin/events/draft-actions";
import { type BoardMove, boardOf, moveFor } from "../roster-board";

/*
 * The rules a card follows when it is let go on the Rosters board — R-257,
 * R-260 / UC-53 3, 3b, 5 (Task 121).
 *
 * The suite has no DOM to drop a card in, so the decisions are here, over
 * plain data: which write a drop asks for, which drops ask for none, and what
 * the board reads as while a write is in flight. That the tab's handlers obey
 * them is `teams-tab-board.test.ts`'s.
 */

function row(teamId: string, userId: string, over: Partial<RosterMove> = {}): RosterMove {
  return { teamId, userId, price: 0, isCaptain: false, ...over };
}

/** Alpha holds its captain and Pat; Bravo holds its captain. Free is on no team. */
const ROSTERS: RosterMove[] = [
  row("team-a", "cap-a", { isCaptain: true }),
  row("team-a", "pat"),
  row("team-b", "cap-b", { isCaptain: true }),
];

const QUIET = { rosters: ROSTERS, pending: [] as BoardMove[] };
const BOTH = ["team-a", "team-b"];

describe("what a drop asks the server for", () => {
  it("places somebody from the unplaced list on the team they were let go on", () => {
    expect(moveFor(QUIET, "free", "team-b", BOTH)).toEqual({
      kind: "place",
      userId: "free",
      teamId: "team-b",
    });
  });

  it("moves somebody already on a team with the same write, aimed at the new team", () => {
    expect(moveFor(QUIET, "pat", "team-b", ["team-b"])).toEqual({
      kind: "place",
      userId: "pat",
      teamId: "team-b",
    });
  });

  it("removes somebody let go on the unplaced list, naming the team they are leaving", () => {
    // `removeFromRoster` refuses unless the team matches the row, so the team
    // sent is the one they are on — not the one the drag passed over last.
    expect(moveFor(QUIET, "pat", null, ["team-b"])).toEqual({
      kind: "remove",
      userId: "pat",
      teamId: "team-a",
    });
  });
});

describe("the drops that ask for nothing (UC-53 3b)", () => {
  it("is no move when a card is let go on the team it is already on", () => {
    // Offered as open on purpose: the answer has to come from where the card
    // is, not from the team happening to be left out of the list.
    expect(moveFor(QUIET, "pat", "team-a", BOTH)).toBeNull();
  });

  it("is no move when an unplaced card is let go on the unplaced list", () => {
    expect(moveFor(QUIET, "free", null, BOTH)).toBeNull();
  });

  it("is no move onto a team the screen does not offer — a full one", () => {
    expect(moveFor(QUIET, "free", "team-a", ["team-b"])).toBeNull();
  });
});

describe("a second move of somebody whose first is still in flight", () => {
  const flying: BoardMove = { kind: "place", userId: "free", teamId: "team-b" };
  const busy = { rosters: ROSTERS, pending: [flying] };

  it("is no move at all — the first one stands until the server has answered it", () => {
    expect(moveFor(busy, "free", "team-a", BOTH)).toBeNull();
    expect(moveFor(busy, "free", null, BOTH)).toBeNull();
  });

  it("holds back that player only — anybody else still moves", () => {
    expect(moveFor(busy, "pat", "team-b", ["team-b"])).toEqual({
      kind: "place",
      userId: "pat",
      teamId: "team-b",
    });
  });
});

describe("the board while writes are in flight (R-260)", () => {
  it("puts a placed card on its team at once, as an ordinary roster row", () => {
    const board = boardOf(ROSTERS, [{ kind: "place", userId: "free", teamId: "team-b" }]);

    expect(board).toEqual([...ROSTERS, row("team-b", "free")]);
  });

  it("moves a card between teams by changing its team and nothing else about it", () => {
    const paid = [row("team-a", "pat", { price: 40 }), row("team-a", "quin")];

    const board = boardOf(paid, [{ kind: "place", userId: "pat", teamId: "team-b" }]);

    // Same position, same price: the row is moved, not re-made.
    expect(board).toEqual([row("team-b", "pat", { price: 40 }), row("team-a", "quin")]);
  });

  it("takes a removed card off its team at once", () => {
    const board = boardOf(ROSTERS, [{ kind: "remove", userId: "pat", teamId: "team-a" }]);

    expect(board).toEqual([ROSTERS[0], ROSTERS[2]]);
  });

  it("carries several players' moves together", () => {
    const board = boardOf(ROSTERS, [
      { kind: "place", userId: "free", teamId: "team-b" },
      { kind: "remove", userId: "pat", teamId: "team-a" },
    ]);

    expect(board).toEqual([ROSTERS[0], ROSTERS[2], row("team-b", "free")]);
  });

  it("leaves the saved rosters themselves alone, so a refusal has somewhere to return to", () => {
    const before = structuredClone(ROSTERS);

    boardOf(ROSTERS, [
      { kind: "place", userId: "pat", teamId: "team-b" },
      { kind: "remove", userId: "cap-b", teamId: "team-b" },
    ]);

    expect(ROSTERS).toEqual(before);
  });
});
