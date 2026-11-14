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

function words(initialHand: RevealCard[] | null, perRole: number): string {
  return renderToStaticMarkup(
    createElement(HandReveal, {
      initialHand,
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
