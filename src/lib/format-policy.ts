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
 *  | Bo1 group games, Bo3 bracket, Bo5 grand final | `bestOf` + `bestOfByBracket` + `bestOfBySlot` |
 *  | `[convoy, convoy, domination]` | `modeSequence`, one entry per series length |
 *  | "Lower final · bronze" | `bronze` |
 *  | No bracket reset | `bracketReset`, defaulting **off** per §14 |
 *
 * `bestOfByBracket` and not `bestOfByRound` in that first row: round numbers
 * restart in each half, so no round number can tell a group game from a bracket
 * game — which is what `StageConfig`'s field docs and `bestOfFor`'s precedence
 * say, and why the round map is the one of the three that cannot express the
 * row. `DEFAULT_STAGE_CONFIG` below is that row written out.
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
  /**
   * Keyed by round number as a string — "everything Bo3 but round 3 is Bo5".
   * Read *after* `bestOfByBracket`, because a round number cannot tell two
   * halves apart and a half can (UC-18 E2 — see `bestOfFor`).
   */
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
  /**
   * swiss: the pairings of every round after the first, keyed by round number
   * as a string, each a list of seed pairs.
   *
   * ## Why a pairing is stored at all
   *
   * Only round 1 of a Swiss can be generated from `(kind, teamCount, config)`:
   * every later round pairs the table as it stood when that round was made, and
   * a table moves. So the pairing is a **decision taken at a moment**, not a
   * derivation — the same kind of fact as `matches.first_side_choice`, and
   * stored for the same reason. Re-deriving it later would silently re-pair a
   * round that has already been played the moment an earlier score is
   * corrected, which is precisely the thing §1.1 forbids.
   *
   * Seed numbers rather than team ids, because that is what the source grammar
   * above already says and what every other generated match in the stage uses:
   * a stored pairing is `seed:3` against `seed:6`, resolved into teams on read
   * exactly as a round robin's are.
   */
  swissRounds: Record<string, Array<[number, number]>>;
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
  swissRounds: {},
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

/**
 * **One mode name, spelled the one way** — `"Payload Escort"` →
 * `payload_escort` (R-152, R-153).
 *
 * The same function `modeSequence` is read through, exported because
 * `match_games.mode` is the *other* half of the same vocabulary: the plan is
 * what the Format tab typed and the record is what the Results card typed, and
 * a board that prints "Convoy" on one card and "convoy" on the next is a board
 * with two modes of one name. It is also what keeps a recorded mode comparable
 * with the planned one, which `format.ts`'s shape lines depend on.
 *
 * Empty for anything that is not a name, so a caller can tell "no mode" from a
 * mode called nothing.
 */
export function normaliseModeName(value: unknown): string {
  return modeName(value) ?? "";
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
    // Kept only for a Swiss: a pairing list on a round robin is a leftover from
    // a kind change, and generating from it would be generating a shape nobody
    // on screen can see.
    swissRounds: kind === "swiss" ? swissRounds(raw.swissRounds) : {},
    points: points(raw.points),
    tiebreakers: tiebreakers(raw.tiebreakers),
  };
}

/**
 * Read back a stored Swiss pairing list.
 *
 * Nothing here believes the stored value any more than `seriesMap` believes a
 * stored series length: a round key has to be a round number, a pair has to be
 * two *different* seeds in range, and anything else is dropped rather than
 * generated into a match against a team that cannot be there. The round key is
 * not bounded against `rounds` here, because a manager who lowers the round
 * count has not unplayed the round that was already paired — `generateStage`
 * is where `rounds` decides how much of this list is built.
 */
function swissRounds(value: unknown): Record<string, Array<[number, number]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Array<[number, number]>> = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const round = Number(String(key).trim());
    if (!Number.isInteger(round) || round < 2 || round > MAX_TEAMS * 2) continue;
    if (!Array.isArray(raw)) continue;

    const pairs: Array<[number, number]> = [];
    const used = new Set<number>();
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const a = Math.trunc(Number(entry[0]));
      const b = Math.trunc(Number(entry[1]));
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (a < 1 || b < 1 || a > MAX_TEAMS || b > MAX_TEAMS || a === b) continue;
      // A seed in two pairings of one round is a team playing itself twice in
      // the same slot of the evening. Keep the first, drop the rest.
      if (used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      pairs.push([a, b]);
    }
    if (pairs.length) out[String(round)] = pairs;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* How many teams a kind can be played with (UC-18 2a)                */
/* ------------------------------------------------------------------ */

/** The inclusive team-count range one kind of stage can actually be built for. */
export type TeamRange = { min: number; max: number };

/**
 * **What this kind of stage needs, in teams** (UC-18 2a).
 *
 * The platform's ceiling is eight everywhere (§8.1). The floor is two for every
 * bracket and every table — and two kinds raise it, because their own settings
 * say how wide the field has to be:
 *
 *  - **Groups then playoff.** A group of one is a team with nothing to play, so
 *    `groups` groups need two teams each. Four groups is a sixteen-team shape
 *    and there is no such event here, which is why the range can come out
 *    *empty* and the message has to say "fewer groups" rather than "more
 *    teams".
 *  - **Swiss.** A round is a pairing of the whole field, and a field of `n`
 *    teams has only `n - 1` distinct opponents in it, so `rounds` rounds need
 *    `rounds + 1` teams. Below that the greedy pairer starts handing out
 *    rematches ("a rematch beats no match"), which is the right answer to a
 *    field that has run out of opponents mid-event and the wrong answer to a
 *    format that was never playable.
 *
 * `generateStage` deliberately does **not** consult this: it clamps, because it
 * is also the preview, and a Format tab that cannot draw the shape it is
 * refusing is a tab that cannot explain the refusal. The refusal belongs on the
 * write, and `teamCountRefusal` is what the write asks.
 */
export function teamRangeFor(kind: StageKind, config: StageConfig): TeamRange {
  if (kind === "group_playoff") {
    return { min: Math.max(MIN_TEAMS, config.groups * 2), max: MAX_TEAMS };
  }
  if (kind === "swiss") {
    return { min: Math.max(MIN_TEAMS, config.rounds + 1), max: MAX_TEAMS };
  }
  return { min: MIN_TEAMS, max: MAX_TEAMS };
}

/** What a kind of stage is called in a sentence a manager reads. */
export function stageKindName(kind: StageKind): string {
  switch (kind) {
    case "round_robin":
      return "A round robin";
    case "single_elim":
      return "A single elimination";
    case "double_elim":
      return "A double elimination";
    case "swiss":
      return "A Swiss";
    case "group_playoff":
      return "Groups then a playoff";
  }
}

/**
 * **Why this kind cannot be played with this many teams, naming the range** —
 * or null when it can (UC-18 2a).
 *
 * A sentence rather than a clamp, which is the whole point: clamping a
 * five-team event's bracket up to six invents a team, and clamping a
 * three-group stage down to one group builds a format nobody chose. Both were
 * silent. This says what is wrong, what the valid range is, and leaves the
 * stage exactly as it was.
 */
export function teamCountRefusal(
  kind: StageKind,
  teamCount: number,
  config: StageConfig
): string | null {
  const range = teamRangeFor(kind, config);
  const name = stageKindName(kind);

  if (range.min > range.max) {
    // No team count can satisfy it, so naming a range would name an empty one.
    // The setting that made it impossible is the thing to change.
    return kind === "group_playoff"
      ? `${name} with ${range.min / 2} groups needs ${range.min} teams, and an event can have at most ${MAX_TEAMS}. Use fewer groups.`
      : `${name} over ${config.rounds} rounds needs ${range.min} teams, and an event can have at most ${MAX_TEAMS}. Use fewer rounds.`;
  }
  if (!Number.isFinite(teamCount) || teamCount < range.min || teamCount > range.max) {
    const detail =
      kind === "group_playoff"
        ? ` with ${config.groups} ${config.groups === 1 ? "group" : "groups"}`
        : kind === "swiss"
          ? ` over ${config.rounds} ${config.rounds === 1 ? "round" : "rounds"}`
          : "";
    return `${name}${detail} needs between ${range.min} and ${range.max} teams. This event has ${Math.max(0, Math.trunc(teamCount) || 0)}.`;
  }
  return null;
}

/**
 * The series length for one match: the slot wins, then the half, then the
 * round, then the stage default. That ordering is what makes "everything Bo3,
 * grand final Bo5" a one-field config rather than a branch.
 *
 * ## The half beats the round, and that is UC-18 E2 rather than a preference
 *
 * *"Manager sets a series length for one bracket or one match — it wins over
 * the stage and round lengths."* The order used to read slot, round, half, and
 * the two disagree about exactly one match: one in a half that has its own
 * length, in a round number that also has one.
 *
 * It matters because **round numbers restart in each half** — see
 * `bestOfByBracket` — so a round key is not the narrower setting it looks like.
 * "Round 1" in a group stage names the first circle round of every group *and*
 * the first round of the playoff bracket, while `rr` names the table games and
 * nothing else. Under the old order, a manager who set "round 1 Bo5" to
 * lengthen the opening bracket tie silently lengthened every group's first
 * round too, straight through the `bestOfByBracket: { rr: 1 }` that
 * `defaultStageConfig` puts on a group stage to keep table games Bo1. The half
 * is the setting that can separate them, so the half is the setting that wins.
 */
export function bestOfFor(
  config: StageConfig,
  where: { slot?: string; round?: number; bracket?: string }
): SeriesLength {
  if (where.slot && config.bestOfBySlot[where.slot] !== undefined) {
    return config.bestOfBySlot[where.slot];
  }
  if (where.bracket && config.bestOfByBracket[where.bracket] !== undefined) {
    return config.bestOfByBracket[where.bracket];
  }
  if (where.round !== undefined && config.bestOfByRound[String(where.round)] !== undefined) {
    return config.bestOfByRound[String(where.round)];
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
/* Who picks the side, and who picks the map (§8.4)                   */
/* ------------------------------------------------------------------ */

/**
 * The two halves of a match, as the row names them: `team_a_id` / `source_a`
 * is slot `a`, and `team_b_id` / `source_b` is slot `b`.
 *
 * The coin is stored as a slot rather than as a team id because a bracket slot
 * has no teams when its matches are generated — that is the whole point of
 * `source_a` — so a team id would be a value nobody could write yet. A slot is
 * knowable at generation time and resolves into a team on every read, exactly
 * as the pairing itself does.
 */
export const MATCH_SLOTS = ["a", "b"] as const;

export type MatchSlot = (typeof MATCH_SLOTS)[number];

export function isMatchSlot(value: unknown): value is MatchSlot {
  return value === "a" || value === "b";
}

/** Anything unrecognised is `a`, so no reader ever has a hole to branch on. */
export function normaliseMatchSlot(value: unknown): MatchSlot {
  return isMatchSlot(value) ? value : "a";
}

export function otherSlot(slot: MatchSlot): MatchSlot {
  return slot === "a" ? "b" : "a";
}

/**
 * Which side of the map a team plays first. What was *chosen*, not who chose —
 * recorded per game on `match_games.side_chosen`, and optional: the rule is
 * about who holds the choice, and a match played without anybody writing down
 * which way it went is still a match played under the rule.
 */
export const PLAY_SIDES = ["attack", "defence"] as const;

export type PlaySide = (typeof PLAY_SIDES)[number];

export function isPlaySide(value: unknown): value is PlaySide {
  return value === "attack" || value === "defence";
}

/** Null for anything unrecognised — an unrecorded choice, not a wrong one. */
export function normalisePlaySide(value: unknown): PlaySide | null {
  return isPlaySide(value) ? value : null;
}

/**
 * **Which slot chooses the side for one game.**
 *
 * One team picks attack or defence, the other picks the map, and the two roles
 * swap every game of the series. A coin decides who starts with the side, and
 * that single answer — `matches.first_side_choice` — is all that is stored: a
 * Bo3 whose game 1 went to `a` has `b` choosing in game 2 and `a` again in
 * game 3, which is a parity check on the game index and not a column.
 *
 * That is deliberate, and it is the same argument that keeps a bracket slot's
 * teams out of its row (§1.1, §8.5) and a team's balance out of `teams`: a
 * per-game copy is a copy that can disagree with itself the moment somebody
 * inserts, removes or re-orders a game.
 *
 * `gameIndex` is 0-based, like `match_games.index`.
 */
export function sideChooserFor(firstSideChoice: unknown, gameIndex: number): MatchSlot {
  const first = normaliseMatchSlot(firstSideChoice);
  const index = Number.isFinite(gameIndex) ? Math.abs(Math.trunc(gameIndex)) : 0;
  return index % 2 === 0 ? first : otherSlot(first);
}

/** The other one, always. Whoever does not choose the side chooses the map. */
export function mapChooserFor(firstSideChoice: unknown, gameIndex: number): MatchSlot {
  return otherSlot(sideChooserFor(firstSideChoice, gameIndex));
}

/**
 * The coin itself.
 *
 * Injectable rather than reaching for `Math.random` inside a write, so a test
 * can pin it — the one thing about this rule that is genuinely random is also
 * the one thing a test cannot assert about.
 */
export function tossForFirstSideChoice(random: () => number = Math.random): MatchSlot {
  return random() < 0.5 ? "a" : "b";
}

/* ------------------------------------------------------------------ */
/* What is not a result (R-78 / UC-19 pre1, 4a, 5a)                   */
/* ------------------------------------------------------------------ */

/**
 * Recording a result is the one write on this site that can destroy a record of
 * something that actually happened, so every one of these refusals is a
 * sentence rather than a silent correction.
 *
 * That is the change of mind. The old `score()` in `./format.ts` clamped: a
 * negative number, a decimal, a word and a number in the millions all resolved
 * to "whatever is stored now", the write reported success, and the manager was
 * told their scoreline was saved while a different one went to the database.
 * A value nobody can read is not a smaller value — it is a question, and the
 * only honest answer to a question about a result is to refuse and say why
 * (UC-19 4a: "System rejects with the reason; nothing stored").
 *
 * All of it is pure, and none of it takes a database handle, for the reason the
 * rest of this file does not: the refusals are the specification, so they are
 * asserted directly rather than through a transaction.
 */

/** The ceiling on one game's score. Far above any real scoreline, and finite. */
export const SCORE_MAX = 999;

/** A number, or null for anything that is not one. `""` and `null` are not. */
function numeric(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * **Why one score is not a score, or null when it is one** (UC-19 4a).
 *
 * `undefined` is not a refusal: an absent score leaves the stored one alone,
 * which is what lets a patch set a referee without restating the scoreline.
 *
 * `gameNumber` is 1-based, as the card prints it — "Game 2" is what the manager
 * is looking at, and `index: 1` is not.
 */
export function scoreRefusal(raw: unknown, gameNumber: number): string | null {
  if (raw === undefined) return null;
  const parsed = numeric(raw);
  if (parsed === null) return `Game ${gameNumber}'s score is not a number.`;
  if (!Number.isInteger(parsed)) {
    return `Game ${gameNumber}'s score has to be a whole number — ${parsed} is not.`;
  }
  if (parsed < 0) return `Game ${gameNumber} cannot have a negative score.`;
  if (parsed > SCORE_MAX) {
    return `Game ${gameNumber}'s score is above ${SCORE_MAX}, which is not a scoreline.`;
  }
  return null;
}

/** A score that has already been through `scoreRefusal`. */
export function readScore(raw: unknown, current: number): number {
  const parsed = numeric(raw);
  return parsed === null ? current : parsed;
}

/** One game of a series, as the shape rules below need it. */
export type SeriesGame = { played: boolean; scoreA: number; scoreB: number };

/**
 * **Why this series is not a series, or null when it is one** (UC-19 4a, 5a).
 *
 * Asked of the *whole* series as it will stand after the write, never of the
 * patch: "game 4 was played after the series was already won" is a fact about
 * games 1 to 4 together, and a manager correcting game 2 of a Bo5 sends one
 * game and changes which game decided it. A rule applied to the patch alone is
 * a rule that two managers saving different halves of the same card can walk
 * straight through.
 *
 * Three shapes, and each of them means something different went wrong:
 *
 *  - **A hole.** Game 3 has a result and game 2 does not. A series is played in
 *    order, so this is a score typed into the wrong row — and the scoreline it
 *    produces is right by accident at best.
 *  - **A level single map in a knockout.** One map, no further map, and nobody
 *    ahead: there is nothing for the series to resolve into. A drawn map inside
 *    a longer series is a real result, and a drawn *table* game is a finished
 *    match worth a point each (`DEFAULT_POINTS.draw`) — neither is this.
 *  - **A game beyond the decider, in a knockout.** The series was won in game 3
 *    and game 4 has a result, so the record is of a series that was over —
 *    nobody played that map, because there was nothing left to play for. UC-19
 *    5a from the other side: a map beyond the series.
 *
 *    A *table* series is deliberately not held to this. Every map played there
 *    counts towards the table — `score_for` is one of the tiebreakers — so a
 *    dead rubber after the series is mathematically won is a real result
 *    somebody recorded, and refusing it would delete it.
 *
 * `elimination` is the resolver's own flag, not a second opinion about it: a
 * table game and a knockout series differ on exactly the second and third
 * rules, and which one a slot is is decided by `./bracket`.
 */
export function seriesRefusal(series: {
  bestOf: number;
  elimination: boolean;
  games: readonly SeriesGame[];
}): string | null {
  const games = series.games;
  const lastPlayed = games.reduce((last, game, index) => (game.played ? index : last), -1);
  if (lastPlayed < 0) return null;

  const hole = games.findIndex((game, index) => index < lastPlayed && !game.played);
  if (hole >= 0) {
    return `Game ${hole + 1} has no result, so game ${lastPlayed + 1} cannot have one — a series is played in order.`;
  }

  if (series.elimination && series.bestOf <= 1) {
    const only = games[0];
    if (only?.played && only.scoreA === only.scoreB) {
      return "A single map cannot end level — one of the two teams has to advance. Record the map that was played, or clear the series and play it again.";
    }
  }

  if (!series.elimination) return null;

  const target = seriesTarget(series.bestOf);
  let a = 0;
  let b = 0;
  for (const [index, game] of games.entries()) {
    if (a >= target || b >= target) {
      if (game.played) {
        return `The series was already won in game ${index}, so game ${index + 1} cannot have been played.`;
      }
      continue;
    }
    if (!game.played) continue;
    if (game.scoreA > game.scoreB) a += 1;
    else if (game.scoreB > game.scoreA) b += 1;
  }

  return null;
}

/**
 * **Why this match cannot have a result yet, or null when it can**
 * (UC-19 precondition 1).
 *
 * A bracket slot says where its teams come from rather than which teams they
 * are, so "Upper final" exists, is scheduled and has five empty game rows long
 * before anybody can play it. A score against it is a score against nobody:
 * whichever teams arrive later inherit a scoreline they did not play, and the
 * slot above inherits a winner chosen by a bug.
 *
 * It names what the match is waiting on rather than saying "unresolved",
 * because the placeholder is already the thing the board prints — "Upper semi 1
 * winner" is both the refusal and the instruction.
 */
export function unresolvedSlotRefusal(match: {
  teamAId: string | null;
  teamBId: string | null;
  nameA: string;
  nameB: string;
}): string | null {
  const waiting = [
    match.teamAId ? null : match.nameA,
    match.teamBId ? null : match.nameB,
  ].filter((name): name is string => typeof name === "string");
  if (waiting.length === 0) return null;
  return `This match is still waiting on ${waiting.join(" and ")}, so it cannot have a result yet.`;
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
