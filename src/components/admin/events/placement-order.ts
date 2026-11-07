/**
 * The rules a finishing order follows when it is dragged or typed — UC-33 3e,
 * 3f, and the two typing rules beside them (R-256, Task 117).
 *
 * ## Why this is its own module
 *
 * For `readiness.ts`'s reason, in this same folder: a pure function of the
 * state, kept out of the component that renders it, so what the screen does
 * is exactly what the rule says and the awkward cases — a tie typed after a
 * drag, a row let go on itself, a non-number — are cheap to test. The suite
 * has no DOM to drop a row in; the editor's `onDrop` and move buttons each
 * call one of these, and the markup they are wired to is asserted separately.
 *
 * ## Two things, held together
 *
 * `places` is every typed box, by row id — what the save sends, and the only
 * thing it sends. `sequence` is the order zone as it reads, top to bottom:
 * exactly the rows on the screen whose box is not blank. The functions below
 * change the two together, so a row's box and its zone cannot disagree. The
 * one write outside them is the editor's `set`, for somebody who has since
 * left the event: they have a box in `places` but no row to drag, so they are
 * in neither zone and must never enter the sequence — which is why `set`
 * writes `places` alone rather than going through `typed`.
 *
 * The sequence is **not** derived from the numbers on every render, and that
 * is the point. A number typed into a row already in the order changes that
 * row's number and moves nothing — which is how a tie is still reachable after
 * a drag has made everything strict. A drop, on the other hand, renumbers the
 * whole order 1, 2, 3 from the sequence, because a drag cannot say anything
 * but a strict order (3e).
 */

export type Order = {
  /** Every typed box, by row id — a team's or a member's, or somebody who has left. */
  places: Record<string, string>;
  /** The rows in the order zone, as they read: the rows on the screen with a non-blank box. */
  sequence: string[];
};

/**
 * A typed box as a place: `null` for blank, which is "took part, finished
 * nowhere" (UC-33 3b), and `NaN` for "1o", which `positionProblem` refuses
 * rather than reading as a zero nobody typed.
 */
export function placeFrom(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Where a box sorts: its number, or after every number for one that is not one. */
function sortKey(place: number): number {
  return Number.isNaN(place) ? Number.POSITIVE_INFINITY : place;
}

/**
 * The order zone as the screen opens: the rows with a box, in place order.
 * Two who share a place read in participant order, which is the order the
 * rows arrive in.
 */
export function sequenceFor(ids: string[], places: Record<string, string>): string[] {
  return ids
    .map((id) => ({ id, place: placeFrom(places[id] ?? "") }))
    .filter((row): row is { id: string; place: number } => row.place !== null)
    .sort((a, b) => sortKey(a.place) - sortKey(b.place))
    .map((row) => row.id);
}

/**
 * A row let go inside the order (UC-33 3e) — from elsewhere in it, or from
 * below. It lands before `before`, or last when it was let go on the slot
 * after the last row, and the order renumbers 1, 2, 3 as it now reads. A
 * drop that moved nobody — the row let go on itself, or the last row let go
 * on the slot — changes nothing, numbers included: there is no new index to
 * renumber from, and a tie typed before it must survive a non-move. Boxes
 * outside the order — somebody who has since left — are not touched.
 */
export function dropped(order: Order, id: string, before: string | null): Order {
  if (before === id) return order;
  const sequence = order.sequence.filter((other) => other !== id);
  const at = before === null ? -1 : sequence.indexOf(before);
  sequence.splice(at === -1 ? sequence.length : at, 0, id);
  if (sequence.every((other, index) => other === order.sequence[index])) return order;

  const places = { ...order.places };
  sequence.forEach((other, index) => {
    places[other] = String(index + 1);
  });
  return { places, sequence };
}

/**
 * A number put in a box. In the order already: that row's number changes and
 * nothing moves. Below: the row joins the order after the last row whose
 * number is not above it. Cleared: the row leaves the order (UC-33 3f), and
 * the others keep their numbers. Taking somebody out is a change to their box
 * and should not rewrite everybody else's, and it keeps a drag out identical
 * to clearing the box, which is the same operation through the other hand.
 * The visible consequence is a gap — 1, _, 3 pays third-place points with
 * nobody second — which the manager can see in the boxes, and which the next
 * drop closes when it renumbers densely.
 */
export function typed(order: Order, id: string, value: string): Order {
  const places = { ...order.places, [id]: value };
  const place = placeFrom(value);

  if (place === null) {
    return { places, sequence: order.sequence.filter((other) => other !== id) };
  }
  if (order.sequence.includes(id)) {
    return { places, sequence: order.sequence };
  }

  // After the last row whose number is not above the one typed.
  const key = sortKey(place);
  const at = order.sequence.findLastIndex((other) => {
    const existing = placeFrom(places[other] ?? "");
    return existing !== null && sortKey(existing) <= key;
  });
  const sequence = [...order.sequence];
  sequence.splice(at + 1, 0, id);
  return { places, sequence };
}
