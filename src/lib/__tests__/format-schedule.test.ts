/**
 * The scheduler, generalised.
 *
 * The first block of tests is the important one: it is the current board's
 * schedule suite re-pointed at the generated 4-team round robin plus double
 * elimination, at two lobbies over two days. Every number in it — the whole
 * planned grid, the overrun behaviour, the day independence, the anchoring
 * rules and both of the regressions Phase 0 fixed — is the same number the
 * hardcoded version produces. The rest cover what the hardcoded version could
 * not do at all: other team counts, other lobby counts, and four days.
 */

import { describe, expect, it } from "vitest";
import { type GeneratedStage, generateStage } from "@/lib/bracket";
import {
  DEFAULT_FORMAT_TIMING,
  type FormatTiming,
  normaliseFormatTiming,
} from "@/lib/format-policy";
import {
  type PlannedBlock,
  type SchedulableMatch,
  autoSchedule,
  dayMinutes,
  planBlocks,
  recalculateSchedule,
  schedulePreview,
  syncFinish,
} from "@/lib/format-schedule";

const D = DEFAULT_FORMAT_TIMING;
const DAY1 = "2025-08-15T14:00:00.000Z"; // 16:00 local
const DAY2 = "2025-08-16T14:00:00.000Z";
const CUSTOM: FormatTiming = {
  modeMinutes: { convoy: 20, domination: 10 },
  defaultMinutes: 20,
  betweenGames: 3,
  betweenSeries: 7,
};

/** The current board's tournament: a 4-team table, then a 4-team double elim. */
function boardStages(): GeneratedStage[] {
  return [generateStage("round_robin", 4), generateStage("double_elim", 4)];
}

function boardBlocks(timing: Partial<FormatTiming> = D): PlannedBlock[] {
  return planBlocks(boardStages(), {
    timing,
    concurrentLobbies: 2,
    days: 2,
    // The current board puts everything up to the upper final on day 1.
    blockDays: [1, 1, 1, 1, 1, 2, 2],
  });
}

function boardMatches(): SchedulableMatch[] {
  return boardStages()
    .flatMap((stage) => stage.matches)
    .map((match) => ({
      slot: match.slot,
      scheduledAt: null,
      finishedAt: null,
      durationMin: null,
    }));
}

/** The whole day-1/day-2 grid on the defaults, hand-computed from the plan. */
const PLANNED: Record<string, string> = {
  "rr-1-2": "2025-08-15T14:00:00.000Z",
  "rr-3-4": "2025-08-15T14:00:00.000Z",
  "rr-1-3": "2025-08-15T14:40:00.000Z",
  "rr-2-4": "2025-08-15T14:40:00.000Z",
  "rr-1-4": "2025-08-15T15:20:00.000Z",
  "rr-2-3": "2025-08-15T15:20:00.000Z",
  ubsf1: "2025-08-15T16:00:00.000Z",
  ubsf2: "2025-08-15T16:00:00.000Z",
  ubf: "2025-08-15T17:35:00.000Z",
  lbr1: "2025-08-15T17:35:00.000Z",
  lbf: "2025-08-16T14:00:00.000Z",
  gf: "2025-08-16T15:35:00.000Z",
};

function starts(matches: SchedulableMatch[]): Record<string, string | null> {
  return Object.fromEntries(matches.map((m) => [m.slot, m.scheduledAt]));
}

function at(matches: SchedulableMatch[], slot: string): SchedulableMatch {
  const match = matches.find((m) => m.slot === slot);
  if (!match) throw new Error(`no match ${slot}`);
  return match;
}

function scheduled(): { matches: SchedulableMatch[]; blocks: PlannedBlock[] } {
  const matches = boardMatches();
  const blocks = boardBlocks();
  autoSchedule(matches, blocks, [DAY1, DAY2], D);
  return { matches, blocks };
}

describe("blocks from the format", () => {
  it("reproduces the current board's seven blocks, in order", () => {
    expect(
      boardBlocks().map((b) => ({ day: b.day, label: b.label, slots: b.slots }))
    ).toEqual([
      { day: 1, label: "Round robin 1", slots: ["rr-1-2", "rr-3-4"] },
      { day: 1, label: "Round robin 2", slots: ["rr-1-3", "rr-2-4"] },
      { day: 1, label: "Round robin 3", slots: ["rr-1-4", "rr-2-3"] },
      { day: 1, label: "Upper semis", slots: ["ubsf1", "ubsf2"] },
      { day: 1, label: "Upper final + Lower round 1", slots: ["ubf", "lbr1"] },
      { day: 2, label: "Lower final · bronze", slots: ["lbf"] },
      { day: 2, label: "Grand final", slots: ["gf"] },
    ]);
  });

  it("gives each block the length of its slowest series", () => {
    expect(boardBlocks().map((b) => b.lengthMin)).toEqual([30, 30, 30, 85, 85, 85, 155]);
  });

  it("totals each day without a trailing break", () => {
    expect(dayMinutes(boardBlocks())).toEqual([300, 250]);
  });

  it("cuts a phase into as many blocks as the lobbies allow", () => {
    const stage = generateStage("double_elim", 8);
    const one = planBlocks([stage], { concurrentLobbies: 1 });
    const two = planBlocks([stage], { concurrentLobbies: 2 });
    const four = planBlocks([stage], { concurrentLobbies: 4 });
    expect(one).toHaveLength(14); // one match at a time
    expect(two.length).toBeLessThan(one.length);
    expect(four.length).toBeLessThan(two.length);
    // Whatever the cut, every match is in exactly one block.
    for (const blocks of [one, two, four]) {
      const slots = blocks.flatMap((b) => b.slots);
      expect(new Set(slots).size).toBe(14);
    }
  });

  it("never puts two matches of the same block in a phase they cannot share", () => {
    for (const teamCount of [2, 3, 4, 5, 6, 7, 8]) {
      const stage = generateStage("double_elim", teamCount);
      for (const block of planBlocks([stage], { concurrentLobbies: 4 })) {
        const phases = new Set(block.slots.map((slot) => stage.bySlot[slot].phase));
        expect(phases.size, `${teamCount} teams`).toBe(1);
      }
    }
  });

  it("never lets a block hold more matches than there are lobbies", () => {
    for (const lobbies of [1, 2, 3]) {
      for (const blocks of [
        planBlocks([generateStage("round_robin", 8)], { concurrentLobbies: lobbies }),
        planBlocks([generateStage("double_elim", 8)], { concurrentLobbies: lobbies }),
      ]) {
        for (const block of blocks) expect(block.slots.length).toBeLessThanOrEqual(lobbies);
      }
    }
  });

  it("keeps a stage's blocks together and in order", () => {
    const blocks = boardBlocks();
    const lastTable = blocks.findLastIndex((b) => b.slots[0].startsWith("rr-"));
    const firstBracket = blocks.findIndex((b) => !b.slots[0].startsWith("rr-"));
    expect(firstBracket).toBeGreaterThan(lastTable);
  });

  it("spreads across up to four days, balancing the longest one", () => {
    const blocks = planBlocks(boardStages(), { concurrentLobbies: 2, days: 4 });
    expect(new Set(blocks.map((b) => b.day)).size).toBe(4);
    const totals = dayMinutes(blocks);
    expect(totals).toHaveLength(4);
    expect(Math.max(...totals)).toBeLessThan(300);
  });

  it("never runs past four days", () => {
    const blocks = planBlocks(boardStages(), { concurrentLobbies: 1, days: 9 });
    expect(Math.max(...blocks.map((b) => b.day))).toBeLessThanOrEqual(4);
  });

  it("obeys an explicit day per block, and carries the last one forward", () => {
    const blocks = planBlocks(boardStages(), {
      concurrentLobbies: 2,
      days: 3,
      blockDays: [1, 1, 2],
    });
    expect(blocks.map((b) => b.day)).toEqual([1, 1, 2, 2, 2, 2, 2]);
  });

  it("puts everything on one day when nothing says otherwise", () => {
    expect(planBlocks(boardStages(), { concurrentLobbies: 2 }).every((b) => b.day === 1)).toBe(
      true
    );
  });

  it("takes the block lengths from the timing it is given", () => {
    // Bo3 under CUSTOM: 20 + 20 + 10, plus two three-minute breaks. Bo5:
    // 20 × 4 + 10, plus four.
    expect(boardBlocks(CUSTOM).map((b) => b.lengthMin)).toEqual([20, 20, 20, 56, 56, 56, 102]);
  });
});

describe("autoSchedule", () => {
  it("stamps every match with its planned start", () => {
    expect(starts(scheduled().matches)).toEqual(PLANNED);
  });

  it("gives the matches of a block the same start, since they run in parallel", () => {
    const { matches } = scheduled();
    expect(at(matches, "rr-1-2").scheduledAt).toBe(at(matches, "rr-3-4").scheduledAt);
    expect(at(matches, "ubsf1").scheduledAt).toBe(at(matches, "ubsf2").scheduledAt);
    expect(at(matches, "ubf").scheduledAt).toBe(at(matches, "lbr1").scheduledAt);
  });

  it("accepts a naive datetime-local start and stores an instant", () => {
    const matches = boardMatches();
    autoSchedule(matches, boardBlocks(), ["2025-08-15T16:00", "2025-08-16T16:00"], D);
    expect(at(matches, "rr-1-2").scheduledAt).toBe(DAY1);
    expect(at(matches, "lbf").scheduledAt).toBe(DAY2);
  });

  it("skips a day that was left blank", () => {
    const matches = boardMatches();
    autoSchedule(matches, boardBlocks(), [DAY1, ""], D);
    expect(at(matches, "rr-1-2").scheduledAt).toBe(DAY1);
    expect(at(matches, "lbf").scheduledAt).toBeNull();
    expect(at(matches, "gf").scheduledAt).toBeNull();
  });

  it("skips both days when neither has a start", () => {
    const matches = boardMatches();
    autoSchedule(matches, boardBlocks(), ["", ""], D);
    expect(Object.values(starts(matches)).every((v) => v === null)).toBe(true);
  });

  it("leaves an already-finished match in the slot it actually ran in", () => {
    const matches = boardMatches();
    const rr = at(matches, "rr-1-2");
    rr.scheduledAt = "2025-08-15T09:00:00.000Z";
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(matches, boardBlocks(), [DAY1, DAY2], D);
    expect(rr.scheduledAt).toBe("2025-08-15T09:00:00.000Z");
  });

  // Regression, carried over: an already-played match keeps its historical
  // start, and that start must not become the anchor for the rest of the day.
  it("keeps the day start it was given when the first block holds a finished match", () => {
    const matches = boardMatches();
    const rr = at(matches, "rr-1-2");
    rr.scheduledAt = "2025-08-15T09:00:00.000Z";
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(matches, boardBlocks(), [DAY1, DAY2], D);
    expect(at(matches, "rr-3-4").scheduledAt).toBe(DAY1);
    expect(at(matches, "ubsf1").scheduledAt).toBe(PLANNED.ubsf1);
    expect(at(matches, "lbf").scheduledAt).toBe(PLANNED.lbf);
  });

  it("is not order dependent: a finished match listed second behaves the same", () => {
    const matches = boardMatches();
    const rr = at(matches, "rr-3-4");
    rr.scheduledAt = "2025-08-15T09:00:00.000Z";
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(matches, boardBlocks(), [DAY1, DAY2], D);
    expect(at(matches, "rr-1-2").scheduledAt).toBe(DAY1);
    expect(at(matches, "ubsf1").scheduledAt).toBe(PLANNED.ubsf1);
  });

  it("re-flows the day from what actually happened, not just the raw plan", () => {
    const matches = boardMatches();
    const ubsf1 = at(matches, "ubsf1");
    ubsf1.scheduledAt = "2025-08-15T16:30:00.000Z";
    ubsf1.finishedAt = "2025-08-15T17:00:00.000Z";
    autoSchedule(matches, boardBlocks(), [DAY1, DAY2], D);

    expect(ubsf1.scheduledAt).toBe("2025-08-15T16:30:00.000Z");
    expect(at(matches, "ubsf2").scheduledAt).toBe("2025-08-15T16:00:00.000Z");
    // ubsf2 is unplayed, so the block is estimated to end at 16:00 + 85' = 17:25,
    // which is later than ubsf1's real 17:00 finish. Next block: 17:25 + 10'.
    expect(at(matches, "ubf").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
  });

  // Regression, carried over: the timing argument used to be discarded.
  it("honours the timing it is given for both the layout and the re-flow", () => {
    const matches = boardMatches();
    autoSchedule(matches, boardBlocks(CUSTOM), [DAY1, DAY2], CUSTOM);
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T14:27:00.000Z");
    expect(at(matches, "ubsf1").scheduledAt).toBe("2025-08-15T15:21:00.000Z");
    expect(at(matches, "gf").scheduledAt).toBe("2025-08-16T15:03:00.000Z");
  });
});

describe("recalculateSchedule", () => {
  it("is a no-op on a freshly auto-scheduled plan", () => {
    const { matches, blocks } = scheduled();
    recalculateSchedule(matches, blocks, { timing: D });
    expect(starts(matches)).toEqual(PLANNED);
  });

  it("does nothing when no day has an anchor", () => {
    const matches = boardMatches();
    expect(() => recalculateSchedule(matches, boardBlocks(), { timing: D })).not.toThrow();
    expect(Object.values(starts(matches)).every((v) => v === null)).toBe(true);
  });

  it("skips a day with no anchor and leaves the other intact", () => {
    const matches = boardMatches();
    const blocks = boardBlocks();
    autoSchedule(matches, blocks, [DAY1, ""], D);
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(at(matches, "lbf").scheduledAt).toBeNull();
  });

  it("ends a block at the LATEST finish and shifts the rest of the day", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z"; // 20' over
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:35:00.000Z"; // 5' over
    recalculateSchedule(matches, blocks, { timing: D });

    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(at(matches, "rr-2-4").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(at(matches, "rr-1-4").scheduledAt).toBe("2025-08-15T15:40:00.000Z");
    expect(at(matches, "ubsf1").scheduledAt).toBe("2025-08-15T16:20:00.000Z");
    expect(at(matches, "ubf").scheduledAt).toBe("2025-08-15T17:55:00.000Z");
  });

  it("pulls the rest of the day forward once every match in a block finishes early", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:20:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:25:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T14:35:00.000Z");
    expect(at(matches, "rr-1-4").scheduledAt).toBe("2025-08-15T15:15:00.000Z");
  });

  it("does not move later blocks while a parallel match is still running", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:20:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-3").scheduledAt).toBe(PLANNED["rr-1-3"]);
    expect(at(matches, "ubf").scheduledAt).toBe(PLANNED.ubf);
  });

  it("treats a finished-late match as the block end even if its partner is unfinished", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    // max(real 14:50, estimated 14:30) + 10'
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
  });

  it("never moves a finished match", () => {
    const { matches, blocks } = scheduled();
    const rr = at(matches, "rr-1-3");
    rr.finishedAt = "2025-08-15T15:10:00.000Z";
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:50:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(rr.scheduledAt).toBe(PLANNED["rr-1-3"]);
    expect(at(matches, "rr-2-4").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
  });

  it("keeps day 2 exactly where it was when day 1 overruns badly", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T18:00:00.000Z"; // four hours late
    at(matches, "rr-3-4").finishedAt = "2025-08-15T18:00:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "ubf").scheduledAt).toBe("2025-08-15T21:05:00.000Z");
    expect(at(matches, "lbf").scheduledAt).toBe(PLANNED.lbf);
    expect(at(matches, "gf").scheduledAt).toBe(PLANNED.gf);
  });

  it("re-flows day 2 from its own anchor", () => {
    const { matches, blocks } = scheduled();
    at(matches, "lbf").finishedAt = "2025-08-16T15:45:00.000Z"; // 20' over
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "gf").scheduledAt).toBe("2025-08-16T15:55:00.000Z");
    expect(at(matches, "rr-1-2").scheduledAt).toBe(PLANNED["rr-1-2"]);
  });

  it("returns the day to planned estimates when a finish is cleared", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-3").scheduledAt).not.toBe(PLANNED["rr-1-3"]);

    at(matches, "rr-1-2").finishedAt = null;
    at(matches, "rr-3-4").finishedAt = null;
    recalculateSchedule(matches, blocks, { timing: D });
    expect(starts(matches)).toEqual(PLANNED);
  });

  it("anchors a day from its first scheduled block, even if earlier ones are blank", () => {
    const matches = boardMatches();
    const blocks = boardBlocks();
    at(matches, "ubsf1").scheduledAt = "2025-08-15T16:00:00.000Z";
    at(matches, "ubsf2").scheduledAt = "2025-08-15T16:00:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-2").scheduledAt).toBeNull();
    expect(at(matches, "ubf").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
    expect(at(matches, "lbr1").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
  });

  it("normalises junk timing before using it", () => {
    const { matches } = scheduled();
    const junk = { modeMinutes: { convoy: 60, domination: -3 }, betweenGames: 0, betweenSeries: 0 };
    const blocks = boardBlocks(junk);
    recalculateSchedule(matches, blocks, { timing: junk });
    // convoy 60, domination back to 30 (the default for an unusable number),
    // and no breaks at all.
    expect(normaliseFormatTiming(junk).modeMinutes.domination).toBe(30);
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(at(matches, "rr-1-4").scheduledAt).toBe("2025-08-15T16:00:00.000Z");
  });

  it("is idempotent", () => {
    const { matches, blocks } = scheduled();
    at(matches, "rr-1-2").finishedAt = "2025-08-15T14:50:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    const once = starts(matches);
    recalculateSchedule(matches, blocks, { timing: D });
    recalculateSchedule(matches, blocks, { timing: D });
    expect(starts(matches)).toEqual(once);
  });

  it("keeps four days independent of each other", () => {
    const stages = boardStages();
    const blocks = planBlocks(stages, {
      timing: D,
      concurrentLobbies: 2,
      days: 4,
      blockDays: [1, 1, 2, 2, 3, 4, 4],
    });
    const matches = boardMatches();
    const days = [
      "2025-08-15T14:00:00.000Z",
      "2025-08-16T14:00:00.000Z",
      "2025-08-17T14:00:00.000Z",
      "2025-08-18T14:00:00.000Z",
    ];
    autoSchedule(matches, blocks, days, D);
    expect(at(matches, "rr-1-2").scheduledAt).toBe(days[0]);
    expect(at(matches, "rr-1-4").scheduledAt).toBe(days[1]);
    expect(at(matches, "ubf").scheduledAt).toBe(days[2]);
    expect(at(matches, "lbf").scheduledAt).toBe(days[3]);

    // Day 1 overruns by three hours; days 2, 3 and 4 do not move.
    at(matches, "rr-1-2").finishedAt = "2025-08-15T17:00:00.000Z";
    at(matches, "rr-3-4").finishedAt = "2025-08-15T17:00:00.000Z";
    recalculateSchedule(matches, blocks, { timing: D });
    expect(at(matches, "rr-1-3").scheduledAt).toBe("2025-08-15T17:10:00.000Z");
    expect(at(matches, "rr-1-4").scheduledAt).toBe(days[1]);
    expect(at(matches, "ubf").scheduledAt).toBe(days[2]);
    expect(at(matches, "lbf").scheduledAt).toBe(days[3]);
  });
});

describe("schedulePreview", () => {
  it("gives a clock window per block", () => {
    const preview = schedulePreview(boardBlocks(), [DAY1, DAY2]);
    expect(preview[0]).toMatchObject({
      startsAt: "2025-08-15T14:00:00.000Z",
      endsAt: "2025-08-15T14:30:00.000Z",
    });
    expect(preview[6]).toMatchObject({
      startsAt: "2025-08-16T15:35:00.000Z",
      endsAt: "2025-08-16T18:10:00.000Z",
    });
  });

  it("leaves a blank day without a window", () => {
    const preview = schedulePreview(boardBlocks(), [DAY1, null]);
    expect(preview[5].startsAt).toBeNull();
    expect(preview[5].endsAt).toBeNull();
  });
});

describe("syncFinish", () => {
  const clock = (iso: string) => new Date(iso);

  function decided(over: Partial<Parameters<typeof syncFinish>[0]> = {}) {
    return {
      slot: "ubsf1",
      scheduledAt: null,
      finishedAt: null,
      durationMin: null,
      bestOf: 3,
      winnerOverrideId: null,
      games: [
        { played: true, scoreA: 1, scoreB: 0 },
        { played: true, scoreA: 1, scoreB: 0 },
        { played: false, scoreA: 0, scoreB: 0 },
      ],
      ...over,
    };
  }

  it("clears the finish while the match is still undecided", () => {
    const match = decided({
      finishedAt: "2025-08-15T17:00:00.000Z",
      games: [
        { played: true, scoreA: 1, scoreB: 0 },
        { played: false, scoreA: 0, scoreB: 0 },
        { played: false, scoreA: 0, scoreB: 0 },
      ],
    });
    syncFinish(match, false, clock("2025-08-15T18:00:00.000Z"));
    expect(match.finishedAt).toBeNull();
  });

  it("stamps the finish the moment the series is decided", () => {
    const match = decided();
    syncFinish(match, false, clock("2025-08-15T17:20:00.000Z"));
    expect(match.finishedAt).toBe("2025-08-15T17:20:00.000Z");
  });

  it("stamps a finish for a match decided only by the admin's override", () => {
    const match = decided({
      winnerOverrideId: "t1",
      games: [
        { played: false, scoreA: 0, scoreB: 0 },
        { played: false, scoreA: 0, scoreB: 0 },
        { played: false, scoreA: 0, scoreB: 0 },
      ],
    });
    syncFinish(match, false, clock("2025-08-15T17:20:00.000Z"));
    expect(match.finishedAt).toBe("2025-08-15T17:20:00.000Z");
  });

  it("derives the duration from the scheduled start, to the nearest minute", () => {
    const match = decided({ scheduledAt: "2025-08-15T16:00:00.000Z" });
    syncFinish(match, false, clock("2025-08-15T17:05:40.000Z"));
    expect(match.durationMin).toBe(66);
  });

  it("cannot derive a duration without a scheduled start", () => {
    const match = decided();
    syncFinish(match, false, clock("2025-08-15T17:05:00.000Z"));
    expect(match.durationMin).toBeNull();
  });

  it("ignores a nonsense window rather than inventing a multi-day match", () => {
    const match = decided({ scheduledAt: "2025-08-12T16:00:00.000Z" });
    syncFinish(match, false, clock("2025-08-15T17:05:00.000Z"));
    expect(match.durationMin).toBeNull();
  });

  it("accepts a window of exactly 24 hours", () => {
    const match = decided({ scheduledAt: "2025-08-14T17:05:00.000Z" });
    syncFinish(match, false, clock("2025-08-15T17:05:00.000Z"));
    expect(match.durationMin).toBe(1440);
  });

  it("clamps a finish so it can never precede the scheduled start", () => {
    const match = decided({ scheduledAt: "2025-08-15T20:00:00.000Z" });
    syncFinish(match, false, clock("2025-08-15T15:00:00.000Z"));
    expect(match.finishedAt).toBe("2025-08-15T20:00:00.000Z");
    expect(match.durationMin).toBeNull();
  });

  it("keeps a finish that was already recorded", () => {
    const match = decided({
      scheduledAt: "2025-08-15T16:00:00.000Z",
      finishedAt: "2025-08-15T16:50:00.000Z",
    });
    syncFinish(match, false, clock("2025-08-15T23:00:00.000Z"));
    expect(match.finishedAt).toBe("2025-08-15T16:50:00.000Z");
    expect(match.durationMin).toBe(50);
  });

  it("lets an explicit duration win and back-computes the finish", () => {
    const match = decided({
      scheduledAt: "2025-08-15T16:00:00.000Z",
      finishedAt: "2025-08-15T18:30:00.000Z",
      durationMin: 42,
    });
    syncFinish(match, true, clock("2025-08-15T19:00:00.000Z"));
    expect(match.finishedAt).toBe("2025-08-15T16:42:00.000Z");
    expect(match.durationMin).toBe(42);
  });

  it("leaves an existing duration alone when none was given", () => {
    const match = decided({ scheduledAt: "2025-08-15T16:00:00.000Z", durationMin: 30 });
    syncFinish(match, false, clock("2025-08-15T17:05:00.000Z"));
    expect(match.durationMin).toBe(30);
  });

  it("defaults `now` to the real clock", () => {
    const match = decided();
    const before = Date.now();
    syncFinish(match, false);
    const stamped = Date.parse(match.finishedAt as string);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});
