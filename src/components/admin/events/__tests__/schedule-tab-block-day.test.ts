import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { resolveMatches } from "@/lib/format-resolve";

/*
 * Choosing which day each block of matches runs on — UC-18 E4, R-156.
 *
 * The planner is tested against the database in
 * `src/lib/__tests__/format-kept-results.test.ts`; what is left, and what the
 * audit never walked, is the screen the choice is made on: a day control per
 * block, a preview that shows the answer, and what happens to a set of choices
 * that no longer fits the plan it was made for.
 *
 * That last one was wrong in a way only a walk finds. The overrides were
 * ignored by the write and announced as ignored in an alert — while the preview
 * under both was still built *with* them, so the running order on screen was
 * not the one "Fill start times" would write.
 *
 * The router and the action module are mocked for the reason
 * `format-tab-out-of-date.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/format-actions", () => ({
  applyScheduleAction: vi.fn(),
  saveScheduleSettingsAction: vi.fn(),
}));

const { default: ScheduleTab, usableBlockDays } = await import("../ScheduleTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

/** A Bo1 round robin: six matches, one per circle-round phase pair. */
const CONFIG = normaliseStageConfig("round_robin", { bestOf: 1 });
const SPEC = generateStage("round_robin", TEAMS.length, CONFIG);

function view(settings: {
  concurrentLobbies: number;
  days: number;
  blockDays: number[] | null;
}): FormatView {
  const stage: StageView = {
    id: "stage-1",
    name: "Table",
    kind: "round_robin",
    sort: 0,
    config: SPEC.config,
    teamCount: TEAMS.length,
    spec: SPEC,
    matches: resolveMatches({ stage: SPEC, matches: [], teams: TEAMS, seeds: null }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: TEAMS.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
  };
  const blocks = planBlocks([SPEC], { timing: DEFAULT_FORMAT_TIMING, ...settings });
  return {
    eventId: "event-1",
    teams: TEAMS,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: settings.concurrentLobbies,
    days: settings.days,
  };
}

function render(settings: {
  concurrentLobbies: number;
  days: number;
  blockDays: number[] | null;
}): string {
  const format = view(settings);
  return renderToStaticMarkup(
    createElement(ScheduleTab, {
      eventId: "event-1",
      event: {
        days: [
          { startsAt: "2026-06-20T16:00:00.000Z", label: "Day 1" },
          { startsAt: "2026-06-21T16:00:00.000Z", label: "Day 2" },
        ],
      } as unknown as Parameters<typeof ScheduleTab>[0]["event"],
      format,
      matchIds: Object.fromEntries(
        format.stages.flatMap((stage) => stage.matches.map((m) => [m.slot, `row-${m.slot}`]))
      ),
      settings: { timing: DEFAULT_FORMAT_TIMING, ...settings },
    })
  );
}

/** Which day each block's own select is showing, in block order. */
function chosenDays(html: string): number[] {
  return [...html.matchAll(/aria-label="Day for [^"]*"[^>]*>(.*?)<\/select>/g)].map((match) => {
    const selected = /<option value="(\d+)" selected="">/.exec(match[1]);
    return Number(selected?.[1] ?? 0);
  });
}

/* ------------------------------------------------------------------ */
/* usableBlockDays                                                    */
/* ------------------------------------------------------------------ */

describe("usableBlockDays (UC-18 E4, R-156)", () => {
  it("keeps a list that has one entry per block", () => {
    expect(usableBlockDays([1, 1, 2], 3)).toEqual([1, 1, 2]);
  });

  it("drops a list the plan has outgrown", () => {
    // Six blocks and three choices: entry 3 would now name a different block,
    // and `assignDays` would carry day 2 across the whole untouched tail.
    expect(usableBlockDays([1, 1, 2], 6)).toBeNull();
  });

  it("drops a list the plan has shrunk under", () => {
    expect(usableBlockDays([1, 1, 2, 2, 2, 2], 3)).toBeNull();
  });

  it("reads no choices and an empty list the same way", () => {
    expect(usableBlockDays(null, 3)).toBeNull();
    expect(usableBlockDays([], 3)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The screen                                                         */
/* ------------------------------------------------------------------ */

describe("the Schedule tab on which day a block runs (UC-18 E4, R-156)", () => {
  it("gives every block its own day control, one option per day", () => {
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: null });
    const controls = [...html.matchAll(/aria-label="Day for /g)].length;

    expect(controls).toBe(6);
    expect(html).toContain(">Day 1</option>");
    expect(html).toContain(">Day 2</option>");
    expect(html).not.toContain(">Day 3</option>");
  });

  it("shows the balanced split when nobody has chosen, and says it is balancing", () => {
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: null });

    expect(chosenDays(html)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(html).toContain("Blocks are split into 2 days so the longest day is as short as");
  });

  it("follows the chosen days, and says it is following them", () => {
    /*
     * One block moved off day 1. The control has to show the choice, the
     * preview has to be built from it, and the sentence under the button has
     * to stop claiming the days are being balanced.
     */
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: [1, 1, 2, 2, 2, 2] });

    expect(chosenDays(html)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(html).toContain("Following your overrides.");
    expect(html).not.toContain("Blocks are split into 2 days");
  });

  it("recomputes both days' clock windows when a block moves", () => {
    /*
     * "System recomputes both days." Day 2 starts at 18:00 local, so its
     * first block opens at 18:00 whichever block that is — which is the whole
     * difference between a day and an offset into day 1.
     */
    const stayed = render({ concurrentLobbies: 1, days: 2, blockDays: [1, 1, 1, 2, 2, 2] });
    const moved = render({ concurrentLobbies: 1, days: 2, blockDays: [1, 1, 2, 2, 2, 2] });

    // Three blocks on day 1 is 110 minutes; two is 70.
    expect(stayed).toContain("Day 1 · 3 blocks");
    expect(stayed).toContain("18:00 – 19:50");
    expect(moved).toContain("Day 1 · 2 blocks");
    expect(moved).toContain("18:00 – 19:10");
    // And day 2 grows to four blocks, which runs to 18:00 + 2h 30m.
    expect(moved).toContain("Day 2 · 4 blocks");
    expect(moved).toContain("18:00 – 20:30");
  });

  it("ignores choices the plan has outgrown, in the preview as well as the write", () => {
    /*
     * The bug. Three choices against six blocks: the alert said they were
     * being ignored and `fields()` sent `null`, but `planBlocks` was still
     * handed the stale list — so the preview put five blocks on day 2 while
     * the fill would have balanced them three and three.
     */
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: [1, 2, 2] });

    expect(html).toContain("The day overrides no longer fit the plan");
    expect(html).toContain("There are now 6 blocks and 3 overrides.");
    // Balanced, which is what the save would store — not [1, 2, 2, 2, 2, 2].
    expect(chosenDays(html)).toEqual([1, 1, 1, 2, 2, 2]);
    // And all three accounts of it agree: the alert, the preview and the line
    // under the button.
    expect(html).toContain("Blocks are split into 2 days");
    expect(html).not.toContain("Following your overrides.");
  });

  it("says nothing about stale choices while they still fit", () => {
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: [1, 1, 1, 2, 2, 2] });
    expect(html).not.toContain("The day overrides no longer fit the plan");
  });

  it("does not call an empty list of choices stale", () => {
    // `scheduleSettingsFrom` reads an empty list as "no choices", so an alert
    // about it would be an alert about nothing.
    const html = render({ concurrentLobbies: 1, days: 2, blockDays: [] });
    expect(html).not.toContain("The day overrides no longer fit the plan");
    expect(chosenDays(html)).toEqual([1, 1, 1, 2, 2, 2]);
  });
});
