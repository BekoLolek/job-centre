import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HeroRole } from "@/db";
import HandReveal from "../HandReveal";
import type { RevealCard } from "../reveal";

/**
 * Task 144 — the sentences above a hand count the hand (R-271 / UC-58 7a).
 *
 * `perRole` is the event's width **as it was when the page loaded**. The cards
 * are whatever is stored. They can differ: a page opened at three, a manager
 * saving five, then the click — `dealFor` deals fifteen and the heading went
 * on saying "3 in each of 3 roles, so 9 in a hand" above them.
 *
 * So once there are cards, the count is theirs. The component holds one
 * `cards` state whether the hand arrived in the payload or from the click, and
 * the copy reads that state — which is why a hand handed in as `initialHand`
 * beside a disagreeing `perRole` is the same render the click produces, and
 * can be asserted without a browser.
 */

const ROLES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

function cardsOf(width: number): RevealCard[] {
  return ROLES.flatMap((role) =>
    Array.from({ length: width }, (_unused, index) => ({
      id: `${role}-${index}`,
      name: `${role} ${index + 1}`,
      role,
    }))
  );
}

function words(initialHand: RevealCard[] | null, perRole: number, seated = true): string {
  return renderToStaticMarkup(
    createElement(HandReveal, {
      initialHand,
      seated,
      format: { format: "6v6", comp: "2-2-2" } as never,
      roles: ROLES,
      perRole,
      draw: async () => ({ ok: false as const, error: "not called" }),
    })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

describe("the count above a hand", () => {
  it.each([
    [5, 15],
    [1, 3],
  ])(
    "is the hand's own when the page was loaded at three and %i in each role came back",
    (width, total) => {
      const said = words(cardsOf(width), 3);

      expect(said).toContain(`${width} in each of 3 roles, so ${total} in a hand`);
      expect(said).toContain(`These ${total} were decided`);
      expect(said).not.toContain("so 9 in a hand");
    }
  );

  it("is the event's while there is no hand to count", () => {
    const said = words(null, 5);

    expect(said).toContain("5 in each of 3 roles, so 15 in a hand");
    expect(said).toContain("Your 15 are decided");
    expect(said).toContain("Draw my 15");
  });
});

/**
 * Task 149 — the closing sentence is about a team, so it is only for somebody
 * on one. A hand shown to a holder whose seat has gone keeps "it stands" and
 * drops the invitation to compare with a team they are not part of.
 */
describe("the sentence under a held hand", () => {
  it("sends a seated holder to compare with their team", () => {
    const said = words(cardsOf(3), 3, true);

    expect(said).toContain("That is the hand, and it stands.");
    expect(said).toContain("Compare it with your team");
  });

  it("says the hand stands, and nothing about a team, to a holder with no seat", () => {
    const said = words(cardsOf(3), 3, false);

    expect(said).toContain("That is the hand, and it stands.");
    expect(said).not.toContain("Compare it with your team");
  });
});

/**
 * The same defect, one paragraph up: the line under the comp hands "who plays
 * what" to a room the reader is in. The comp itself is a fact about the night
 * and stays for everybody.
 */
describe("the sentence above a held hand", () => {
  it("leaves who plays what to a seated holder and their team", () => {
    const said = words(cardsOf(3), 3, true);

    expect(said).toContain("6v6 states a 2-2-2 comp.");
    expect(said).toContain("Who plays what is yours to settle once you can all see what you hold.");
  });

  it("states the comp, and settles nothing with a holder who has no seat", () => {
    const said = words(cardsOf(3), 3, false);

    expect(said).toContain("6v6 states a 2-2-2 comp.");
    expect(said).not.toContain("yours to settle");
  });
});
