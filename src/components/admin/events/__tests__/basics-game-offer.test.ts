import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { webAddressRefusal } from "@/lib/events-policy";
import type { GameOption } from "../types";
import { applicantsEvent } from "./applicants-fixture";

/**
 * The Basics tab's Game picker, and the web address beside it.
 *
 * ## Which games it may offer (R-132 / UC-03 E2)
 *
 * > **E2.** Admin hides a game — System stops offering it for **new events**,
 * > host applications and profiles; existing events, answers and history keep
 * > it.
 *
 * `hostableGames` holds the first half for host applications and `loadProfile`
 * for profiles. This screen — the one place an event is actually given a game
 * — did not, and it even labelled the offer `(hidden)`, which reads as an
 * explanation rather than as the bug it was: a manager picking a game off this
 * list would have published an event in a game the catalogue has withdrawn,
 * whose profile section nobody can fill in any more (`saveProfileSection`
 * refuses an inactive game outright).
 *
 * Both halves are asserted, because the second is what stops the fix being a
 * narrower read: an event that already belongs to a hidden game keeps it, or
 * opening this tab on one would show an empty Game box and the next save
 * would quietly detach the event from its own game.
 *
 * ## The web address (R-114 / UC-08 E2a)
 *
 * The box used to run `slugify` over whatever had been typed on blur, so an
 * address with a space in it became a different address with nothing said.
 * The server now refuses it by name and the box says so before the save —
 * `webAddressRefusal`, the server's own sentence. Asserted here because "the
 * rule is on screen" is a claim about this component.
 *
 * Mocked as `src/components/me/__tests__/answers-lock.test.ts` mocks: the
 * router hook throws outside a mounted router, and importing the action module
 * would drag the database and the session into a node test that only wants
 * markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/actions", () => ({
  saveBasicsAction: vi.fn(),
}));

const { default: BasicsTab } = await import("../BasicsTab");

function game(over: Partial<GameOption> = {}): GameOption {
  return { id: "game-1", name: "Marvel Rivals", isActive: true, rankLadder: [], ...over };
}

const ACTIVE = game({ id: "active-1", name: "Marvel Rivals" });
const HIDDEN = game({ id: "hidden-1", name: "Old Shooter", isActive: false });

/** The rendered tab, markup and all — `<option>` values matter here. */
function markup(
  games: GameOption[],
  event: Partial<Parameters<typeof applicantsEvent>[1]> = {}
): string {
  return renderToStaticMarkup(
    createElement(BasicsTab, { event: applicantsEvent([], event), games })
  );
}

/** The rendered tab as a manager reads it: no tags, no entities. */
function text(
  games: GameOption[],
  event: Partial<Parameters<typeof applicantsEvent>[1]> = {}
): string {
  return markup(games, event)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** Is this game offered as a choice at all? */
function offers(games: GameOption[], id: string, event = {}): boolean {
  return markup(games, event).includes(`value="${id}"`);
}

describe("UC-03 E2: the Game picker and a hidden game", () => {
  it("offers an active game", () => {
    expect(offers([ACTIVE, HIDDEN], ACTIVE.id, { gameId: null })).toBe(true);
    expect(text([ACTIVE, HIDDEN], { gameId: null })).toContain("Marvel Rivals");
  });

  it("stops offering a hidden one", () => {
    expect(offers([ACTIVE, HIDDEN], HIDDEN.id, { gameId: null })).toBe(false);
    const rendered = text([ACTIVE, HIDDEN], { gameId: null });
    // The picker is on screen and offering the active game, so the refusal
    // below is about the hidden one and not about a tab that rendered nothing.
    expect(rendered).toContain("Marvel Rivals");
    expect(rendered).not.toContain("Old Shooter");
  });

  it("does not offer it with a label explaining that it is hidden, either", () => {
    // What it used to do. The label was the tell: an option nobody should be
    // picking, annotated instead of withheld.
    const rendered = text([ACTIVE, HIDDEN], { gameId: null });
    expect(rendered).toContain("Marvel Rivals");
    expect(rendered).not.toContain("(hidden)");
  });

  it("keeps the hidden game an event already belongs to", () => {
    // The other half of E2: "existing events … keep it." Dropping it would
    // leave the box empty and the next save would detach the event.
    expect(offers([ACTIVE, HIDDEN], HIDDEN.id, { gameId: HIDDEN.id })).toBe(true);
    const rendered = text([ACTIVE, HIDDEN], { gameId: HIDDEN.id });
    expect(rendered).toContain("Old Shooter");
    expect(rendered).toContain("(hidden)");
    expect(rendered).toContain("already belongs to it and keeps it");
  });

  it("still offers no-game, whatever the catalogue looks like", () => {
    expect(text([], { gameId: null })).toContain("No game");
  });
});

describe("UC-08 E2a: the web address box", () => {
  it("says what an address may be made of", () => {
    expect(text([ACTIVE], { slug: "spring-lan" })).toContain(
      "Letters, numbers and hyphens"
    );
  });

  it("names the problem with the stored address when there is one", () => {
    // An address the box cannot have produced, but the database can be
    // holding — every slug saved before E2a was enforced went through
    // `slugify`, and nothing stops an old row being odd.
    const rendered = text([ACTIVE], { slug: "spring lan" });
    expect(rendered).toContain("is not a web address");
    expect(rendered).toContain("letters, numbers and hyphens only");
  });

  it("shows the server's own sentence rather than a second copy of the rule", () => {
    // Two wordings for one rule is how the screen and the write drift apart,
    // which is the reason `webAddressRefusal` is in `events-policy.ts` at all.
    const refusal = webAddressRefusal("spring lan");
    expect(refusal).not.toBeNull();
    expect(text([ACTIVE], { slug: "spring lan" })).toContain(refusal as string);
  });

  it("says nothing about an address that is fine", () => {
    // So the two above are not passing on a sentence that is always rendered.
    const rendered = text([ACTIVE], { slug: "spring-lan" });
    // And the box is rendered, so this is not passing on a screen that is not.
    expect(rendered).toContain("Letters, numbers and hyphens");
    expect(rendered).not.toContain("is not a web address");
  });
});
