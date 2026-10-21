import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { resolveMatches } from "@/lib/format-resolve";

/*
 * What the two format screens *say* about the server's answers — UC-18 7a, 9a.
 *
 * Both tabs stopped deciding anything in Task 21. The Format tab used to run an
 * effect that compared row counts and called the generate action; it now reports
 * `stage.outOfDateSince`, which the server stamped. So the two things worth
 * asserting through the markup are exactly the two the effect used to get
 * wrong: that the out-of-date state is shown with its button, and that a
 * current stage shows neither.
 *
 * The router and the action modules are mocked for the reason
 * `teams-tab-placement.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
 *
 * **A static render cannot prove the effect is gone.** `renderToStaticMarkup`
 * never runs `useEffect`, so "the action mock was not called" would pass just
 * as happily with the effect still in the file. The only honest assertion about
 * an effect that must not exist is about the source, so there is one — and it
 * is as specific as it can be about what it bans, rather than banning effects.
 */

const actions = vi.hoisted(() => ({
  previewStagesAction: vi.fn(async () => []),
  rebuildStageAction: vi.fn(),
  saveStagesAction: vi.fn(),
  applyScheduleAction: vi.fn(),
  saveScheduleSettingsAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/format-actions", () => actions);

const { default: FormatTab } = await import("../FormatTab");
const { default: ScheduleTab } = await import("../ScheduleTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

/**
 * One stage of a `FormatView`, resolved by the real resolver from the real
 * generator — a hand-written board is what lets a screen and the engine drift.
 */
function stageView(over: Partial<StageView> = {}): StageView {
  const config = normaliseStageConfig("round_robin", { bestOf: 1 });
  const spec = generateStage("round_robin", TEAMS.length, config);
  return {
    id: "stage-1",
    name: "Round robin",
    kind: "round_robin",
    sort: 0,
    config: spec.config,
    teamCount: TEAMS.length,
    spec,
    matches: resolveMatches({ stage: spec, matches: [], teams: TEAMS, seeds: null }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: TEAMS.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
    ...over,
  };
}

function formatView(stage: StageView): FormatView {
  const blocks = planBlocks([stage.spec], {
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
    blockDays: null,
  });
  return {
    eventId: "event-1",
    teams: TEAMS,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
  };
}

/** Every slot has a row, which is what "has been generated" means. */
function allIds(view: FormatView): Record<string, string> {
  return Object.fromEntries(
    view.stages.flatMap((stage) => stage.matches.map((match) => [match.slot, `row-${match.slot}`]))
  );
}

function renderFormat(stage: StageView): string {
  const view = formatView(stage);
  return renderToStaticMarkup(
    createElement(FormatTab, {
      eventId: "event-1",
      format: view,
      matchIds: allIds(view),
      maxStages: 4,
    })
  );
}

/* ------------------------------------------------------------------ */
/* UC-18 9a — out of date, and the one button                         */
/* ------------------------------------------------------------------ */

describe("FormatTab reports what the server decided (UC-18 9a)", () => {
  it("no longer generates matches from the client at all (R-73)", () => {
    /*
     * The plan's words are "the client effect goes". It went, and this is what
     * stops it coming back: the tab holds no effect and cannot reach the
     * generate action, so "the matches follow the teams" cannot quietly become
     * "the matches follow the teams while this tab is open" again.
     */
    const source = fs.readFileSync(
      path.resolve(__dirname, "../FormatTab.tsx"),
      "utf8"
    );
    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("generateStageAction");
    // And the destructive write it does keep is the confirmed one, handed the
    // token the preview carried rather than a flag.
    expect(source).toContain("rebuildStageAction(stage.id, impact.confirm)");
  });

  it("offers nothing to press while the stage is current", () => {
    const html = renderFormat(stageView());

    expect(html).toContain("6 matches in the database, matching this shape.");
    expect(html).not.toContain("Rebuild anyway");
    expect(html).not.toContain("Out of date since");
  });

  it("says since when it is out of date, and offers “Rebuild anyway”", () => {
    const html = renderFormat(
      stageView({ outOfDateSince: "2026-06-20T18:00:00Z", matches: stageView().matches })
    );

    expect(html).toContain("Out of date since");
    expect(html).toContain("There are results in the way, so nothing was touched.");
    expect(html).toContain("Rebuild anyway");
  });

  it("names hand-moved times as well as results when the stage has both", () => {
    const html = renderFormat(
      stageView({
        outOfDateSince: "2026-06-20T18:00:00Z",
        handEditedAt: "2026-06-20T17:00:00Z",
      })
    );
    expect(html).toContain("results or hand-moved times in the way");
  });

  it("says a stage with no rows is built by saving", () => {
    const view = formatView(stageView());
    const html = renderToStaticMarkup(
      createElement(FormatTab, {
        eventId: "event-1",
        format: view,
        // No rows at all.
        matchIds: {},
        maxStages: 4,
      })
    );

    expect(html).toContain("This shape wants 6, and saving builds them.");
    expect(html).not.toContain("Rebuild anyway");
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 7a — a day that runs past midnight                           */
/* ------------------------------------------------------------------ */

describe("ScheduleTab warns about a day that overruns (UC-18 7a)", () => {
  /**
   * The tab prefills its day starts from the event's own day rows, so the
   * start time under test is the one on the event — not a value typed into the
   * markup, which a server render cannot do.
   */
  function renderSchedule(startsAt: string): string {
    const stage = stageView();
    const view = formatView(stage);
    return renderToStaticMarkup(
      createElement(ScheduleTab, {
        eventId: "event-1",
        event: {
          days: [{ startsAt, label: "Day 1" }],
        } as unknown as Parameters<typeof ScheduleTab>[0]["event"],
        format: view,
        matchIds: allIds(view),
        settings: {
          timing: DEFAULT_FORMAT_TIMING,
          concurrentLobbies: 2,
          days: 1,
          blockDays: null,
        },
      })
    );
  }

  it("says nothing about a day that finishes on the day it started", () => {
    // The suite pins Europe/Budapest. A 10:00 start over three Bo1 blocks ends
    // well before midnight.
    const html = renderSchedule("2026-06-20T08:00:00.000Z");
    expect(html).not.toContain("does not finish on the day it starts");
  });

  it("warns, and allows it, when the day ends past midnight", () => {
    // 23:30 local, so the last block is on the 21st.
    const html = renderSchedule("2026-06-20T21:30:00.000Z");
    expect(html).toContain("Day 1 does not finish on the day it starts");
    expect(html).toContain("past midnight");
    expect(html).toContain("Allowed, and sometimes the plan.");
  });
});
