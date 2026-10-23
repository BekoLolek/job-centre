import { describe, expect, it } from "vitest";
import {
  PEOPLE_KEYS,
  SETUP_KEYS,
  SETUP_LABELS,
  STEP_KEYS,
  TAB_KEYS,
  TAB_LABELS,
  TEAM_ONLY_KEYS,
  type TabKey,
  type TabVisibility,
  landOn,
  setupFrom,
  standingOn,
  tabFrom,
  tabHiddenBecause,
  visibleTabs,
} from "../tabs";
import {
  DRAFT_AWARDED_REFUSAL,
  MAX_PER_TEAM,
  dealSizes,
  eventShapeFrom,
  isSizingMode,
  shapeProblem,
  sizingConsequence,
  teamsInTheWayRefusal,
} from "@/lib/events-policy";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { planTeams } from "@/lib/random-teams";

/*
 * Tasks 79 and 80's pure half — R-217, R-218, R-219 / UC-42 1-5a.
 *
 * Everything here is a plain function over plain data, which is the point:
 * `tabs.ts` imports nothing so that a server page and a `"use client"`
 * component can both read it, and the arithmetic behind "6 per team → 3 teams"
 * is in `events-policy.ts` so the panel and the server action can refuse in the
 * same words. Neither half needs a database and neither gets one.
 *
 * The three things this file exists to stop:
 *
 *  1. **The alias collision.** `tabFrom` checks the Setup aliases before the
 *     step keys, so a Setup panel keyed `format` would turn every link to the
 *     bracket into a link to Setup. The first block holds that shut.
 *  2. **A seventh tab arriving and being forgotten.** The sweep iterates
 *     `TAB_KEYS` off the module and insists every key is classified, with a
 *     floor so an empty scan fails rather than passes (Task 31's lesson).
 *  3. **The two sizing figures drifting.** They cannot, because only one is
 *     stored — but the two readings of "the remainder one per team" are
 *     written twice, once in each direction, so they are held against each
 *     other over every legal count instead of being assumed equal.
 */

const TEAMS_WITH_DRAFT: TabVisibility = { teamEvent: true, draft: true };
const TEAMS_NO_DRAFT: TabVisibility = { teamEvent: true, draft: false };
const SOLO: TabVisibility = { teamEvent: false, draft: false };

/**
 * The tabs R-219 keeps whatever kind of event this is, written out **as a
 * literal on purpose**.
 *
 * The sweep below reads the key list off the module, so a tab nobody thought
 * about is caught; this is the other half of that pair — the expected answer
 * has to be stated somewhere or the sweep is comparing the code against
 * itself. A seventh tab is in neither this list nor `TEAM_ONLY_KEYS`, and the
 * completeness test fails for it.
 */
const ALWAYS: readonly TabKey[] = ["setup", "schedule", "results", "publish", "applicants"];

/* --------------------------------------------------------------------- */
/* The naming collision (Task 79's reason for existing)                  */
/* --------------------------------------------------------------------- */

describe("?tab=format still opens the bracket", () => {
  it("resolves to the bracket step, not to Setup", () => {
    expect(tabFrom("format")).toBe("format");
  });

  it("is not a Setup alias, which is what would break it", () => {
    // `tabFrom` consults the aliases *first*. An alias named `format` would
    // make the assertion above impossible, so this is the structural half.
    expect(setupFrom("format")).toBe("basics");
    expect(SETUP_KEYS).not.toContain("format" as never);
  });

  it("still opens the bracket on an event that has one, through the landing", () => {
    expect(landOn("format", TEAMS_WITH_DRAFT)).toEqual({
      tab: "format",
      setup: "basics",
      asked: null,
      why: null,
    });
  });

  it("calls the step Bracket and the Setup panel Format", () => {
    expect(TAB_LABELS.format).toBe("Bracket");
    expect(SETUP_LABELS.shape).toBe("Format");
  });

  it("reaches the new panel under its own key", () => {
    expect(tabFrom("shape")).toBe("setup");
    expect(setupFrom("shape")).toBe("shape");
    expect(SETUP_KEYS).toContain("shape");
  });

  it("keeps every name the editor can draw", () => {
    // A tab or panel with no label would render a blank word on the rail.
    for (const key of TAB_KEYS) expect(TAB_LABELS[key], key).toBeTruthy();
    for (const key of SETUP_KEYS) expect(SETUP_LABELS[key], key).toBeTruthy();
  });
});

/* --------------------------------------------------------------------- */
/* Which tabs apply (R-219 / UC-42 5)                                    */
/* --------------------------------------------------------------------- */

describe("the tabs that apply", () => {
  it("drops Draft, Teams, Captains and the bracket from a solo event", () => {
    const shown = visibleTabs(SOLO);
    expect(shown).not.toContain("draft");
    expect(shown).not.toContain("teams");
    expect(shown).not.toContain("captains");
    expect(shown).not.toContain("format");
  });

  it("keeps Teams and the bracket on a team event with no draft, and drops only Draft", () => {
    const shown = visibleTabs(TEAMS_NO_DRAFT);
    expect(shown).not.toContain("draft");
    expect(shown).toContain("teams");
    expect(shown).toContain("captains");
    expect(shown).toContain("format");
  });

  it("keeps Schedule and Results in every configuration", () => {
    for (const shape of [TEAMS_WITH_DRAFT, TEAMS_NO_DRAFT, SOLO]) {
      expect(visibleTabs(shape)).toContain("schedule");
      expect(visibleTabs(shape)).toContain("results");
    }
  });

  it("shows everything on a team event that drafts", () => {
    expect(visibleTabs(TEAMS_WITH_DRAFT)).toEqual([...TAB_KEYS]);
  });

  /*
   * The sweep. Reads the list off the module rather than off a copy, so a
   * seventh tab cannot be added without landing in one of the two classes —
   * and asserts a floor first, because a scan over an empty list passes every
   * loop inside it. Task 31: a sweep keyed to the fixed form cannot report the
   * unfixed form.
   */
  it("classifies every tab the module knows about", () => {
    expect(TAB_KEYS.length).toBeGreaterThanOrEqual(9);
    expect([...STEP_KEYS, ...PEOPLE_KEYS]).toEqual([...TAB_KEYS]);
    expect(TEAM_ONLY_KEYS.length).toBe(4);

    for (const tab of TAB_KEYS) {
      const always = ALWAYS.includes(tab);
      const teamOnly = TEAM_ONLY_KEYS.includes(tab);
      // Every key is in exactly one class. A new tab in neither fails here.
      expect(always !== teamOnly, `${tab} is in neither class, or in both`).toBe(true);

      // A full team event has every tab, whatever class it is in.
      expect(tabHiddenBecause(tab, TEAMS_WITH_DRAFT), tab).toBeNull();

      if (always) {
        expect(tabHiddenBecause(tab, SOLO), tab).toBeNull();
        expect(tabHiddenBecause(tab, TEAMS_NO_DRAFT), tab).toBeNull();
      } else {
        expect(tabHiddenBecause(tab, SOLO), tab).not.toBeNull();
      }
    }
  });

  it("says why, in a sentence that names the tab and where to fix it", () => {
    const why = tabHiddenBecause("draft", SOLO);
    expect(why).toContain("Draft");
    expect(why).toContain("Setup → Format");

    const noDraft = tabHiddenBecause("draft", TEAMS_NO_DRAFT);
    expect(noDraft).toContain("no draft");
    expect(noDraft).toContain("Teams tab");
  });
});

/* --------------------------------------------------------------------- */
/* Nobody is stranded (UC-42 5a)                                         */
/* --------------------------------------------------------------------- */

describe("a link to a tab this event does not have", () => {
  it("lands on Setup with the Format panel open, and says why", () => {
    const landing = landOn("draft", SOLO);
    expect(landing.tab).toBe("setup");
    expect(landing.setup).toBe("shape");
    expect(landing.asked).toBe("draft");
    expect(landing.why).toBe(tabHiddenBecause("draft", SOLO));
  });

  it("does the same for the bracket and for the two people screens", () => {
    for (const asked of ["format", "teams", "captains"] as const) {
      const landing = landOn(asked, SOLO);
      expect(landing.tab, asked).toBe("setup");
      expect(landing.setup, asked).toBe("shape");
      expect(landing.asked, asked).toBe(asked);
      expect(landing.why, asked).not.toBeNull();
    }
  });

  it("moves nothing, and says nothing, when the tab does apply", () => {
    for (const asked of ["draft", "teams", "schedule", "results"] as const) {
      expect(landOn(asked, TEAMS_WITH_DRAFT), asked).toEqual({
        tab: asked,
        setup: "basics",
        asked: null,
        why: null,
      });
    }
  });

  it("still lands a stale bookmark on Setup with nothing said", () => {
    // `tabFrom`'s existing rule, unchanged: there is no explanation to give for
    // a word that was never a tab.
    expect(landOn("archive", SOLO)).toEqual({
      tab: "setup",
      setup: "basics",
      asked: null,
      why: null,
    });
  });

  it("moves the admin off a tab that stopped applying under them", () => {
    /*
     * The case that opens after the arrival: an admin on the Teams tab turns
     * teams off from Setup, and the tab they were looking at a moment ago is
     * gone. Reaching it needs a click, so the decision is asserted here rather
     * than through the editor — see `standingOn`.
     */
    expect(standingOn("teams", SOLO, null)).toEqual({
      here: "setup",
      notice: tabHiddenBecause("teams", SOLO),
    });
    expect(standingOn("draft", TEAMS_NO_DRAFT, null)).toEqual({
      here: "setup",
      notice: tabHiddenBecause("draft", TEAMS_NO_DRAFT),
    });
  });

  it("leaves the admin where they are when the tab still applies", () => {
    for (const tab of TAB_KEYS) {
      expect(standingOn(tab, TEAMS_WITH_DRAFT, null), tab).toEqual({
        here: tab,
        notice: null,
      });
    }
  });

  it("prefers the live reason to the one the server gave on arrival", () => {
    // The server's sentence describes a redirect that has already happened; the
    // live one describes the editor as it is now.
    expect(standingOn("teams", SOLO, "stale").notice).not.toBe("stale");
    expect(standingOn("setup", SOLO, "stale").notice).toBe("stale");
  });

  it("carries the arrival sentence through on every tab that applies", () => {
    expect(standingOn("schedule", SOLO, "why you are here")).toEqual({
      here: "schedule",
      notice: "why you are here",
    });
  });

  it("keeps a Setup alias on its own panel rather than redirecting it", () => {
    expect(landOn("championship", SOLO)).toEqual({
      tab: "setup",
      setup: "championship",
      asked: null,
      why: null,
    });
  });
});

/* --------------------------------------------------------------------- */
/* What is stored, and what is not (R-218 / UC-42 4)                     */
/* --------------------------------------------------------------------- */

describe("the stored shape", () => {
  it("reads an event stored before this panel existed as the event it was", () => {
    // Every event on the site showed all nine tabs. A default of `false` would
    // take four of them away from all of them at once.
    expect(eventShapeFrom(null)).toEqual({
      teamEvent: true,
      draft: true,
      sizing: { mode: "perTeam", value: 6 },
    });
    expect(eventShapeFrom({})).toEqual(eventShapeFrom(null));
    expect(visibleTabs(eventShapeFrom({}))).toEqual([...TAB_KEYS]);
  });

  it("takes the side size from the night's own format rather than inventing one", () => {
    expect(eventShapeFrom({ teamFormat: "3v3" }).sizing).toEqual({
      mode: "perTeam",
      value: 3,
    });
  });

  it("reads what was stored", () => {
    expect(
      eventShapeFrom({
        eventShape: { teamEvent: false, draft: false, sizing: { mode: "teams", value: 4 } },
      })
    ).toEqual({
      teamEvent: false,
      draft: false,
      sizing: { mode: "teams", value: 4 },
    });
  });

  it("keeps the draft answer while teams are off, so turning them back on restores it", () => {
    const shape = eventShapeFrom({
      eventShape: { teamEvent: false, draft: true, sizing: { mode: "teams", value: 4 } },
    });
    expect(shape.draft).toBe(true);
    // And it changes nothing about what is drawn: a solo event has no Draft tab
    // whatever the answer says.
    expect(visibleTabs(shape)).not.toContain("draft");
  });

  it("ignores rubbish rather than crashing on it", () => {
    for (const stored of [
      { eventShape: "teams" as const },
      { eventShape: [1, 2] },
      { eventShape: { sizing: "lots" as const } },
      { eventShape: { sizing: { mode: "sideways", value: -3 } } },
      { eventShape: { sizing: { mode: "perTeam", value: 2.5 } } },
    ]) {
      const shape = eventShapeFrom(stored);
      expect(shape.teamEvent, JSON.stringify(stored)).toBe(true);
      expect(Number.isInteger(shape.sizing.value), JSON.stringify(stored)).toBe(true);
      expect(shape.sizing.value).toBeGreaterThan(0);
    }
  });

  it("falls back to the smallest legal count in the teams mode", () => {
    expect(eventShapeFrom({ eventShape: { sizing: { mode: "teams" } } }).sizing).toEqual({
      mode: "teams",
      value: MIN_TEAMS,
    });
  });

  it("knows a sizing mode off the wire from anything else", () => {
    expect(isSizingMode("teams")).toBe(true);
    expect(isSizingMode("perTeam")).toBe(true);
    for (const raw of ["Teams", "per-team", "", null, 3, undefined, {}]) {
      expect(isSizingMode(raw), String(raw)).toBe(false);
    }
  });
});

/* --------------------------------------------------------------------- */
/* The bounds                                                            */
/* --------------------------------------------------------------------- */

describe("what cannot be saved", () => {
  const teamsMode = (value: number) => ({
    teamEvent: true,
    draft: true,
    sizing: { mode: "teams" as const, value },
  });
  const perTeam = (value: number) => ({
    teamEvent: true,
    draft: true,
    sizing: { mode: "perTeam" as const, value },
  });

  it("holds a team count to the range an event can have", () => {
    expect(shapeProblem(teamsMode(MIN_TEAMS))).toBeNull();
    expect(shapeProblem(teamsMode(MAX_TEAMS))).toBeNull();
    expect(shapeProblem(teamsMode(MIN_TEAMS - 1))).toBe(
      `An event has between ${MIN_TEAMS} and ${MAX_TEAMS} teams.`
    );
    expect(shapeProblem(teamsMode(MAX_TEAMS + 1))).toContain(`${MAX_TEAMS}`);
  });

  it("holds a side size to one player at least and a typo at most", () => {
    expect(shapeProblem(perTeam(1))).toBeNull();
    expect(shapeProblem(perTeam(MAX_PER_TEAM))).toBeNull();
    expect(shapeProblem(perTeam(0))).toBe(
      `A team holds between 1 and ${MAX_PER_TEAM} players.`
    );
    // The case the bound exists for: `66` typed for `6`.
    expect(shapeProblem(perTeam(66))).not.toBeNull();
  });

  it("refuses a box that is not a number rather than reading it as a zero", () => {
    expect(shapeProblem(perTeam(Number.NaN))).toContain("whole number");
    expect(shapeProblem(teamsMode(Number.NaN))).toContain("whole number");
    expect(shapeProblem(perTeam(3.5))).toContain("whole number");
  });

  it("holds nothing against the figure on a solo event", () => {
    // An admin turning teams off should not be stopped by a number that no
    // longer describes anything.
    expect(
      shapeProblem({
        teamEvent: false,
        draft: false,
        sizing: { mode: "perTeam", value: Number.NaN },
      })
    ).toBeNull();
  });

  it("words the two refusals so neither is satisfied by the other", () => {
    // Task 78's `toContain` escape: a refusal assertion passed because a
    // *different* refusal carried the same phrase. These two must not share one.
    expect(DRAFT_AWARDED_REFUSAL).toContain("Void the awards on the Draft tab");
    expect(DRAFT_AWARDED_REFUSAL).not.toContain("Void those lots first");
    expect(teamsInTheWayRefusal(3)).toContain("3 teams");
    expect(teamsInTheWayRefusal(3)).not.toContain("Void");
    expect(teamsInTheWayRefusal(1)).toContain("1 team.");
  });
});

/* --------------------------------------------------------------------- */
/* The derived figure (R-218 / UC-42 4, 4a, 4b)                          */
/* --------------------------------------------------------------------- */

describe("the figure that follows", () => {
  it("prints the use case's own sentence", () => {
    // UC-42 4: "6 per team, so 3 teams from the 18 accepted".
    const said = sizingConsequence({ mode: "perTeam", value: 6 }, 18);
    expect(said.stated).toBe("6 per team");
    expect(said.consequence).toBe("3 teams from the 18 accepted");
    expect(said.teams).toBe(3);
    expect(said.assumed).toBe(false);
    expect(said.short).toEqual([]);
  });

  it("changes with the accepted count and nothing else — no save in sight", () => {
    const sizing = { mode: "perTeam", value: 6 } as const;
    expect(sizingConsequence(sizing, 18).teams).toBe(3);
    expect(sizingConsequence(sizing, 19).teams).toBe(4);
    expect(sizingConsequence(sizing, 24).teams).toBe(4);
    // The stored half is identical in all three: one figure, one source.
    for (const accepted of [18, 19, 24]) {
      expect(sizingConsequence(sizing, accepted).stated).toBe("6 per team");
    }
  });

  it("reads the other way round too", () => {
    const said = sizingConsequence({ mode: "teams", value: 3 }, 18);
    expect(said.stated).toBe("3 teams");
    expect(said.consequence).toBe("6 per team from the 18 accepted");
    expect(said.sizes).toEqual([6, 6, 6]);
  });

  it("spreads the remainder one per team and says which sides are short", () => {
    // UC-42 4b. 16 into 3 is 6, 5, 5 — never 6, 6, 4.
    const said = sizingConsequence({ mode: "teams", value: 3 }, 16);
    expect(said.sizes).toEqual([6, 5, 5]);
    expect(said.short).toEqual([2, 3]);
    expect(said.consequence).toBe("6, 5, 5 from the 16 accepted — the remainder one per team");
  });

  it("names the short sides in the other mode from Task 78's own planner", () => {
    const said = sizingConsequence({ mode: "perTeam", value: 6 }, 16);
    expect(said.teams).toBe(3);
    expect(said.short).toEqual(planTeams(16, 6).ok ? [2, 3] : []);
  });

  it("states an assumption rather than a figure when nobody is accepted yet", () => {
    // UC-42 4a. "0 teams" and a confident 3 would both be untrue.
    const perTeam = sizingConsequence({ mode: "perTeam", value: 6 }, 0);
    expect(perTeam.assumed).toBe(true);
    expect(perTeam.teams).toBeNull();
    expect(perTeam.consequence).toContain("once anybody is");

    const teams = sizingConsequence({ mode: "teams", value: 3 }, 0);
    expect(teams.assumed).toBe(true);
    expect(teams.sizes).toEqual([]);
    expect(teams.consequence).toContain("once anybody is");
  });

  it("carries the planner's own refusal when no figure can be derived", () => {
    const said = sizingConsequence({ mode: "perTeam", value: 6 }, 4);
    expect(said.problem).toBe(
      planTeams(4, 6).ok ? null : (planTeams(4, 6) as { error: string }).error
    );
    expect(said.problem).toContain("Accept more");
    expect(said.teams).toBeNull();
  });

  it("uses Task 78's planner rather than a second copy of it", () => {
    // Proved by replacing it with a thrower: if this function were doing the
    // arithmetic itself the injected planner would never be reached.
    expect(() =>
      sizingConsequence({ mode: "perTeam", value: 6 }, 18, () => {
        throw new Error("the planner was not used");
      })
    ).toThrow("the planner was not used");
  });

  it("deals the same sides as the planner, in both directions, at every legal count", () => {
    // The anti-drift guard. `dealSizes` is given the number of sides and
    // `planTeams` works it out, so the two readings of "the remainder one per
    // team" must agree wherever both are defined.
    let checked = 0;
    for (const size of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (let people = 1; people <= 80; people += 1) {
        const plan = planTeams(people, size);
        if (!plan.ok) continue;
        expect(dealSizes(people, plan.plan.teams), `${people} at ${size}`).toEqual(
          plan.plan.sizes
        );
        checked += 1;
      }
    }
    // A floor, so a `continue` that swallowed every case fails rather than passes.
    expect(checked).toBeGreaterThan(200);
  });

  it("never loses or invents a player", () => {
    for (let teams = 1; teams <= MAX_TEAMS; teams += 1) {
      for (let people = 0; people <= 40; people += 1) {
        const sizes = dealSizes(people, teams);
        expect(sizes.length, `${people}/${teams}`).toBe(teams);
        expect(
          sizes.reduce((total, size) => total + size, 0),
          `${people}/${teams}`
        ).toBe(people);
        expect(Math.max(...sizes) - Math.min(...sizes), `${people}/${teams}`).toBeLessThanOrEqual(
          1
        );
      }
    }
  });

  it("deals nothing into no sides at all rather than dividing by zero", () => {
    expect(dealSizes(10, 0)).toEqual([]);
    expect(dealSizes(10, -1)).toEqual([]);
  });
});
