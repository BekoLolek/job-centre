import { describe, expect, it } from "vitest";
import { type ConfirmationTodoInput, confirmationTodo } from "../todos";

/*
 * The "still coming?" to-do on `/me` (R-56, R-199, R-200).
 *
 * `/me`'s own header states the rule this file enforces: every to-do is
 * derived, and "a 'confirm your attendance' nudge that outlived the
 * confirmation would be worse than no nudge at all". R-200 gives it a second
 * way to outlive its usefulness — the answer closing — and R-199 gives it a
 * new reason to exist, the maybe nobody will resolve on the member's behalf.
 *
 * Both are one-line conditions, which is exactly why they are tested: either
 * can be inverted or deleted without anything else in the suite noticing, and
 * the result on screen is a nudge that does nothing or a seat nobody chases.
 */

const NOW = new Date("2026-05-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const WITHIN = 7 * DAY;

/** A seat four days out: inside the nudge window, before the deadline. */
function input(over: Partial<ConfirmationTodoInput> = {}): ConfirmationTodoInput {
  return {
    status: "accepted",
    confirmation: null,
    startsAt: new Date(NOW.getTime() + 4 * DAY),
    within: WITHIN,
    now: NOW,
    ...over,
  };
}

describe("while the answer is still open", () => {
  it("asks an unanswered seat holder to answer", () => {
    expect(confirmationTodo(input())).toBe("answer");
  });

  it("asks somebody sitting on a maybe to settle it", () => {
    // R-199's cost, and the thing that pays it: nothing in the site resolves a
    // maybe (UC-13 extensions E4), so if this page does not chase it, nobody
    // does and a seat rides on it until the night.
    expect(confirmationTodo(input({ confirmation: "maybe" }))).toBe("settle");
  });

  it("asks nothing of somebody who has settled it either way", () => {
    expect(confirmationTodo(input({ confirmation: "in" }))).toBeNull();
    expect(confirmationTodo(input({ confirmation: "out" }))).toBeNull();
  });

  it("waits until the event is close enough to be worth asking about", () => {
    expect(confirmationTodo(input({ startsAt: new Date(NOW.getTime() + 8 * DAY) }))).toBeNull();
    expect(confirmationTodo(input({ startsAt: new Date(NOW.getTime() + WITHIN) }))).toBe("answer");
  });

  it("asks only somebody holding a seat", () => {
    for (const status of ["waitlisted", "pending", "declined", "withdrawn"] as const) {
      expect(confirmationTodo(input({ status }))).toBeNull();
    }
  });
});

describe("once the answer has closed", () => {
  // Two days before the start, R-200. A nudge here would be asking the member
  // to do something `setConfirmation` refuses (UC-13 5c).
  const inside = { startsAt: new Date(NOW.getTime() + DAY) };

  it("asks nothing of somebody who never answered", () => {
    expect(confirmationTodo(input({ ...inside }))).toBeNull();
  });

  it("asks nothing of somebody still on a maybe", () => {
    // It is still unresolved, and still visible to the admin — but it is no
    // longer *theirs* to resolve, so it is not a to-do. Withdrawing is still
    // open; that is a decision on /me/events, not an outstanding job here.
    expect(confirmationTodo(input({ ...inside, confirmation: "maybe" }))).toBeNull();
  });

  it("asks nothing on the day either", () => {
    expect(confirmationTodo(input({ startsAt: NOW }))).toBeNull();
  });

  it("is open right up to the deadline and shut just past it", () => {
    const deadlineStart = new Date(NOW.getTime() + 2 * DAY);
    expect(confirmationTodo(input({ startsAt: deadlineStart }))).toBe("answer");
    expect(
      confirmationTodo(input({ startsAt: new Date(deadlineStart.getTime() - 60_000) }))
    ).toBeNull();
  });
});

describe("an event nobody has scheduled", () => {
  it("is never a to-do, and is never locked out either", () => {
    // UC-13 7a. No start means no deadline *and* nothing to be close to, so
    // the answer keeps — which is the opposite of the bug where a null start
    // reads as "closed" and the member can never answer at all.
    expect(confirmationTodo(input({ startsAt: null }))).toBeNull();
    expect(confirmationTodo(input({ startsAt: null, confirmation: "maybe" }))).toBeNull();
  });
});
