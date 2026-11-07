import { describe, expect, it } from "vitest";
import { ANNOUNCEMENT_PLACEHOLDERS } from "@/lib/announce";
import {
  DEFAULT_DRAFT_CONFIG,
  DRAFT_RULE_KEYS,
  type DraftViewer,
  changedRules,
  mayWatchPrivateDraft,
} from "@/lib/draft-policy";
import { privateDraftFrom } from "@/lib/events-policy";

/*
 * The pure half of a private draft (R-253 / UC-50): how the flag is read off
 * `events.config`, who it lets through, and the two things it must *not* be.
 *
 * The page guard, the poll, the admin action and the announcement are proved
 * against a real database in `src/app/events/[slug]/draft/__tests__/private-draft.test.ts`
 * and `draft-announce.test.ts`; this file holds the rules those call.
 */

function viewer(role: DraftViewer["role"]): DraftViewer {
  return { role, userId: role === "observer" ? null : "u-1", teamId: role === "captain" ? "t-1" : null };
}

describe("privateDraftFrom", () => {
  it("reads an absent key as public — every draft stored before the flag existed stays watchable", () => {
    expect(privateDraftFrom(undefined)).toBe(false);
    expect(privateDraftFrom(null)).toBe(false);
    expect(privateDraftFrom({})).toBe(false);
  });

  it("is private only on a real true, never on a string a hand-written row might hold", () => {
    expect(privateDraftFrom({ privateDraft: true })).toBe(true);
    expect(privateDraftFrom({ privateDraft: false })).toBe(false);
    expect(privateDraftFrom({ privateDraft: "true" })).toBe(false);
    expect(privateDraftFrom({ privateDraft: 1 })).toBe(false);
  });

  it("is a top-level key, so the Format panel's whole-object save cannot erase it", () => {
    // `saveEventShapeAction` writes `config.eventShape` whole; a flag inside it
    // would have to be preserved by that save. A sibling survives it.
    expect(privateDraftFrom({ eventShape: { privateDraft: true } })).toBe(false);
    expect(privateDraftFrom({ privateDraft: true, eventShape: { teamEvent: true } })).toBe(true);
  });
});

describe("mayWatchPrivateDraft", () => {
  it("lets a manager and a captain of this event through (UC-50 3, 3a)", () => {
    expect(mayWatchPrivateDraft(viewer("admin"))).toBe(true);
    expect(mayWatchPrivateDraft(viewer("captain"))).toBe(true);
  });

  it("turns a watcher and a player in the pool away (UC-50 2a)", () => {
    // A player is *in* the draft and still not a captain: the owner's words
    // were "captains and admins", and a pool entry is neither.
    expect(mayWatchPrivateDraft(viewer("observer"))).toBe(false);
    expect(mayWatchPrivateDraft(viewer("player"))).toBe(false);
  });
});

describe("the flag is not a draft rule", () => {
  it("is not frozen by the rules lock — the doors can be closed mid-draft (UC-16 1a does not apply)", () => {
    // `changedRules` is the lock's question. The flag is not a key of
    // `DraftConfig` at all, so two configs differing only by it change nothing.
    expect(DRAFT_RULE_KEYS).not.toContain("privateDraft");
    expect(Object.keys(DEFAULT_DRAFT_CONFIG)).not.toContain("privateDraft");
    const before = { ...DEFAULT_DRAFT_CONFIG, privateDraft: false };
    const after = { ...DEFAULT_DRAFT_CONFIG, privateDraft: true };
    expect(changedRules(before, after)).toEqual([]);
  });
});

describe("which announcements name a price", () => {
  it("is exactly the draft sale — the one kind `announceLotSold` withholds while the draft is private (UC-50 4a)", () => {
    // The sweep that keeps criterion 4 honest: a kind that gains `{price}` or
    // `{bid}` later has to be suppressed too, and this is where that is found.
    const naming = Object.entries(ANNOUNCEMENT_PLACEHOLDERS)
      .filter(([, placeholders]) =>
        placeholders.some((placeholder) => /^(price|bid)$/.test(placeholder.name))
      )
      .map(([kind]) => kind);
    expect(naming).toEqual(["draft_lot_sold"]);
  });
});
