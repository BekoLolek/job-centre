import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminFieldView } from "@/lib/admin-games";

/*
 * Where the profile-field editor offers the preferred-roles marker (R-259 /
 * UC-54), and what it shows for a question that already has it.
 *
 * The rule itself is `canHoldRoles` and is tested where it lives; what is
 * asked here is that the dialog obeys it — a box on a question it would mean
 * nothing on is a box whose tick `createField` and `updateField` throw away.
 *
 * A static render cannot click, so the box's state is read from the question
 * the dialog is opened on, and what a save sends is asked of `fieldInputFrom`
 * — the function `save` builds both the create and the edit payload with.
 * That matters more than it looks: `updateField` reads a payload with no
 * `holdsRoles` as "not marked", so an editor that left it out would clear the
 * marker on every edit of the marked question, a rename included.
 *
 * The action module is mocked for the reason `question-copy.test.ts` gives:
 * it is `"use server"` and pulls next-auth in behind the database.
 */

vi.mock("@/app/admin/games/actions", () => ({
  createFieldAction: async () => ({ ok: true, data: { id: "" } }),
  previewFieldEditAction: async () => ({ answers: 0, invalidated: 0 }),
  updateFieldAction: async () => ({ ok: true, data: { strandedAnswers: 0 } }),
}));

const {
  default: QuestionDialog,
  ROLES_MARKER_LABEL,
  fieldInputFrom,
} = await import("../QuestionDialog");

function field(over: Partial<AdminFieldView> = {}): AdminFieldView {
  return {
    id: "field-1",
    gameId: "game-1",
    key: "mains",
    label: "Mains",
    type: "multiselect",
    options: [{ value: "scout", label: "Scout" }],
    required: false,
    holdsRoles: false,
    sort: 0,
    retiredAt: null,
    createdAt: new Date("2026-03-01T18:00:00Z"),
    answers: 0,
    ...over,
  };
}

function renderDialog(gameId: string | null, editing?: AdminFieldView): string {
  return renderToStaticMarkup(
    createElement(QuestionDialog, {
      open: true,
      gameId,
      rankLadder: [],
      field: editing,
      onClose() {},
      onSaved() {},
    })
  );
}

/** The marker's own `<label>`, box and words, or undefined when it is not offered. */
function markerIn(markup: string): string | undefined {
  // As the markup spells it: React escapes the apostrophe in "game's".
  const words = ROLES_MARKER_LABEL.replaceAll("'", "&#x27;");
  return markup.split("<label").find((part) => part.includes(words));
}

describe("what the profile-field editor sends when it saves (R-259)", () => {
  const draft = {
    label: "Mains",
    type: "multiselect" as const,
    options: [
      { value: "scout", label: "Scout" },
      { value: "medic", label: "Medic" },
    ],
    required: true,
  };

  it("sends the tick", () => {
    expect(fieldInputFrom({ ...draft, holdsRoles: true }).holdsRoles).toBe(true);
  });

  it("sends the cleared box as a clear, not as silence", () => {
    expect(fieldInputFrom({ ...draft, holdsRoles: false }).holdsRoles).toBe(false);
  });

  it("sends the rest of the question as it always did", () => {
    expect(fieldInputFrom({ ...draft, holdsRoles: false })).toEqual({
      label: "Mains",
      type: "multiselect",
      options: ["Scout", "Medic"],
      required: true,
      holdsRoles: false,
    });
  });
});

describe("the preferred-roles marker on the profile-field editor (R-259)", () => {
  it("is offered on a game's own pick-any, unticked until somebody ticks it", () => {
    const marker = markerIn(renderDialog("game-1", field()));

    expect(marker).toContain('type="checkbox"');
    expect(marker).not.toContain("checked");
  });

  it("is ticked on the question that already holds the game's roles", () => {
    const marker = markerIn(renderDialog("game-1", field({ holdsRoles: true })));

    expect(marker).toContain('type="checkbox"');
    expect(marker).toContain('checked=""');
  });

  it("is not offered on a pick-any asked of everybody", () => {
    expect(markerIn(renderDialog(null, field({ gameId: null })))).toBeUndefined();
  });

  it("is not offered on a game's pick-one", () => {
    expect(markerIn(renderDialog("game-1", field({ type: "select" })))).toBeUndefined();
  });

  it("is not offered on a new question until it is made a pick-any", () => {
    // A new question opens as a pick-one, so there is nothing to mark yet.
    expect(markerIn(renderDialog("game-1"))).toBeUndefined();
  });
});
