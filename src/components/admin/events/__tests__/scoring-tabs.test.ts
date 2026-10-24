import { describe, expect, it } from "vitest";
import {
  SETUP_KEYS,
  SETUP_LABELS,
  SOLO_ONLY_SETUP_KEYS,
  TAB_KEYS,
  type TabVisibility,
  landOn,
  setupFrom,
  setupHiddenBecause,
  standingOn,
  standingOnPanel,
  tabFrom,
  tabHiddenBecause,
  visibleSetup,
} from "../tabs";

/*
 * Task 87's half of `tabs.ts` — UC-44 1, 6b.
 *
 * Task 80 made the *step* tabs conditional on the Format panel; this extends
 * that to the panels inside Setup, one level down, in the same shape:
 * `setupHiddenBecause` is a sentence rather than a boolean, so the rail and the
 * "that panel is not here" landing cannot disagree about why.
 *
 * The alias collision Task 79 solved is held shut again here, because the new
 * alias is consulted before the step keys too: `?tab=format` must still open
 * the bracket, and `scoring` must not shadow anything.
 */

const TEAMS: TabVisibility = { teamEvent: true, draft: true };
const TEAMS_NO_DRAFT: TabVisibility = { teamEvent: true, draft: false };
const SOLO: TabVisibility = { teamEvent: false, draft: false };

/**
 * The panels every event has, written out **as a literal on purpose** — the
 * other half of the sweep below, which reads the key list off the module.
 */
const EVERY_EVENT = ["basics", "days", "questions", "rules", "championship", "shape"] as const;

describe("the seventh Setup panel", () => {
  it("is keyed scoring, labelled Scoring, and reachable under its own key", () => {
    expect(SETUP_KEYS).toContain("scoring");
    expect(SETUP_LABELS.scoring).toBe("Scoring");
    expect(tabFrom("scoring")).toBe("setup");
    expect(setupFrom("scoring")).toBe("scoring");
  });

  it("is last on the Setup rail, after Format", () => {
    expect(SETUP_KEYS[SETUP_KEYS.length - 1]).toBe("scoring");
    expect(SETUP_KEYS[SETUP_KEYS.length - 2]).toBe("shape");
  });

  it("shadows no step: ?tab=format still opens the bracket, and scoring is not a step", () => {
    expect(tabFrom("format")).toBe("format");
    expect(setupFrom("format")).toBe("basics");
    expect(TAB_KEYS).not.toContain("scoring" as never);
  });
});

/* --------------------------------------------------------------------- */
/* Which panels apply (UC-44 6b)                                         */
/* --------------------------------------------------------------------- */

describe("the panels that apply", () => {
  it("drops Scoring from a team event, drafted or not", () => {
    expect(visibleSetup(TEAMS)).not.toContain("scoring");
    expect(visibleSetup(TEAMS_NO_DRAFT)).not.toContain("scoring");
  });

  it("shows every panel on a solo event, in rail order", () => {
    expect(visibleSetup(SOLO)).toEqual([...SETUP_KEYS]);
  });

  it("classifies every panel the module knows about", () => {
    // Read off the module, with a floor, so an eighth panel in neither class
    // fails here rather than quietly appearing on every event.
    expect(SETUP_KEYS.length).toBeGreaterThanOrEqual(7);
    expect(SOLO_ONLY_SETUP_KEYS).toEqual(["scoring"]);

    for (const panel of SETUP_KEYS) {
      const always = (EVERY_EVENT as readonly string[]).includes(panel);
      const soloOnly = SOLO_ONLY_SETUP_KEYS.includes(panel);
      expect(always !== soloOnly, `${panel} is in neither class, or in both`).toBe(true);

      expect(setupHiddenBecause(panel, SOLO), panel).toBeNull();
      if (always) {
        expect(setupHiddenBecause(panel, TEAMS), panel).toBeNull();
        expect(setupHiddenBecause(panel, TEAMS_NO_DRAFT), panel).toBeNull();
      } else {
        expect(setupHiddenBecause(panel, TEAMS), panel).not.toBeNull();
      }
    }
  });

  it("says why, naming the panel and where to fix it", () => {
    expect(setupHiddenBecause("scoring", TEAMS)).toBe(
      "Scoring is only for an event with no sides — a night with teams has a bracket instead. Setup → Format is where that is decided."
    );
  });

  it("keeps the Format panel itself whatever the shape, because it is where the shape is decided", () => {
    expect(setupHiddenBecause("shape", TEAMS)).toBeNull();
    expect(setupHiddenBecause("shape", SOLO)).toBeNull();
  });
});

/* --------------------------------------------------------------------- */
/* Nobody is stranded on a panel (UC-42 5a, one level down)              */
/* --------------------------------------------------------------------- */

describe("a link to a panel this event does not have", () => {
  it("lands on Setup with the Format panel open, and says why", () => {
    expect(landOn("scoring", TEAMS)).toEqual({
      tab: "setup",
      setup: "shape",
      asked: "scoring",
      why: setupHiddenBecause("scoring", TEAMS),
    });
  });

  it("opens the panel on a solo event with nothing said", () => {
    expect(landOn("scoring", SOLO)).toEqual({
      tab: "setup",
      setup: "scoring",
      asked: null,
      why: null,
    });
  });

  it("still lands a hidden step on the Format panel, with the step's reason — the panel rule does not override it", () => {
    expect(landOn("draft", SOLO)).toEqual({
      tab: "setup",
      setup: "shape",
      asked: "draft",
      why: tabHiddenBecause("draft", SOLO),
    });
  });

  it("leaves every panel that applies exactly where the alias put it", () => {
    for (const panel of SETUP_KEYS) {
      expect(landOn(panel, SOLO), panel).toEqual({
        tab: "setup",
        setup: panel,
        asked: null,
        why: null,
      });
    }
  });

  it("moves the admin off a panel that stopped applying under them", () => {
    // Standing on Scoring, the admin turns teams on from Format and saves.
    expect(standingOnPanel("scoring", TEAMS, null)).toEqual({
      here: "shape",
      notice: setupHiddenBecause("scoring", TEAMS),
    });
  });

  it("leaves the admin on a panel that still applies, carrying the sentence through", () => {
    for (const panel of SETUP_KEYS) {
      expect(standingOnPanel(panel, SOLO, "why you are here"), panel).toEqual({
        here: panel,
        notice: "why you are here",
      });
    }
    expect(standingOnPanel("basics", TEAMS, null)).toEqual({ here: "basics", notice: null });
  });

  it("prefers the live reason to the one the server gave on arrival", () => {
    expect(standingOnPanel("scoring", TEAMS, "stale").notice).not.toBe("stale");
  });

  it("is a decision of its own, beside the step decision it mirrors", () => {
    // The step rule is unchanged by this task: Setup itself always applies.
    expect(standingOn("setup", TEAMS, null)).toEqual({ here: "setup", notice: null });
  });
});
