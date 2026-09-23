import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Suggestion } from "@/lib/suggestions";

/*
 * The two things about this screen that only the markup can answer (UC-22 3b,
 * E3).
 *
 * Everything the server decides is pinned in `src/lib/__tests__/suggestions.test.ts`.
 * What is left is what the page *says*, and both halves of it are a branch in
 * JSX that no library test can see:
 *
 * - **3b.** A visitor who goes for an arrow must be asked to sign in. The old
 *   screen disabled the arrows and hung a `title` on them, which is the system
 *   declining to say anything to the reader this page is public for.
 * - **E3.** Removing your own suggestion asks first. The dialog is what the
 *   asking *is*, so what it says — that the votes go too, and how many — is the
 *   part worth holding.
 *
 * `useRouter` and the action module are the only things between this component
 * and a pure function, so they are the only things mocked. The actions are
 * mocked rather than imported because importing them would drag the database
 * and the session into a node test to render an anchor.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("@/app/suggestions/actions", () => ({
  addSuggestionAction: vi.fn(),
  deleteSuggestionAction: vi.fn(),
  setSuggestionStatusAction: vi.fn(),
  voteSuggestionAction: vi.fn(),
}));

const { default: SuggestionBox, RemoveConfirm } = await import("../SuggestionBox");

function suggestion(over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "A REPO night",
    detail: "Five of us, two hours, one torch.",
    gameName: "R.E.P.O.",
    status: "open",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    by: { id: "ada", name: "Ada", handle: "ada" },
    up: 6,
    down: 1,
    score: 5,
    yours: 0,
    ...over,
  };
}

function box(over: { signedIn?: boolean; viewerId?: string | null } = {}): string {
  return renderToStaticMarkup(
    createElement(SuggestionBox, {
      initial: [suggestion()],
      signedIn: over.signedIn ?? false,
      isAdmin: false,
      viewerId: over.viewerId ?? null,
    })
  );
}

describe("what a signed-out reader is offered (UC-22 3b)", () => {
  it("points the vote arrows at the sign-in page", () => {
    const markup = box({ signedIn: false });

    // The arrow itself, not just the notice above the list: the arrow is what
    // somebody who wants to vote actually clicks.
    expect(markup).toMatch(/<a[^>]*aria-label="Sign in to vote[^>]*href="\/signin"/);
    // And it is a link, not a dead button with a tooltip on it.
    expect(markup).not.toContain('title="Sign in to vote"');
    expect(markup).not.toMatch(/<button[^>]*aria-label="I want this"/);
  });

  it("gives a member the arrows themselves, and no sign-in link", () => {
    const markup = box({ signedIn: true, viewerId: "someone" });

    expect(markup).toMatch(/<button[^>]*aria-label="I want this"/);
    expect(markup).not.toContain('href="/signin"');
  });
});

describe("asking before removing (UC-22 E3)", () => {
  const render = (row: Suggestion | null) =>
    renderToStaticMarkup(
      createElement(RemoveConfirm, { row, onConfirm: () => {}, onCancel: () => {} })
    );

  it("names the suggestion and the votes that go with it", () => {
    const markup = render(suggestion({ up: 6, down: 1 }));

    expect(markup).toContain("A REPO night");
    // Six likes and one dislike: seven people are being spoken for.
    expect(markup).toContain("7 votes");
    expect(markup).toContain("Remove it");
    expect(markup).toContain("Keep it");
  });

  it("says nothing at all until there is something to ask about", () => {
    // The list renders the dialog on every pass; a dialog that is open by
    // default is a delete that never asks.
    expect(render(null)).toBe("");
    expect(box({ signedIn: true, viewerId: "ada" })).not.toContain("Remove this suggestion?");
  });
});
