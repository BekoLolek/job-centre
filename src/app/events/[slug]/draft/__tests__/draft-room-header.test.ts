import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSIZED_ROSTER_NOTE } from "@/components/draft/TeamCard";
import { redactDraft } from "@/lib/draft-policy";
import type { DraftRoomView } from "@/lib/draft";
import {
  CAP_FIVE,
  OBSERVER,
  STATED_SIX,
  UNSIZED,
  roomView,
  snapshot,
  textOf,
} from "./room-fixture";

/*
 * What the draft room's header says about the places on a team (R-250 /
 * UC-49 1a, 1b), and where it reads the figure from.
 *
 * The header used to read the figure off `view.teams[0]`, which encoded an
 * invariant the type never stated — every team carries the same sizing — and
 * went blank the moment there were no teams, although the panel had a figure.
 * The snapshot is built from one sizing and now carries it, so the room reads
 * `view.sizing` and the header has a figure for a room with no teams in it.
 *
 * The actions module is mocked for the reason the Teams tab tests mock
 * theirs: importing it would drag the database and the session into a node
 * test that only wants markup.
 */

vi.mock("../actions", () => ({
  loadRoomAction: vi.fn(),
  placeBidAction: vi.fn(),
  runDraftAction: vi.fn(),
}));

const { default: DraftRoom } = await import("../DraftRoom");

function render(view: DraftRoomView): string {
  return textOf(
    renderToStaticMarkup(
      createElement(DraftRoom, {
        event: { id: "event-1", slug: "rivals", title: "Rivals Night" },
        initial: { view, standing: null },
        signedIn: false,
      })
    )
  );
}

describe("the snapshot's sizing", () => {
  it("is carried through the redaction untouched", () => {
    const whole = snapshot({ under: CAP_FIVE });
    expect(redactDraft(whole, OBSERVER).sizing).toEqual(whole.sizing);
    expect(redactDraft(whole, OBSERVER).sizing).toEqual({ target: null, cap: 5 });
  });
});

describe("the draft room's header", () => {
  it("reads a stated target as the places per roster, as before", () => {
    expect(render(roomView({ under: STATED_SIX }))).toContain("Sealed bids · 6 per roster");
  });

  it("reads a cap as the most a roster may hold (UC-49 1a)", () => {
    const room = render(roomView({ under: CAP_FIVE }));
    expect(room).toContain("Sealed bids · up to 5 per roster");
    expect(room).not.toContain("Sealed bids · 5 per roster");
  });

  it("says in words that the panel has not sized the teams (UC-49 1b)", () => {
    const room = render(roomView({ under: UNSIZED }));
    expect(room).toContain(`Sealed bids · ${UNSIZED_ROSTER_NOTE}`);
    expect(room).not.toMatch(/Sealed bids · (?:\d+|up to)/);
  });

  it("has the figure with no teams at all — it is the panel's, not the first team's", () => {
    const room = render(roomView({ under: STATED_SIX, noTeams: true }));
    expect(room).toContain("Sealed bids · 6 per roster");
  });
});
