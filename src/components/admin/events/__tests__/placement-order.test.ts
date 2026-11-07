import { describe, expect, it } from "vitest";
import { dropped, placeFrom, sequenceFor, typed, type Order } from "../placement-order";

/*
 * The rules a dragged finishing order follows — UC-33 3e, 3f, and the two
 * typing rules Task 117 states beside them.
 *
 * Tested as functions because the suite has no DOM to drop anything in: the
 * editor's `onDrop` and its move buttons each call one of these with the id
 * and the row it landed on, and `placement-editor-order.test.ts` asserts the
 * markup those calls are wired to. The `sequence` is the order zone as it
 * reads, top to bottom; `places` is every typed box, by row id, which is what
 * the save sends.
 */

function order(sequence: string[], places: Record<string, string>): Order {
  return { sequence, places };
}

describe("placeFrom", () => {
  it("reads a blank as nowhere, a number as itself and a word as not a number", () => {
    expect(placeFrom("")).toBeNull();
    expect(placeFrom("  ")).toBeNull();
    expect(placeFrom(" 3 ")).toBe(3);
    expect(placeFrom("1o")).toBeNaN();
  });
});

describe("sequenceFor — what the screen opens with", () => {
  it("lists the rows with a place in place order and leaves the rest out", () => {
    const sequence = sequenceFor(["ana", "ben", "cal", "dee"], {
      ana: "3",
      ben: "",
      cal: "1",
    });

    expect(sequence).toEqual(["cal", "ana"]);
  });

  it("keeps a tie in participant order, and puts a non-number last", () => {
    // Two who share a place read in the order they took part; "1o" is still
    // in the order (it is typed, and the refusal names it) but after everyone.
    const sequence = sequenceFor(["ana", "ben", "cal", "dee"], {
      ana: "1o",
      ben: "2",
      cal: "2",
      dee: "1",
    });

    expect(sequence).toEqual(["dee", "ben", "cal", "ana"]);
  });
});

describe("dropped — a row let go inside the order (UC-33 3e)", () => {
  it("renumbers the order 1, 2, 3 as it now reads", () => {
    const before = order(["ana", "ben", "cal"], { ana: "1", ben: "2", cal: "3" });

    const after = dropped(before, "cal", "ana");

    expect(after.sequence).toEqual(["cal", "ana", "ben"]);
    expect(after.places).toEqual({ ana: "2", ben: "3", cal: "1" });
  });

  it("drops a row from below into the order at the row it landed on", () => {
    const before = order(["ana", "ben"], { ana: "1", ben: "2", cal: "" });

    const after = dropped(before, "cal", "ben");

    expect(after.sequence).toEqual(["ana", "cal", "ben"]);
    expect(after.places).toEqual({ ana: "1", cal: "2", ben: "3" });
  });

  it("puts a row let go on the list itself, not on a row, at the end", () => {
    const before = order(["ana"], { ana: "1", ben: "" });

    const after = dropped(before, "ben", null);

    expect(after.sequence).toEqual(["ana", "ben"]);
    expect(after.places).toEqual({ ana: "1", ben: "2" });
  });

  it("breaks a tie, because a drag cannot say one", () => {
    // 3e: the tie is typed afterwards. Dropping leaves a strict 1, 2, 3 even
    // where two rows shared a place before.
    const before = order(["ana", "ben", "cal"], { ana: "1", ben: "1", cal: "3" });

    const after = dropped(before, "cal", "ben");

    expect(after.places).toEqual({ ana: "1", cal: "2", ben: "3" });
  });

  it("changes nothing when a row is let go on itself", () => {
    // Picked up and put straight back down, which happens constantly. It must
    // not fall to the bottom because the row it landed on is the one in hand.
    const before = order(["ana", "ben", "cal"], { ana: "1", ben: "1", cal: "3" });

    const after = dropped(before, "ana", "ana");

    expect(after).toEqual(before);
  });

  it("changes nothing when the row lands where it already was", () => {
    // The last row let go on the "last in the order" slot. No new index, so
    // no renumbering either — Ana and Ben's typed tie is not broken by a
    // drop that moved nobody.
    const before = order(["ana", "ben"], { ana: "1", ben: "1" });

    const after = dropped(before, "ben", null);

    expect(after).toEqual(before);
  });

  it("leaves a box outside the order alone", () => {
    // Somebody no longer in the event has a typed box but no row to drag;
    // renumbering the order must not touch it.
    const before = order(["ana", "ben"], { ana: "1", ben: "2", dee: "7" });

    const after = dropped(before, "ben", "ana");

    expect(after.places.dee).toBe("7");
  });
});

describe("typed — a number put in a box", () => {
  it("changes only that row's place when the row is already in the order, after a drag", () => {
    // The tie is reachable after a drop: Cal dragged to the top makes
    // Cal, Ana, Ben = 1, 2, 3, and Ben typed to 1 then sits level with Cal
    // without moving. A fixture that was still in number order could not
    // tell this from a re-sort — Ben sorting level with Ana lands him back
    // where he was — so the row typed is one a re-sort would relocate.
    const dragged = dropped(
      order(["ana", "ben", "cal"], { ana: "1", ben: "2", cal: "3" }),
      "cal",
      "ana"
    );

    const after = typed(dragged, "ben", "1");

    expect(after.sequence).toEqual(["cal", "ana", "ben"]);
    expect(after.places).toEqual({ cal: "1", ana: "2", ben: "1" });
  });

  it("moves a row from below into the order at the place typed", () => {
    const before = order(["ana", "cal"], { ana: "1", ben: "", cal: "3" });

    const after = typed(before, "ben", "2");

    expect(after.sequence).toEqual(["ana", "ben", "cal"]);
    expect(after.places).toEqual({ ana: "1", ben: "2", cal: "3" });
  });

  it("puts a row typed level with another after it", () => {
    // Typed 1 from below with Ana already on 1: a tie, read in the order it
    // was made — Ana first — and nobody renumbered.
    const before = order(["ana", "cal"], { ana: "1", ben: "", cal: "2" });

    const after = typed(before, "ben", "1");

    expect(after.sequence).toEqual(["ana", "ben", "cal"]);
    expect(after.places).toEqual({ ana: "1", ben: "1", cal: "2" });
  });

  it("takes a row out of the order when its box is cleared (UC-33 3f)", () => {
    // Dragging out and clearing the box are the same change: took part,
    // finished nowhere. The others keep their numbers — the gap is the
    // manager's to close, because closing it would break a tie they typed.
    const before = order(["ana", "ben", "cal"], { ana: "1", ben: "2", cal: "3" });

    const after = typed(before, "ben", "");

    expect(after.sequence).toEqual(["ana", "cal"]);
    expect(after.places).toEqual({ ana: "1", ben: "", cal: "3" });
  });

  it("puts a non-number typed from below into the order, last", () => {
    // "1o" is in the order — it is typed, and `positionProblem` refuses the
    // save by name — but it cannot be placed among the numbers.
    const before = order(["ana"], { ana: "1", ben: "" });

    const after = typed(before, "ben", "1o");

    expect(after.sequence).toEqual(["ana", "ben"]);
  });
});
