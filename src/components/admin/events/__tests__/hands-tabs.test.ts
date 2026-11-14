import { describe, expect, it } from "vitest";
import {
  HERO_LIST_KEYS,
  PEOPLE_KEYS,
  SETUP_KEYS,
  TAB_KEYS,
  TAB_LABELS,
  TEAM_ONLY_KEYS,
  type TabVisibility,
  landOn,
  setupFrom,
  standingOn,
  tabFrom,
  tabHiddenBecause,
  visibleTabs,
} from "../tabs";

/*
 * Task 100's half of `tabs.ts` — the Hands tab, and the two reasons it is not
 * drawn (R-239 / UC-47 1, 1a, 1b).
 *
 * Task 80 made the step tabs conditional on the Format panel; this adds a tab
 * conditional on a fact from *another table* — the game's hero list — which is
 * why `TabVisibility` grew a third member rather than a second mechanism. The
 * member is not a boolean, because UC-47 1b's sentence has to name the game,
 * and `tabHiddenBecause` derives both sentences from it.
 *
 * Three things this file exists to stop:
 *
 *  1. **One sentence for two reasons.** A tab hidden because the event has no
 *     game and a tab hidden because its game has no heroes send the reader to
 *     different screens. The two are asserted whole, and asserted different.
 *  2. **Hands landing on the Format panel.** Every other hidden tab lands on
 *     Setup → Format, the panel that brings it back; Hands comes back from
 *     Setup → Basics, where a game is chosen, and the landing has to say so.
 *  3. **The fact leaking into other tabs.** The hero list decides Hands and
 *     nothing else; a solo event with a list still has Hands, a team event
 *     without one still has everything else.
 */

const WITH_LIST: TabVisibility = {
  teamEvent: true,
  draft: true,
  heroes: true,
  heroList: { game: "Marvel Rivals", heroes: true },
};
const EMPTY_LIST: TabVisibility = {
  teamEvent: true,
  draft: true,
  heroes: true,
  heroList: { game: "Marvel Rivals", heroes: false },
};
const NO_GAME: TabVisibility = { teamEvent: true, draft: true, heroes: true, heroList: { game: null } };
const SOLO_WITH_LIST: TabVisibility = {
  teamEvent: false,
  draft: false,
  heroes: true,
  heroList: { game: "Marvel Rivals", heroes: true },
};

/* --------------------------------------------------------------------- */
/* The tenth tab                                                         */
/* --------------------------------------------------------------------- */

describe("the Hands tab", () => {
  it("is a people screen, labelled Hands, reachable under its own key", () => {
    expect(PEOPLE_KEYS).toContain("hands");
    expect(TAB_LABELS.hands).toBe("Hands");
    expect(tabFrom("hands")).toBe("hands");
  });

  it("is last on the people rail, after Captains", () => {
    expect(PEOPLE_KEYS[PEOPLE_KEYS.length - 1]).toBe("hands");
    expect(PEOPLE_KEYS[PEOPLE_KEYS.length - 2]).toBe("captains");
  });

  it("shadows no Setup panel, so the alias map is consulted first and finds nothing", () => {
    expect(setupFrom("hands")).toBe("basics");
    expect(SETUP_KEYS).not.toContain("hands" as never);
  });

  it("is the one tab that needs a hero list, and is in no other class", () => {
    expect(HERO_LIST_KEYS).toEqual(["hands"]);
    expect(TEAM_ONLY_KEYS).not.toContain("hands");
  });
});

/* --------------------------------------------------------------------- */
/* Which events have it (UC-47 preconditions, 1a, 1b)                    */
/* --------------------------------------------------------------------- */

describe("the events that have a Hands tab", () => {
  it("is every one of the ten tabs on a team event with a draft and a hero list", () => {
    expect(TAB_KEYS.length).toBe(10);
    expect(visibleTabs(WITH_LIST)).toEqual([...TAB_KEYS]);
  });

  it("draws Hands for an event whose game has a hero list, and for no other", () => {
    expect(visibleTabs(WITH_LIST)).toContain("hands");
    expect(visibleTabs(EMPTY_LIST)).not.toContain("hands");
    expect(visibleTabs(NO_GAME)).not.toContain("hands");
  });

  it("does not depend on sides or a draft — a solo event with a list has it", () => {
    expect(visibleTabs(SOLO_WITH_LIST)).toContain("hands");
    expect(visibleTabs(SOLO_WITH_LIST)).not.toContain("teams");
  });

  it("changes nothing about the other nine tabs", () => {
    for (const tab of TAB_KEYS) {
      if (tab === "hands") continue;
      expect(tabHiddenBecause(tab, NO_GAME), tab).toBe(tabHiddenBecause(tab, WITH_LIST));
      expect(tabHiddenBecause(tab, EMPTY_LIST), tab).toBe(tabHiddenBecause(tab, WITH_LIST));
    }
  });
});

/* --------------------------------------------------------------------- */
/* Two sentences, not one (UC-47 1a, 1b)                                 */
/* --------------------------------------------------------------------- */

describe("why Hands is not here", () => {
  it("says the event has no game, and points at Setup → Basics where one is chosen (1a)", () => {
    expect(tabHiddenBecause("hands", NO_GAME)).toBe(
      "Hands is only for an event with a game, and this one has none. Setup → Basics is where a game is chosen."
    );
  });

  it("names the game whose list is empty, and points at that list rather than at the event (1b)", () => {
    expect(tabHiddenBecause("hands", EMPTY_LIST)).toBe(
      "Hands is only for a game with a hero list, and Marvel Rivals has no heroes yet. Admin → Games is where Marvel Rivals's list is filled."
    );
  });

  it("gives two different sentences for the two reasons, and only the second names the game", () => {
    // The mutation this exists to kill: collapsing both branches into one
    // sentence, which would send half its readers to a screen that cannot
    // fix it (UC-42 5a's standard).
    const noGame = tabHiddenBecause("hands", NO_GAME);
    const emptyList = tabHiddenBecause("hands", EMPTY_LIST);
    expect(noGame).not.toBe(emptyList);
    expect(noGame).toContain("Setup → Basics");
    expect(noGame).not.toContain("Marvel Rivals");
    expect(emptyList).toContain("Marvel Rivals");
    expect(emptyList).not.toContain("Setup → Basics");
  });

  it("says nothing when the tab applies", () => {
    expect(tabHiddenBecause("hands", WITH_LIST)).toBeNull();
    expect(tabHiddenBecause("hands", SOLO_WITH_LIST)).toBeNull();
  });
});

/* --------------------------------------------------------------------- */
/* Nobody is stranded (UC-42 5a, for the tenth tab)                      */
/* --------------------------------------------------------------------- */

describe("a link to the Hands tab", () => {
  it("lands an event with no game on Setup → Basics, carrying the reason", () => {
    expect(landOn("hands", NO_GAME)).toEqual({
      tab: "setup",
      setup: "basics",
      asked: "hands",
      why: tabHiddenBecause("hands", NO_GAME),
    });
  });

  it("lands an event whose game has no hero list on Setup → Basics too, with the reason naming the game", () => {
    const landing = landOn("hands", EMPTY_LIST);
    expect(landing.tab).toBe("setup");
    expect(landing.setup).toBe("basics");
    expect(landing.asked).toBe("hands");
    expect(landing.why).toContain("Marvel Rivals");
  });

  it("opens the tab, with nothing said, when the game has a list", () => {
    expect(landOn("hands", WITH_LIST)).toEqual({
      tab: "hands",
      setup: "basics",
      asked: null,
      why: null,
    });
  });

  it("still lands a hidden team tab on the Format panel — the Basics landing is Hands' alone", () => {
    const solo: TabVisibility = { ...WITH_LIST, teamEvent: false, draft: false };
    expect(landOn("teams", solo).setup).toBe("shape");
    expect(landOn("draft", solo).setup).toBe("shape");
  });

  it("moves a manager off the tab when the fact changes under them", () => {
    expect(standingOn("hands", NO_GAME, null)).toEqual({
      here: "setup",
      notice: tabHiddenBecause("hands", NO_GAME),
    });
    expect(standingOn("hands", EMPTY_LIST, null)).toEqual({
      here: "setup",
      notice: tabHiddenBecause("hands", EMPTY_LIST),
    });
  });

  it("leaves them on it, carrying the arrival sentence, while the list is there", () => {
    expect(standingOn("hands", WITH_LIST, "why you are here")).toEqual({
      here: "hands",
      notice: "why you are here",
    });
  });

  it("prefers the live reason to the one the server gave on arrival", () => {
    expect(standingOn("hands", NO_GAME, "stale").notice).not.toBe("stale");
  });
});
