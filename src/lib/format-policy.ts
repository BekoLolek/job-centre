/**
 * The format engine's vocabulary — configuration, source references and timing,
 * with no database and no generation logic (docs/platform-plan.md §8.2, §10).
 *
 * This is to `./bracket`, `./format-resolve` and `./format-schedule` what
 * `./draft-policy` is to `./draft`: the pure layer everything else agrees on.
 *
 * ## Everything §8.2 calls "currently hardcoded" is a value here
 *
 * The current board bakes in four decisions. Each becomes a field:
 *
 *  | Hardcoded today | Here |
 *  | --- | --- |
 *  | Bo1 group games, Bo3 bracket, Bo5 grand final | `bestOf` + `bestOfByRound` + `bestOfBySlot` |
 *  | `[convoy, convoy, domination]` | `modeSequence`, one entry per series length |
 *  | "Lower final · bronze" | `bronze` |
 *  | No bracket reset | `bracketReset`, defaulting **off** per §14 |
 *
 * `modeSequence` maps a *series length* to an ordered list of mode names, and
 * the names are plain strings rather than an enum on purpose: the modes belong
 * to the game (`games` catalogue), and adding "Escort" must not be a migration
 * — the same rule that keeps `events.type` text.
 *
 * ## Source references
 *
 * A match slot says where its two teams come from rather than which teams they
 * are, so a corrected result re-propagates on the next read (§1.1, §8.5):
 *
 *     seed:1            the stage's first seed
 *     winner:ubsf1      whoever wins that slot
 *     loser:ubf         whoever loses it
 *     group:a:rank:2    second in group A's table, once that group is complete
 *
 * They are stored as text in `matches.source_a` / `source_b`, which is why the
 * grammar is a string rather than a jsonb blob: it is read by eye in psql, it
 * diffs legibly in a migration, and it survives a config shape change.
 */

/* ------------------------------------------------------------------ */
/* Stage kinds                                                        */
/* ------------------------------------------------------------------ */

export const STAGE_KINDS = [
  "round_robin",
  "single_elim",
  "double_elim",
  "swiss",
  "group_playoff",
] as const;

export type StageKind = (typeof STAGE_KINDS)[number];

/** The kinds that produce a bracket, and therefore a champion. */
export const ELIMINATION_KINDS = ["single_elim", "double_elim"] as const;

export type EliminationKind = (typeof ELIMINATION_KINDS)[number];

export function isStageKind(value: unknown): value is StageKind {
  return typeof value === "string" && (STAGE_KINDS as readonly string[]).includes(value);
}

export function isEliminationKind(value: unknown): value is EliminationKind {
  return (
    typeof value === "string" && (ELIMINATION_KINDS as readonly string[]).includes(value)
  );
}

/** Teams per event, per §8.1's "2–8". Mirrors draft-policy's identical pair. */
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 8;

/** Days per event, per §10. `event_days.day_index` is checked against the same bound. */
export const MAX_DAYS = 4;

/* ------------------------------------------------------------------ */
/* Series lengths and modes                                           */
/* ------------------------------------------------------------------ */

/** Odd only: an even series cannot be won without a tiebreak nobody asked for. */
export const SERIES_LENGTHS = [1, 3, 5, 7] as const;

export type SeriesLength = (typeof SERIES_LENGTHS)[number];

export function isSeriesLength(value: unknown): value is SeriesLength {
  return (SERIES_LENGTHS as readonly unknown[]).includes(value);
}

/** How many game wins take a series. */
export function seriesTarget(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/**
 * The current board's rule, written out as data: every map is a convoy except
 * the decider, which is a domination. `modesFor` reads this and nothing branches
 * on the series length.
 */
export const DEFAULT_MODE_SEQUENCE: Record<string, string[]> = {
  "1": ["convoy"],
  "3": ["convoy", "convoy", "domination"],
  "5": ["convoy", "convoy", "convoy", "convoy", "domination"],
  "7": ["convoy", "convoy", "convoy", "convoy", "convoy", "convoy", "domination"],
};

/* ------------------------------------------------------------------ */
/* Round-robin scoring (§8.2's last line)                             */
/* ------------------------------------------------------------------ */

export type PointsRule = { win: number; draw: number; loss: number };

export const DEFAULT_POINTS: PointsRule = { win: 3, draw: 1, loss: 0 };

/**
 * How a level table is separated, in the order they are applied.
 *
 * `mini_league` is the current board's rule and the default: re-run the table
 * counting only the matches between everyone still level, which collapses to
 * head-to-head for a straight two-way tie. `head_to_head` is the narrower
 * version that only ever looks at a single match, and is offered because some
 * organisers prefer it stated that way.
 */
export const TIEBREAKERS = [
  "mini_league",
  "head_to_head",
  "wins",
  "diff",
  "score_for",
  "name",
] as const;

export type Tiebreaker = (typeof TIEBREAKERS)[number];

/** The current board's order, exactly. `name` is the terminal, total one. */
export const DEFAULT_TIEBREAKERS: Tiebreaker[] = ["mini_league", "diff", "score_for", "name"];

/* ------------------------------------------------------------------ */
/* Bronze and the grand final                                         */
/* ------------------------------------------------------------------ */

/**
 * §8.2's three options.
 *
 * `lower_final` is what the board does today — the lower final's loser takes
 * bronze, so third place costs no extra match. `separate` plays one. See the
 * note on `normaliseStageConfig` for what each means in a bracket that has no
 * lower final, which §8.2 does not say.
 */
export const BRONZE_MODES = ["none", "lower_final", "separate"] as const;

export type BronzeMode = (typeof BRONZE_MODES)[number];

/* ------------------------------------------------------------------ */
/* Stage configuration                                                */
/* ------------------------------------------------------------------ */

/**
 * One stage's rules, with every field present and every number sane.
 * `stages.config` is the storage; this is the shape after
 * `normaliseStageConfig` has filled the gaps, and every reader may assume it.
 */
export type StageConfig = {
  /** The stage default. */
  bestOf: SeriesLength;
  /**
   * Keyed by half — `rr`, `upper`, `lower`, `final`, `bronze`. This is what
   * makes "Bo1 group games, Bo3 playoff" sayable in a stage that has both:
   * round numbers restart in each half, so they cannot separate them.
   */
  bestOfByBracket: Record<string, SeriesLength>;
  /** Keyed by round number as a string — "everything Bo3 but round 3 is Bo5". */
  bestOfByRound: Record<string, SeriesLength>;
  /** Keyed by slot — "the grand final is Bo5". Beats both maps above. */
  bestOfBySlot: Record<string, SeriesLength>;
  /** Ordered mode names per series length, keyed by the best-of as a string. */
  modeSequence: Record<string, string[]>;
  bronze: BronzeMode;
  /** §14 settles this as off. A reset is a second grand final, not a longer one. */
  bracketReset: boolean;
  /** Round robin: play every pair twice. */
  doubleRound: boolean;
  /** group_playoff: how many groups the field is split into. */
  groups: number;
  /** group_playoff: how many of each group go through. */
  advancePerGroup: number;
  /** group_playoff: what the qualifiers then play. */
  playoffKind: EliminationKind;
  /** swiss: how many rounds are played. */
  rounds: number;
  points: PointsRule;
  tiebreakers: Tiebreaker[];
};

/**
 * The rules a stage has before anybody configures anything: the current board's
 * tournament, which is Bo3 through the bracket with a Bo5 grand final, the
 * lower final doubling as the bronze match, and no bracket reset.
 */
export const DEFAULT_STAGE_CONFIG: StageConfig = {
  bestOf: 3,
  bestOfByBracket: { rr: 1 },
  bestOfByRound: {},
  bestOfBySlot: { gf: 5 },
  modeSequence: DEFAULT_MODE_SEQUENCE,
  bronze: "lower_final",
  bracketReset: false,
  doubleRound: false,
  groups: 2,
  advancePerGroup: 2,
  playoffKind: "single_elim",
  rounds: 3,
  points: DEFAULT_POINTS,
  tiebreakers: DEFAULT_TIEBREAKERS,
};

/**
 * The defaults for one kind of stage.
 *
 * A round robin is Bo1 on the current board and there is no reason for it to
 * inherit the bracket's Bo3. A group stage is both at once, and gets the
 * current tournament's answer without any further configuration: `bestOf: 3`
 * for the playoff, overridden to 1 for the `rr` half by `bestOfByBracket`, and
 * a Bo5 grand final by slot.
 */
export function defaultStageConfig(kind: StageKind): StageConfig {
  if (kind === "round_robin" || kind === "swiss") {
    return { ...DEFAULT_STAGE_CONFIG, bestOf: 1, bestOfByBracket: {}, bestOfBySlot: {} };
  }
  return { ...DEFAULT_STAGE_CONFIG };
}

function whole(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function seriesLength(value: unknown, fallback: SeriesLength): SeriesLength {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  // Round to the nearest legal length rather than rejecting: a Bo4 typed into
  // an admin field means "about four", and refusing it silently would leave the
  // stage on a default the admin did not choose.
  const rounded = Math.min(7, Math.max(1, Math.trunc(parsed)));
  const odd = rounded % 2 === 0 ? rounded - 1 : rounded;
  return (isSeriesLength(odd) ? odd : fallback) as SeriesLength;
}

function seriesMap(
  value: unknown,
  fallback: SeriesLength
): Record<string, SeriesLength> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, SeriesLength> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const clean = key.trim();
    if (!clean) continue;
    out[clean] = seriesLength(raw, fallback);
  }
  return out;
}

function modeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
  return clean || null;
}

function modeSequences(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_MODE_SEQUENCE };
  }
  const out: Record<string, string[]> = { ...DEFAULT_MODE_SEQUENCE };
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const modes = raw.map(modeName).filter((m): m is string => Boolean(m));
    if (modes.length) out[key.trim()] = modes;
  }
  return out;
}

function points(value: unknown): PointsRule {
  const source = (value ?? {}) as Partial<PointsRule>;
  return {
    win: whole(source.win, DEFAULT_POINTS.win, 0, 100),
    draw: whole(source.draw, DEFAULT_POINTS.draw, 0, 100),
    loss: whole(source.loss, DEFAULT_POINTS.loss, 0, 100),
  };
}

function tiebreakers(value: unknown): Tiebreaker[] {
  if (!Array.isArray(value)) return [...DEFAULT_TIEBREAKERS];
  const seen = new Set<Tiebreaker>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const key = raw.trim() as Tiebreaker;
    if ((TIEBREAKERS as readonly string[]).includes(key)) seen.add(key);
  }
  if (seen.size === 0) return [...DEFAULT_TIEBREAKERS];
  // `name` is what makes the sort total, so it is always the last word even if
  // an admin's list forgot it.
  seen.delete("name");
  return [...seen, "name"];
}

/**
 * Fill in a stored `stages.config`.
 *
 * Two normalisations are decisions rather than clamps, and §8.2 does not settle
 * either:
 *
 *  - **`bronze: "lower_final"` in a bracket that has no lower final.** A single
 *    elimination has nothing for the loser of a "lower final" to be, so it is
 *    read as `separate` — the only way that bracket can name a third place at
 *    all. The reverse case is the other side of the same coin: `separate` in a
 *    double elimination would be a match between two teams whose finishing
 *    positions are already decided, so it is read as `lower_final`.
 *  - **`bracketReset` outside a double elimination** is meaningless — there is
 *    no lower bracket to have come from — and is dropped.
 */
export function normaliseStageConfig(
  kind: StageKind,
  input: Partial<StageConfig> | null | undefined
): StageConfig {
  const base = defaultStageConfig(kind);
  const raw = (input ?? {}) as Partial<StageConfig>;
  const bestOf = seriesLength(raw.bestOf, base.bestOf);

  const playoffKind = isEliminationKind(raw.playoffKind) ? raw.playoffKind : base.playoffKind;
  // A group stage's bracket half is the thing that owns the bronze question.
  const bracketKind: StageKind = kind === "group_playoff" ? playoffKind : kind;

  let bronze: BronzeMode = (BRONZE_MODES as readonly string[]).includes(raw.bronze as string)
    ? (raw.bronze as BronzeMode)
    : base.bronze;
  if (bronze !== "none") {
    if (bracketKind === "single_elim") bronze = "separate";
    else if (bracketKind === "double_elim") bronze = "lower_final";
    else bronze = "none";
  }

  return {
    bestOf,
    bestOfByBracket: seriesMap(raw.bestOfByBracket ?? base.bestOfByBracket, bestOf),
    bestOfByRound: seriesMap(raw.bestOfByRound, bestOf),
    bestOfBySlot: seriesMap(raw.bestOfBySlot ?? base.bestOfBySlot, bestOf),
    modeSequence: modeSequences(raw.modeSequence),
    bronze,
    bracketReset: bracketKind === "double_elim" && raw.bracketReset === true,
    doubleRound: raw.doubleRound === true,
    groups: whole(raw.groups, base.groups, 1, MAX_TEAMS),
    advancePerGroup: whole(raw.advancePerGroup, base.advancePerGroup, 1, MAX_TEAMS),
    playoffKind,
    rounds: whole(raw.rounds, base.rounds, 1, MAX_TEAMS * 2),
    points: points(raw.points),
    tiebreakers: tiebreakers(raw.tiebreakers),
  };
}

/**
 * The series length for one match: the slot wins, then the round, then the
 * half, then the stage default. That ordering is what makes "everything Bo3,
 * grand final Bo5" a one-field config rather than a branch.
 */
export function bestOfFor(
  config: StageConfig,
  where: { slot?: string; round?: number; bracket?: string }
): SeriesLength {
  if (where.slot && config.bestOfBySlot[where.slot] !== undefined) {
    return config.bestOfBySlot[where.slot];
  }
  if (where.round !== undefined && config.bestOfByRound[String(where.round)] !== undefined) {
    return config.bestOfByRound[String(where.round)];
  }
  if (where.bracket && config.bestOfByBracket[where.bracket] !== undefined) {
    return config.bestOfByBracket[where.bracket];
  }
  return config.bestOf;
}

/**
 * The ordered modes for one series, always exactly `bestOf` long.
 *
 * A configured sequence that is too short repeats its last entry and one that
 * is too long is cut, so a Bo5 played under a Bo3's sequence is still five
 * playable games rather than three games and two holes.
 */
export function modesFor(config: StageConfig, bestOf: number): string[] {
  const configured = config.modeSequence[String(bestOf)] ?? DEFAULT_MODE_SEQUENCE[String(bestOf)];
  const source = configured?.length ? configured : ["convoy"];
  return Array.from({ length: bestOf }, (_, i) => source[Math.min(i, source.length - 1)]);
}

/* ------------------------------------------------------------------ */
/* Source references                                                  */
/* ------------------------------------------------------------------ */

export type SourceRef =
  | { kind: "seed"; seed: number }
  | { kind: "winner"; slot: string }
  | { kind: "loser"; slot: string }
  | { kind: "group"; group: string; rank: number };

export function seedRef(seed: number): string {
  return `seed:${seed}`;
}

export function winnerRef(slot: string): string {
  return `winner:${slot}`;
}

export function loserRef(slot: string): string {
  return `loser:${slot}`;
}

export function groupRef(group: string, rank: number): string {
  return `group:${group}:rank:${rank}`;
}

export function formatSource(ref: SourceRef): string {
  switch (ref.kind) {
    case "seed":
      return seedRef(ref.seed);
    case "winner":
      return winnerRef(ref.slot);
    case "loser":
      return loserRef(ref.slot);
    case "group":
      return groupRef(ref.group, ref.rank);
  }
}

const POSITIVE = /^[1-9][0-9]*$/;

/** Anything unrecognised is null — a source is a hint, never a hard failure. */
export function parseSource(raw: string | null | undefined): SourceRef | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(":");
  if (parts.length < 2) return null;
  const [head, ...rest] = parts;

  if (head === "seed" && rest.length === 1 && POSITIVE.test(rest[0])) {
    return { kind: "seed", seed: Number(rest[0]) };
  }
  if ((head === "winner" || head === "loser") && rest.length === 1 && rest[0]) {
    return { kind: head, slot: rest[0] };
  }
  if (head === "group" && rest.length === 3 && rest[0] && rest[1] === "rank" && POSITIVE.test(rest[2])) {
    return { kind: "group", group: rest[0], rank: Number(rest[2]) };
  }
  return null;
}

/** Which slots a source depends on. Used to order resolution and to spot cycles. */
export function sourceDependency(raw: string | null | undefined): string | null {
  const ref = parseSource(raw);
  return ref && (ref.kind === "winner" || ref.kind === "loser") ? ref.slot : null;
}

/* ------------------------------------------------------------------ */
/* Timing (§10)                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minutes, as the schedule needs them.
 *
 * The current board has one number per mode because it has exactly two modes.
 * Modes are data here, so this is a map with a fallback for a mode nobody has
 * given a length yet — a new mode must lengthen the schedule, not zero it.
 */
export type FormatTiming = {
  modeMinutes: Record<string, number>;
  /** Used for a mode with no entry above. */
  defaultMinutes: number;
  betweenGames: number;
  betweenSeries: number;
};

export const DEFAULT_FORMAT_TIMING: FormatTiming = {
  modeMinutes: { convoy: 30, domination: 15 },
  defaultMinutes: 30,
  betweenGames: 5,
  betweenSeries: 10,
};

export function normaliseFormatTiming(
  input: Partial<FormatTiming> | null | undefined
): FormatTiming {
  const raw = input ?? {};
  const modeMinutes: Record<string, number> = {};
  const source =
    raw.modeMinutes && typeof raw.modeMinutes === "object"
      ? raw.modeMinutes
      : DEFAULT_FORMAT_TIMING.modeMinutes;
  for (const [mode, value] of Object.entries(source)) {
    const key = modeName(mode);
    if (!key) continue;
    // Zero is not a length. A mode with a nonsense duration falls back to the
    // default rather than collapsing the block it sits in.
    const minutes = whole(value, DEFAULT_FORMAT_TIMING.defaultMinutes, 0, 600);
    modeMinutes[key] = minutes || DEFAULT_FORMAT_TIMING.defaultMinutes;
  }
  const defaultMinutes =
    whole(raw.defaultMinutes, DEFAULT_FORMAT_TIMING.defaultMinutes, 0, 600) ||
    DEFAULT_FORMAT_TIMING.defaultMinutes;

  return {
    modeMinutes: Object.keys(modeMinutes).length ? modeMinutes : { ...DEFAULT_FORMAT_TIMING.modeMinutes },
    defaultMinutes,
    betweenGames: whole(raw.betweenGames, DEFAULT_FORMAT_TIMING.betweenGames, 0, 240),
    betweenSeries: whole(raw.betweenSeries, DEFAULT_FORMAT_TIMING.betweenSeries, 0, 240),
  };
}

export function modeMinutes(timing: FormatTiming, mode: string): number {
  return timing.modeMinutes[mode] ?? timing.defaultMinutes;
}

/** Longest a series can run, including the breaks between its own games. */
export function seriesMinutes(modes: string[], timing: FormatTiming): number {
  if (modes.length === 0) return 0;
  const games = modes.reduce((sum, mode) => sum + modeMinutes(timing, mode), 0);
  return games + (modes.length - 1) * timing.betweenGames;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                               */
/* ------------------------------------------------------------------ */

/** 1st, 2nd, 3rd, 4th … — used by the stakes notes on a bracket. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** a, b, c … for group keys. */
export function groupKey(index: number): string {
  return String.fromCharCode(97 + index);
}

/** The smallest power of two that is at least `n`. */
export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/**
 * Standard bracket seeding order for a bracket of `size`: the positions, in
 * slot order, so that 1 meets the weakest survivor as late as possible.
 *
 * size 2 → [1, 2] · size 4 → [1, 4, 2, 3] · size 8 → [1, 8, 4, 5, 2, 7, 3, 6]
 *
 * Built by mirroring: every position `s` in the half-size order becomes the
 * pair `s` and `size + 1 - s`, which is the property that makes seeds 1 and 2
 * meet only in the final.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  for (let round = 2; round <= size; round *= 2) {
    const next: number[] = [];
    for (const seed of order) next.push(seed, round + 1 - seed);
    order = next;
  }
  return order;
}
