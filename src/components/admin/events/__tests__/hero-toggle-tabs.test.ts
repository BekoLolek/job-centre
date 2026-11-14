import { describe, expect, it } from "vitest";
import { eventShapeFrom } from "@/lib/events-policy";
import {
  HERO_LIST_KEYS,
  SETUP_KEYS,
  TAB_KEYS,
  type TabKey,
  type TabVisibility,
  landOn,
  setupHiddenBecause,
  standingOn,
  tabHiddenBecause,
  visibleTabs,
} from "../tabs";

/*
 * Task 142's half of `tabs.ts` — the Hands tab goes when the event does not
 * draw heroes (R-269 / UC-58 3a).
 *
 * `hands-tabs.test.ts` holds the two reasons that come from the game's hero
 * list. This is the third, and it comes from the Format panel: a toggle, on
 * by default. Three things this file exists to stop:
 *
 *  1. **The toggle being ignored** — Hands drawn for an event that says it
 *     deals no heroes.
 *  2. **The toggle leaking** — any tab but Hands, or any Setup panel, moving
 *     because of it.
 *  3. **The wrong landing** — a link to a Hands tab the toggle took away
 *     landing on Basics, where a game is chosen, rather than on Format, where
 *     the toggle is.
 */

const LIST = { game: "Marvel Rivals", heroes: true } as const;

/** Every shape the other two facts can make, each with a hero list. */
const SHAPES = [
  ["teams with a draft", { teamEvent: true, draft: true }],
  ["teams without a draft", { teamEvent: true, draft: false }],
  ["a solo event", { teamEvent: false, draft: false }],
] as const;

const on = (shape: { teamEvent: boolean; draft: boolean }): TabVisibility => ({
  ...shape,
  heroes: true,
  heroList: LIST,
});
const off = (shape: { teamEvent: boolean; draft: boolean }): TabVisibility => ({
  ...shape,
  heroes: false,
  heroList: LIST,
});

const OTHER_TABS = TAB_KEYS.filter((tab) => tab !== "hands");

describe("the Hands tab and the hero toggle", () => {
  it.each(SHAPES)("is drawn for %s that draws heroes", (_label, shape) => {
    expect(tabHiddenBecause("hands", on(shape))).toBeNull();
    expect(visibleTabs(on(shape))).toContain("hands");
  });

  it.each(SHAPES)("is not drawn for %s that does not", (_label, shape) => {
    expect(visibleTabs(off(shape))).not.toContain("hands");
  });

  it("says why, and names the panel the toggle is on", () => {
    expect(tabHiddenBecause("hands", off({ teamEvent: true, draft: true }))).toBe(
      "Hands is only for an event that draws heroes, and this one does not. Setup → Format is where that is decided."
    );
  });

  it("gives the toggle's sentence even when there is no game either", () => {
    // Choosing a game would not bring the tab back, so Basics is the wrong
    // screen to send them to while the toggle is off.
    const noGame: TabVisibility = { teamEvent: true, draft: true, heroes: false, heroList: { game: null } };

    expect(tabHiddenBecause("hands", noGame)).toBe(
      tabHiddenBecause("hands", off({ teamEvent: true, draft: true }))
    );
  });

  it("still needs a hero list when the toggle is on", () => {
    const noGame: TabVisibility = { teamEvent: true, draft: true, heroes: true, heroList: { game: null } };

    expect(visibleTabs(noGame)).not.toContain("hands");
  });

  it("is still the only tab in its class", () => {
    expect(HERO_LIST_KEYS).toEqual(["hands"]);
  });
});

describe("every other tab", () => {
  it("is nine tabs", () => {
    // The floor: a sweep over an empty list passes every row inside it.
    expect(OTHER_TABS).toHaveLength(9);
  });

  const rows = SHAPES.flatMap(([label, shape]) =>
    OTHER_TABS.map((tab) => [tab, label, shape] as const)
  );

  it.each(rows)("%s is the same on %s whichever way the toggle is", (tab, _label, shape) => {
    expect(tabHiddenBecause(tab as TabKey, off(shape))).toBe(tabHiddenBecause(tab as TabKey, on(shape)));
  });

  it.each(SHAPES)("loses Hands and nothing else on %s", (_label, shape) => {
    expect(visibleTabs(off(shape))).toEqual(visibleTabs(on(shape)).filter((tab) => tab !== "hands"));
  });

  const panels = SHAPES.flatMap(([label, shape]) =>
    SETUP_KEYS.map((panel) => [panel, label, shape] as const)
  );

  it.each(panels)("leaves the %s panel alone on %s", (panel, _label, shape) => {
    expect(setupHiddenBecause(panel, off(shape))).toBe(setupHiddenBecause(panel, on(shape)));
  });
});

describe("a link to a Hands tab the toggle took away", () => {
  const OFF = off({ teamEvent: true, draft: true });

  it("lands on Setup → Format, where the toggle is, carrying the reason", () => {
    expect(landOn("hands", OFF)).toEqual({
      tab: "setup",
      setup: "shape",
      asked: "hands",
      why: tabHiddenBecause("hands", OFF),
    });
  });

  it("still lands on Setup → Basics when the toggle is on and the game is missing", () => {
    const noGame: TabVisibility = { teamEvent: true, draft: true, heroes: true, heroList: { game: null } };

    expect(landOn("hands", noGame).setup).toBe("basics");
  });

  it("moves a manager off the tab when they turn the toggle off", () => {
    expect(standingOn("hands", OFF, null)).toEqual({
      here: "setup",
      notice: tabHiddenBecause("hands", OFF),
    });
  });
});

describe("the editor's own read of the toggle", () => {
  // The server page builds its `TabVisibility` by spreading `eventShapeFrom`,
  // so this is the path a stored event actually takes to the rail.
  it("draws Hands for an event with nothing stored", () => {
    expect(visibleTabs({ ...eventShapeFrom({}), heroList: LIST })).toContain("hands");
  });

  it("does not draw Hands for an event stored as not drawing heroes", () => {
    const stored = eventShapeFrom({ eventShape: { heroes: false } });

    expect(visibleTabs({ ...stored, heroList: LIST })).not.toContain("hands");
  });
});
