/**
 * The running order, generalised (docs/platform-plan.md §10).
 *
 * Same engine as the current board, with the three things §10 asks for:
 *
 *  - **Blocks come from the format**, not from a hardcoded phase list. A block
 *    is a slice of one dependency phase, cut to `concurrentLobbies` matches.
 *  - **Up to four days**, each with its own start time and each independent —
 *    one overrunning never moves another.
 *  - **`concurrentLobbies` is a setting**, where the board implies 2.
 *
 * The live re-flow is carried over exactly, because it is the behaviour that
 * makes the schedule usable on the night: a block is over when its *slowest*
 * match finishes, the break runs from there, and every later block that day
 * shifts with it. A block with a match still running does not move anything,
 * since its end is not known yet; a block where one match has already overrun
 * the estimate does, because that end is a fact.
 *
 * Times are absolute instants throughout — the timezone lesson from the current
 * build. `addMinutesTo` does real elapsed-time arithmetic, so a day that
 * crosses a DST boundary still runs to the clock the players are looking at.
 */

import type { GeneratedStage } from "./bracket";
import {
  type FormatTiming,
  MAX_DAYS,
  normaliseFormatTiming,
  seriesMinutes,
} from "./format-policy";
import { isMatchDecided } from "./format-resolve";
import { addMinutesTo } from "./time";

/** How many matches share a start time. The current board implies two. */
export const DEFAULT_CONCURRENT_LOBBIES = 2;

/* ------------------------------------------------------------------ */
/* Blocks                                                             */
/* ------------------------------------------------------------------ */

export type ScheduleOptions = {
  timing?: Partial<FormatTiming> | null;
  /** §10's setting. One means everything runs back to back. */
  concurrentLobbies?: number;
  /** How many days the event runs, 1–4. */
  days?: number;
  /**
   * The day each block belongs to, 1-based and in block order. Anything not
   * given is balanced across the remaining days — but an admin who has said
   * "the bracket is on Sunday" is obeyed, which is why this exists at all.
   */
  blockDays?: number[] | null;
};

export type PlannedBlock = {
  /** Position in the running order, from 0. */
  index: number;
  day: number;
  label: string;
  /** The matches that run together, in board order. */
  slots: string[];
  /** How long the block is expected to take: its slowest series. */
  lengthMin: number;
  /** Minutes after that day's start. */
  offsetMin: number;
};

/** The order the halves of a stage appear on a board, and therefore in a block. */
const BRACKET_ORDER: Record<string, number> = { rr: 0, upper: 1, lower: 2, bronze: 3, final: 4 };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Split every stage into blocks.
 *
 * Everything in one dependency phase can be played at once, so a phase is cut
 * into as many blocks as it needs at `concurrentLobbies` matches each. Stages
 * run in the order they are given, and a phase never straddles two stages —
 * a bracket cannot start before the table that seeds it has finished.
 *
 * A bracket reset is deliberately included: it is a match that might not be
 * played, and leaving room for it and finishing early is the right way round.
 */
export function planBlocks(
  stages: GeneratedStage[],
  options: ScheduleOptions = {}
): PlannedBlock[] {
  const timing = normaliseFormatTiming(options.timing);
  const lobbies = Math.max(1, Math.trunc(options.concurrentLobbies ?? DEFAULT_CONCURRENT_LOBBIES));

  const raw: Array<{ label: string; slots: string[]; lengthMin: number }> = [];

  for (const stage of stages) {
    const phases = [...new Set(stage.matches.map((m) => m.phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const inPhase = stage.matches
        .filter((m) => m.phase === phase)
        .sort(
          (x, y) =>
            (BRACKET_ORDER[x.bracket] ?? 9) - (BRACKET_ORDER[y.bracket] ?? 9) ||
            x.round - y.round ||
            x.slot.localeCompare(y.slot)
        );
      for (const group of chunk(inPhase, lobbies)) {
        const labels = [...new Set(group.map((m) => m.roundLabel))];
        raw.push({
          label: labels.join(" + "),
          slots: group.map((m) => m.slot),
          lengthMin: Math.max(...group.map((m) => seriesMinutes(m.modes, timing))),
        });
      }
    }
  }

  const days = assignDays(
    raw.map((b) => b.lengthMin),
    options,
    timing
  );

  const cursor = new Map<number, number>();
  return raw.map((block, index) => {
    const day = days[index];
    const offsetMin = cursor.get(day) ?? 0;
    cursor.set(day, offsetMin + block.lengthMin + timing.betweenSeries);
    return { index, day, ...block, offsetMin };
  });
}

/**
 * Which day each block runs on.
 *
 * An explicit list wins outright. Otherwise the blocks are split into `days`
 * contiguous stretches chosen to make the longest day as short as possible —
 * blocks cannot be reordered, because a bracket has to be played in order, so
 * the only freedom is where the cuts go.
 */
function assignDays(
  lengths: number[],
  options: ScheduleOptions,
  timing: FormatTiming
): number[] {
  const explicit = options.blockDays ?? null;
  const days = Math.min(
    MAX_DAYS,
    Math.max(1, Math.trunc(options.days ?? (explicit ? Math.max(1, ...explicit) : 1)))
  );

  if (explicit && explicit.length) {
    let last = 1;
    return lengths.map((_, i) => {
      const given = explicit[i];
      if (typeof given === "number" && Number.isFinite(given)) {
        last = Math.min(days, Math.max(1, Math.trunc(given)));
      }
      return last;
    });
  }

  if (days <= 1 || lengths.length <= 1) return lengths.map(() => 1);

  const n = lengths.length;
  const parts = Math.min(days, n);
  // span[i][j] — minutes from block i to block j inclusive, breaks included.
  const span: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    let total = 0;
    for (let j = i; j < n; j += 1) {
      total += lengths[j] + (j > i ? timing.betweenSeries : 0);
      span[i][j] = total;
    }
  }

  // best[k][i] — the smallest possible longest day when k days cover blocks i…n-1.
  const best: number[][] = Array.from({ length: parts + 1 }, () => Array(n + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: parts + 1 }, () => Array(n + 1).fill(n));
  for (let k = 0; k <= parts; k += 1) best[k][n] = 0;
  for (let k = 1; k <= parts; k += 1) {
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = i; j < n; j += 1) {
        // A day must be left for every remaining part, or the tail goes unplayed.
        if (k === 1 && j < n - 1) continue;
        const worst = Math.max(span[i][j], best[k - 1][j + 1]);
        if (worst < best[k][i]) {
          best[k][i] = worst;
          cut[k][i] = j;
        }
      }
    }
  }

  const out = Array(n).fill(1);
  let start = 0;
  for (let k = parts; k >= 1 && start < n; k -= 1) {
    const end = cut[k][start];
    for (let i = start; i <= end; i += 1) out[i] = parts - k + 1;
    start = end + 1;
  }
  return out;
}

/** Wall-clock length of each day: the last block's end, without a trailing break. */
export function dayMinutes(blocks: PlannedBlock[]): number[] {
  const days = blocks.reduce((max, b) => Math.max(max, b.day), 0);
  return Array.from({ length: days }, (_, i) =>
    blocks
      .filter((b) => b.day === i + 1)
      .reduce((max, b) => Math.max(max, b.offsetMin + b.lengthMin), 0)
  );
}

/* ------------------------------------------------------------------ */
/* Stamping the schedule onto matches                                 */
/* ------------------------------------------------------------------ */

/** The mutable part of a match the scheduler touches. */
export type SchedulableMatch = {
  slot: string;
  scheduledAt: string | null;
  finishedAt: string | null;
  durationMin: number | null;
};

function index<T extends { slot: string }>(matches: T[]): Map<string, T> {
  return new Map(matches.map((m) => [m.slot, m]));
}

const latest = (stamps: string[]) => stamps.reduce((max, s) => (s > max ? s : max));

/**
 * Lay the plan out from a start time per day, then re-flow it.
 *
 * Day starts arrive as absolute instants — or as the naive `datetime-local`
 * value an admin typed, which `addMinutesTo(_, 0)` normalises. A day left blank
 * is skipped rather than guessed at.
 *
 * The day starts are passed through to the re-flow as anchors on purpose: an
 * explicit auto-fill is the admin stating when the day begins, and it has to
 * beat the historical start of anything already played.
 */
export function autoSchedule(
  matches: SchedulableMatch[],
  blocks: PlannedBlock[],
  dayStarts: Array<string | null | undefined>,
  timing?: Partial<FormatTiming> | null
): void {
  const bySlot = index(matches);

  for (const block of blocks) {
    const start = dayStarts[block.day - 1];
    const at = start ? addMinutesTo(start, block.offsetMin) : null;
    if (!at) continue;
    for (const slot of block.slots) {
      const match = bySlot.get(slot);
      // A match that has already been played keeps the slot it actually ran in.
      if (match && !match.finishedAt) match.scheduledAt = at;
    }
  }

  const anchors = new Map<number, string>();
  dayStarts.forEach((start, i) => {
    if (start) anchors.set(i + 1, start);
  });
  recalculateSchedule(matches, blocks, { timing, anchors });
}

/**
 * Re-flow each day from what has actually happened.
 *
 * Matches inside a block run in parallel, so the block is over only once the
 * slowest of them finishes — that is when the break starts, and every later
 * block that day shifts with it. Blocks that have not been played fall back to
 * their planned length. Days are independent: day 1 running late never moves
 * day 2, which has its own start time.
 */
export function recalculateSchedule(
  matches: SchedulableMatch[],
  blocks: PlannedBlock[],
  options: {
    timing?: Partial<FormatTiming> | null;
    anchors?: Map<number, string> | Record<number, string | null | undefined>;
  } = {}
): void {
  const timing = normaliseFormatTiming(options.timing);
  const bySlot = index(matches);
  const anchorFor = (day: number): string | null | undefined =>
    options.anchors instanceof Map
      ? options.anchors.get(day)
      : (options.anchors?.[day] ?? null);

  const days = blocks.reduce((max, b) => Math.max(max, b.day), 0);

  for (let day = 1; day <= days; day += 1) {
    const inDay = blocks.filter((b) => b.day === day);
    const first = inDay.findIndex((b) => b.slots.some((slot) => bySlot.get(slot)?.scheduledAt));
    if (first < 0) continue; // this day was never given a start time

    // Anchor priority: an explicit day start, then the first block's first
    // *unplayed* match. Sniffing a played match's start would drag the day back
    // to when that match happened to run, which is not where the admin just
    // said the day begins.
    const opener = inDay[first].slots
      .map((slot) => bySlot.get(slot))
      .filter((m): m is SchedulableMatch => Boolean(m));
    const anchor = anchorFor(day);
    let cursor: string | null =
      (anchor ? addMinutesTo(anchor, 0) : null) ||
      opener.find((m) => !m.finishedAt && m.scheduledAt)?.scheduledAt ||
      opener.find((m) => m.scheduledAt)?.scheduledAt ||
      null;

    for (const block of inDay.slice(first)) {
      if (!cursor) break;
      const running = block.slots
        .map((slot) => bySlot.get(slot))
        .filter((m): m is SchedulableMatch => Boolean(m));
      if (running.length === 0) continue;

      for (const match of running) if (!match.finishedAt) match.scheduledAt = cursor;

      const ends = running.map((m) => m.finishedAt ?? addMinutesTo(cursor as string, block.lengthMin));
      const known = ends.filter((end): end is string => Boolean(end));
      cursor =
        known.length === running.length ? addMinutesTo(latest(known), timing.betweenSeries) : null;
    }
  }
}

/**
 * What the admin's schedule preview shows: a clock window per block, plus the
 * total for each day (§10).
 */
export function schedulePreview(
  blocks: PlannedBlock[],
  dayStarts: Array<string | null | undefined>
): Array<PlannedBlock & { startsAt: string | null; endsAt: string | null }> {
  return blocks.map((block) => {
    const start = dayStarts[block.day - 1];
    const startsAt = start ? addMinutesTo(start, block.offsetMin) : null;
    return {
      ...block,
      startsAt,
      endsAt: startsAt ? addMinutesTo(startsAt, block.lengthMin) : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Finish times                                                       */
/* ------------------------------------------------------------------ */

/** Enough of a match to decide whether it is over, and to stamp when. */
export type FinishableMatch = SchedulableMatch & {
  bestOf: number;
  games: Array<{ played: boolean; scoreA: number; scoreB: number }>;
  winnerOverrideId: string | null;
};

/**
 * Keep `finishedAt` and `durationMin` in step after an edit. An explicit
 * duration wins; otherwise the finish is stamped now and the duration derived
 * from the scheduled start.
 */
export function syncFinish(
  match: FinishableMatch,
  durationWasGiven: boolean,
  now: Date = new Date()
): void {
  const games = match.games.map((g, i) => ({
    index: i,
    mode: "",
    map: "",
    referee: "",
    ...g,
  }));

  if (!isMatchDecided({ bestOf: match.bestOf, games, winnerOverrideId: match.winnerOverrideId })) {
    match.finishedAt = null;
    return;
  }

  if (!match.finishedAt) {
    // A match cannot end before it starts — this guards against recording
    // against a schedule that is still in the future.
    const stamp = now.toISOString();
    match.finishedAt =
      match.scheduledAt && stamp < match.scheduledAt ? match.scheduledAt : stamp;
  }

  if (durationWasGiven && match.scheduledAt && match.durationMin !== null) {
    match.finishedAt = addMinutesTo(match.scheduledAt, match.durationMin) ?? match.finishedAt;
    return;
  }
  if (match.durationMin === null && match.scheduledAt) {
    const minutes = Math.round(
      (Date.parse(match.finishedAt) - Date.parse(match.scheduledAt)) / 60_000
    );
    // Ignore nonsense windows — a stale schedule should not invent a 3-day match.
    if (minutes > 0 && minutes <= 1440) match.durationMin = minutes;
  }
}
