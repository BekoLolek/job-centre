import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMING,
  autoSchedule,
  recalculateSchedule,
  syncFinish,
} from "@/lib/tournament";
import type { DraftState, Match, Timing } from "@/lib/types";
import { makeState, matchIn, playGame, playSeries } from "./helpers";

const D = DEFAULT_TIMING;
const DAY1 = "2025-08-15T14:00:00.000Z"; // 16:00 local
const DAY2 = "2025-08-16T14:00:00.000Z";
const CUSTOM: Timing = { convoy: 20, domination: 10, betweenGames: 3, betweenSeries: 7 };

/** The whole day-1/day-2 grid on the defaults, hand-computed from the plan. */
const PLANNED: Record<string, string> = {
  "rr-c1-c2": "2025-08-15T14:00:00.000Z",
  "rr-c3-c4": "2025-08-15T14:00:00.000Z",
  "rr-c1-c3": "2025-08-15T14:40:00.000Z",
  "rr-c2-c4": "2025-08-15T14:40:00.000Z",
  "rr-c1-c4": "2025-08-15T15:20:00.000Z",
  "rr-c2-c3": "2025-08-15T15:20:00.000Z",
  ubsf1: "2025-08-15T16:00:00.000Z",
  ubsf2: "2025-08-15T16:00:00.000Z",
  ubf: "2025-08-15T17:35:00.000Z",
  lbr1: "2025-08-15T17:35:00.000Z",
  lbf: "2025-08-16T14:00:00.000Z",
  gf: "2025-08-16T15:35:00.000Z",
};

function starts(state: DraftState): Record<string, string | null> {
  return Object.fromEntries(state.tournament.matches.map((m) => [m.id, m.scheduledAt]));
}

function scheduled(): DraftState {
  const state = makeState();
  autoSchedule(state, DAY1, DAY2, D);
  return state;
}

describe("autoSchedule", () => {
  it("stamps every match with its planned start", () => {
    expect(starts(scheduled())).toEqual(PLANNED);
  });

  it("gives the two matches of a block the same start, since they run in parallel", () => {
    const s = scheduled();
    expect(matchIn(s, "rr-c1-c2").scheduledAt).toBe(matchIn(s, "rr-c3-c4").scheduledAt);
    expect(matchIn(s, "ubsf1").scheduledAt).toBe(matchIn(s, "ubsf2").scheduledAt);
    expect(matchIn(s, "ubf").scheduledAt).toBe(matchIn(s, "lbr1").scheduledAt);
  });

  it("accepts a naive datetime-local start and stores an instant", () => {
    const state = makeState();
    autoSchedule(state, "2025-08-15T16:00", "2025-08-16T16:00", D);
    expect(matchIn(state, "rr-c1-c2").scheduledAt).toBe(DAY1);
    expect(matchIn(state, "lbf").scheduledAt).toBe(DAY2);
  });

  it("skips a day that was left blank", () => {
    const state = makeState();
    autoSchedule(state, DAY1, "", D);
    expect(matchIn(state, "rr-c1-c2").scheduledAt).toBe(DAY1);
    expect(matchIn(state, "lbf").scheduledAt).toBeNull();
    expect(matchIn(state, "gf").scheduledAt).toBeNull();
  });

  it("skips both days when neither has a start", () => {
    const state = makeState();
    autoSchedule(state, "", "", D);
    expect(Object.values(starts(state)).every((v) => v === null)).toBe(true);
  });

  it("leaves an already-finished match in the slot it actually ran in", () => {
    const state = makeState();
    const rr = matchIn(state, "rr-c1-c2");
    rr.scheduledAt = "2025-08-15T09:00:00.000Z";
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(state, DAY1, DAY2, D);
    expect(rr.scheduledAt).toBe("2025-08-15T09:00:00.000Z");
  });

  // Regression: an already-played match keeps its historical start, and that start must
  // not become the anchor for the rest of the day — the day start the admin just typed
  // wins. Previously this dragged every unplayed match back to when the played one ran.
  it("keeps the day start it was given when the first block holds a finished match", () => {
    const state = makeState();
    const rr = matchIn(state, "rr-c1-c2");
    rr.scheduledAt = "2025-08-15T09:00:00.000Z"; // it ran this morning, off-schedule
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(state, DAY1, DAY2, D);
    expect(matchIn(state, "rr-c3-c4").scheduledAt).toBe(DAY1);
    expect(matchIn(state, "ubsf1").scheduledAt).toBe(PLANNED.ubsf1);
    // Day 2 has its own anchor and is unaffected either way.
    expect(matchIn(state, "lbf").scheduledAt).toBe(PLANNED.lbf);
  });

  it("is not order dependent: a finished match listed second behaves the same", () => {
    const state = makeState();
    const rr = matchIn(state, "rr-c3-c4"); // the second id of block 1
    rr.scheduledAt = "2025-08-15T09:00:00.000Z";
    rr.finishedAt = "2025-08-15T09:30:00.000Z";
    autoSchedule(state, DAY1, DAY2, D);
    expect(matchIn(state, "rr-c1-c2").scheduledAt).toBe(DAY1);
    expect(matchIn(state, "ubsf1").scheduledAt).toBe(PLANNED.ubsf1);
  });

  it("re-flows the day from what actually happened, not just the raw plan", () => {
    const state = makeState();
    const ubsf1 = matchIn(state, "ubsf1");
    ubsf1.scheduledAt = "2025-08-15T16:30:00.000Z";
    ubsf1.finishedAt = "2025-08-15T17:00:00.000Z"; // overran into the next block
    autoSchedule(state, DAY1, DAY2, D);

    expect(ubsf1.scheduledAt).toBe("2025-08-15T16:30:00.000Z");
    expect(matchIn(state, "ubsf2").scheduledAt).toBe("2025-08-15T16:00:00.000Z");
    // ubsf2 is unplayed, so the block is estimated to end at 16:00 + 85' = 17:25,
    // which is later than ubsf1's real 17:00 finish. Next block: 17:25 + 10'.
    expect(matchIn(state, "ubf").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
  });

  it("uses the timing stored on the state when it matches the argument", () => {
    const state = makeState();
    state.tournament.timing = { ...CUSTOM };
    autoSchedule(state, DAY1, DAY2, CUSTOM);
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T14:27:00.000Z");
    expect(matchIn(state, "ubsf1").scheduledAt).toBe("2025-08-15T15:21:00.000Z");
    expect(matchIn(state, "gf").scheduledAt).toBe("2025-08-16T15:03:00.000Z");
  });

  // Regression: the timing argument used to be discarded, because autoSchedule laid the
  // grid out with it and then re-flowed the day from state.tournament.timing.
  it("honours the timing argument even when the state still holds the old timing", () => {
    const state = makeState(); // state.tournament.timing is the default set
    autoSchedule(state, DAY1, DAY2, CUSTOM);
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T14:27:00.000Z");
  });
});

describe("recalculateSchedule", () => {
  it("is a no-op on a freshly auto-scheduled state", () => {
    const state = scheduled();
    recalculateSchedule(state);
    expect(starts(state)).toEqual(PLANNED);
  });

  it("does nothing when no day has an anchor", () => {
    const state = makeState();
    expect(() => recalculateSchedule(state)).not.toThrow();
    expect(Object.values(starts(state)).every((v) => v === null)).toBe(true);
  });

  it("skips a day that has no scheduled anchor and leaves the other day intact", () => {
    const state = makeState();
    autoSchedule(state, DAY1, "", D);
    // Give day 1 a real overrun; day 2 must stay untouched (still unscheduled).
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z";
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(state);
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(matchIn(state, "lbf").scheduledAt).toBeNull();
    expect(matchIn(state, "gf").scheduledAt).toBeNull();
  });

  it("ends a block at the LATEST finish, not the earliest, and shifts the rest of the day", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z"; // 20' over
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:35:00.000Z"; // 5' over
    recalculateSchedule(state);

    // 14:50 (latest) + 10' break
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(matchIn(state, "rr-c2-c4").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(matchIn(state, "rr-c1-c4").scheduledAt).toBe("2025-08-15T15:40:00.000Z");
    expect(matchIn(state, "ubsf1").scheduledAt).toBe("2025-08-15T16:20:00.000Z");
    expect(matchIn(state, "ubf").scheduledAt).toBe("2025-08-15T17:55:00.000Z");
  });

  it("pulls the rest of the day forward once every match in a block finishes early", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:20:00.000Z";
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:25:00.000Z";
    recalculateSchedule(state);
    // 14:25 + 10'
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T14:35:00.000Z");
    expect(matchIn(state, "rr-c1-c4").scheduledAt).toBe("2025-08-15T15:15:00.000Z");
  });

  it("does not move later blocks while a parallel match of the block is still running", () => {
    const state = scheduled();
    // One of the pair finished early; the other has not finished at all, so the block
    // is still only estimated to be over at 14:00 + 30' = 14:30.
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:20:00.000Z";
    recalculateSchedule(state);
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe(PLANNED["rr-c1-c3"]);
    expect(matchIn(state, "ubf").scheduledAt).toBe(PLANNED.ubf);
  });

  it("treats a finished-late match as the block end even if its partner is unfinished", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z";
    recalculateSchedule(state);
    // max(real 14:50, estimated 14:30) + 10'
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
  });

  it("never moves a finished match", () => {
    const state = scheduled();
    const rr = matchIn(state, "rr-c1-c3");
    rr.finishedAt = "2025-08-15T15:10:00.000Z";
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z";
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:50:00.000Z";
    recalculateSchedule(state);
    // Its block moved to 15:00, but a played match keeps the slot it ran in.
    expect(rr.scheduledAt).toBe(PLANNED["rr-c1-c3"]);
    expect(matchIn(state, "rr-c2-c4").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
  });

  it("keeps day 2 exactly where it was when day 1 overruns badly", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T18:00:00.000Z"; // four hours late
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T18:00:00.000Z";
    recalculateSchedule(state);
    // 18:00 + 10' break, then 30'+10', 30'+10', 85'+10' → 21:05
    expect(matchIn(state, "ubf").scheduledAt).toBe("2025-08-15T21:05:00.000Z");
    expect(matchIn(state, "lbf").scheduledAt).toBe(PLANNED.lbf);
    expect(matchIn(state, "gf").scheduledAt).toBe(PLANNED.gf);
  });

  it("re-flows day 2 from its own anchor", () => {
    const state = scheduled();
    matchIn(state, "lbf").finishedAt = "2025-08-16T15:45:00.000Z"; // 20' over
    recalculateSchedule(state);
    expect(matchIn(state, "gf").scheduledAt).toBe("2025-08-16T15:55:00.000Z");
    expect(matchIn(state, "rr-c1-c2").scheduledAt).toBe(PLANNED["rr-c1-c2"]);
  });

  it("returns the day to planned estimates when a finish is cleared", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z";
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(state);
    expect(matchIn(state, "rr-c1-c3").scheduledAt).not.toBe(PLANNED["rr-c1-c3"]);

    matchIn(state, "rr-c1-c2").finishedAt = null;
    matchIn(state, "rr-c3-c4").finishedAt = null;
    recalculateSchedule(state);
    expect(starts(state)).toEqual(PLANNED);
  });

  it("anchors a day from its first scheduled block, even if earlier blocks are blank", () => {
    const state = makeState();
    // Only the semis were given a time; the round robin was played off-schedule.
    matchIn(state, "ubsf1").scheduledAt = "2025-08-15T16:00:00.000Z";
    matchIn(state, "ubsf2").scheduledAt = "2025-08-15T16:00:00.000Z";
    recalculateSchedule(state);
    expect(matchIn(state, "rr-c1-c2").scheduledAt).toBeNull();
    expect(matchIn(state, "ubf").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
    expect(matchIn(state, "lbr1").scheduledAt).toBe("2025-08-15T17:35:00.000Z");
  });

  it("uses the timing stored on the state, normalising junk first", () => {
    const state = scheduled();
    state.tournament.timing = { convoy: 60, domination: -3, betweenGames: 0, betweenSeries: 0 };
    recalculateSchedule(state);
    // convoy 60, domination back to 15, no breaks at all.
    expect(matchIn(state, "rr-c1-c3").scheduledAt).toBe("2025-08-15T15:00:00.000Z");
    expect(matchIn(state, "rr-c1-c4").scheduledAt).toBe("2025-08-15T16:00:00.000Z");
    // Upper semis: bo3 = 60 + 60 + 15 = 135'
    expect(matchIn(state, "ubsf1").scheduledAt).toBe("2025-08-15T17:00:00.000Z");
    expect(matchIn(state, "ubf").scheduledAt).toBe("2025-08-15T19:15:00.000Z");
  });

  it("is idempotent", () => {
    const state = scheduled();
    matchIn(state, "rr-c1-c2").finishedAt = "2025-08-15T14:50:00.000Z";
    matchIn(state, "rr-c3-c4").finishedAt = "2025-08-15T14:45:00.000Z";
    recalculateSchedule(state);
    const once = starts(state);
    recalculateSchedule(state);
    recalculateSchedule(state);
    expect(starts(state)).toEqual(once);
  });
});

describe("syncFinish", () => {
  const at = (iso: string) => new Date(iso);

  function bo3(over: Partial<Match> = {}): Match {
    const state = makeState();
    const m = matchIn(state, "ubsf1");
    Object.assign(m, over);
    return m;
  }

  function decidedBo3(over: Partial<Match> = {}): Match {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    const m = matchIn(state, "ubsf1");
    Object.assign(m, over);
    return m;
  }

  it("clears the finish while the match is still undecided", () => {
    const state = makeState();
    playGame(state, "ubsf1", 0, 1, 0); // 1-0 in a best-of-3: not over
    const m = matchIn(state, "ubsf1");
    m.finishedAt = "2025-08-15T17:00:00.000Z";
    syncFinish(m, false, at("2025-08-15T18:00:00.000Z"));
    expect(m.finishedAt).toBeNull();
  });

  it("clears the finish of a match with no games played at all", () => {
    const m = bo3({ finishedAt: "2025-08-15T17:00:00.000Z" });
    syncFinish(m, false, at("2025-08-15T18:00:00.000Z"));
    expect(m.finishedAt).toBeNull();
  });

  it("stamps the finish the moment the series is decided", () => {
    const m = decidedBo3();
    syncFinish(m, false, at("2025-08-15T17:20:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:20:00.000Z");
  });

  it("stamps a finish for a match decided only by the admin's override", () => {
    const m = bo3({ teamA: "c1", teamB: "c2", winnerOverride: "c1" });
    syncFinish(m, false, at("2025-08-15T17:20:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:20:00.000Z");
  });

  it("derives the duration from the scheduled start", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-15T16:00:00.000Z" });
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:05:00.000Z");
    expect(m.durationMin).toBe(65);
  });

  it("rounds a derived duration to the nearest minute", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-15T16:00:00.000Z" });
    syncFinish(m, false, at("2025-08-15T16:30:40.000Z"));
    expect(m.durationMin).toBe(31);
  });

  it("cannot derive a duration without a scheduled start", () => {
    const m = decidedBo3({ scheduledAt: null });
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:05:00.000Z");
    expect(m.durationMin).toBeNull();
  });

  it("ignores a nonsense window rather than inventing a multi-day match", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-12T16:00:00.000Z" }); // three days earlier
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:05:00.000Z");
    expect(m.durationMin).toBeNull();
  });

  it("accepts a window of exactly 24 hours", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-14T17:05:00.000Z" });
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.durationMin).toBe(1440);
  });

  it("clamps a finish so it can never precede the scheduled start", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-15T20:00:00.000Z" });
    syncFinish(m, false, at("2025-08-15T15:00:00.000Z")); // recorded five hours early
    expect(m.finishedAt).toBe("2025-08-15T20:00:00.000Z");
    // The clamped window is zero minutes long, which is not a real duration.
    expect(m.durationMin).toBeNull();
  });

  it("keeps a finish that was already recorded", () => {
    const m = decidedBo3({
      scheduledAt: "2025-08-15T16:00:00.000Z",
      finishedAt: "2025-08-15T16:50:00.000Z",
    });
    syncFinish(m, false, at("2025-08-15T23:00:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T16:50:00.000Z");
    expect(m.durationMin).toBe(50);
  });

  it("lets an explicit duration win and back-computes the finish", () => {
    const m = decidedBo3({
      scheduledAt: "2025-08-15T16:00:00.000Z",
      finishedAt: "2025-08-15T18:30:00.000Z",
      durationMin: 42,
    });
    syncFinish(m, true, at("2025-08-15T19:00:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T16:42:00.000Z");
    expect(m.durationMin).toBe(42);
  });

  it("back-computes the finish from a duration given on a match that had none", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-15T16:00:00.000Z", durationMin: 90 });
    syncFinish(m, true, at("2025-08-15T23:00:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:30:00.000Z");
  });

  it("ignores an explicit duration when there is no scheduled start to anchor it", () => {
    const m = decidedBo3({ scheduledAt: null, durationMin: 42 });
    syncFinish(m, true, at("2025-08-15T17:05:00.000Z"));
    expect(m.finishedAt).toBe("2025-08-15T17:05:00.000Z");
    expect(m.durationMin).toBe(42);
  });

  it("leaves an existing duration alone when none was given", () => {
    const m = decidedBo3({ scheduledAt: "2025-08-15T16:00:00.000Z", durationMin: 30 });
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.durationMin).toBe(30);
    expect(m.finishedAt).toBe("2025-08-15T17:05:00.000Z");
  });

  it("leaves the duration untouched when the match becomes undecided again", () => {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    const m = matchIn(state, "ubsf1");
    m.scheduledAt = "2025-08-15T16:00:00.000Z";
    syncFinish(m, false, at("2025-08-15T17:05:00.000Z"));
    expect(m.durationMin).toBe(65);

    m.games[1].played = false; // the admin unticks a game
    syncFinish(m, false, at("2025-08-15T17:10:00.000Z"));
    expect(m.finishedAt).toBeNull();
    expect(m.durationMin).toBe(65);
  });

  it("defaults `now` to the real clock", () => {
    const m = decidedBo3();
    const before = Date.now();
    syncFinish(m, false);
    const stamped = Date.parse(m.finishedAt!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});
