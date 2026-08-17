/**
 * Bracket and group generation for 2–8 teams (docs/platform-plan.md §8.2).
 *
 * One function builds every shape. Nothing in here is written per team count:
 * a bracket is a tree of *pairings over source references*, and a bye is simply
 * a pairing with one empty side, which collapses into the reference it carries
 * upward. That single rule is what makes 5 teams work without a special case —
 * seeds 1–3 get a bye because the standard seeding order puts the three phantom
 * seeds opposite them, and the three matches that would have been played are
 * never created.
 *
 * ## What a generated match is, and is not
 *
 * It is a slot, a round, a phase, a series length, a mode sequence, two source
 * references and the words to print. It is **not** a result and it is not a
 * time — those live on the stored row, and the two are combined on read by
 * `./format-resolve`. Regenerating a stage from `(kind, teamCount, config)` is
 * deterministic, so the labels, the stakes notes and the placement table never
 * need a column: they are derived, exactly as the bracket's teams are.
 *
 * ## Phases
 *
 * `phase` is the depth of a match in the dependency graph — one more than the
 * deepest thing it waits on. Everything in a phase can be played at the same
 * time, which is precisely what the scheduler wants: it chops each phase into
 * blocks of `concurrentLobbies` and lays them end to end (§10). For the current
 * 4-team double elimination this reproduces the hardcoded phase list exactly,
 * including the upper final and lower round 1 sharing phase 2.
 *
 * ## Cross-references
 *
 *  - `./format-policy` — configuration, the source grammar, seeding order
 *  - `./format-resolve` — turns these plus stored results into a board
 *  - `./format-schedule` — turns these plus timing into a running order
 */

import {
  type EliminationKind,
  type SeriesLength,
  type StageConfig,
  type StageKind,
  MAX_TEAMS,
  MIN_TEAMS,
  bestOfFor,
  groupKey,
  groupRef,
  loserRef,
  modesFor,
  nextPowerOfTwo,
  normaliseStageConfig,
  ordinal,
  seedOrder,
  seedRef,
  winnerRef,
} from "./format-policy";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Which half of a stage a match belongs to.
 *
 * `upper` is the bracket proper — in a single elimination that is the whole of
 * it, and the name is kept so one `bestOfByBracket` key covers both shapes.
 * `final` is a grand final or a bracket reset.
 */
export type MatchBracket = "rr" | "upper" | "lower" | "final" | "bronze";

export type GeneratedMatch = {
  /** Unique within its stage. `rr-1-2`, `ubsf1`, `lbf`, `gf`. */
  slot: string;
  /** Round within this match's own half — the circle round, or the bracket round. */
  round: number;
  /** Dependency depth. Everything sharing a phase can be played at once. */
  phase: number;
  bestOf: SeriesLength;
  /** One mode per game of the series, in order. */
  modes: string[];
  sourceA: string;
  sourceB: string;
  bracket: MatchBracket;
  /** Group key for a group stage's table matches; null everywhere else. */
  group: string | null;
  /** Short name, and the one placeholders are built from: "Upper semi 1". */
  label: string;
  /** What the board prints: "Lower final · bronze". */
  displayLabel: string;
  /** The name of the whole round, for a schedule block: "Upper semis". */
  roundLabel: string;
  /** What is at stake: "Loser takes bronze". */
  note: string | null;
  /** A drawn series here stalls for an admin decision; a drawn table game does not. */
  elimination: boolean;
  /** Played only if the grand final was won by the team that came up from below. */
  conditional: "bracket_reset" | null;
};

/** Where one finishing position comes from. */
export type PlacementRule = {
  position: number;
  /** How many teams share this block of positions. 1 is a clean placing. */
  shared: number;
  slot: string;
  from: "winner" | "loser";
};

export type StageGroup = { key: string; seeds: number[] };

export type GeneratedStage = {
  kind: StageKind;
  teamCount: number;
  config: StageConfig;
  matches: GeneratedMatch[];
  bySlot: Record<string, GeneratedMatch>;
  /** Group keys in order and the global seeds in each. Empty unless grouped. */
  groups: StageGroup[];
  /** The slot whose winner is champion, if this stage produces one. */
  championSlot: string | null;
  /** The bracket-reset slot, when §8.2's toggle is on. */
  resetSlot: string | null;
  /** Finishing positions this stage can settle, best first. */
  placements: PlacementRule[];
};

/* ------------------------------------------------------------------ */
/* Naming                                                             */
/* ------------------------------------------------------------------ */

type RoundName = { key: string; one: string; many: string };

/**
 * What a round of a bracket is called, from how many matches it *would* hold in
 * a full bracket of that size — so a 5-team bracket's single first-round match
 * is still a quarter-final, which is what everybody calls it.
 */
function roundName(fullMatches: number): RoundName {
  switch (fullMatches) {
    case 1:
      return { key: "f", one: "final", many: "final" };
    case 2:
      return { key: "sf", one: "semi", many: "semis" };
    case 4:
      return { key: "qf", one: "quarter", many: "quarters" };
    default: {
      const of = fullMatches * 2;
      return { key: `r${of}`, one: `round of ${of}`, many: `round of ${of}` };
    }
  }
}

/**
 * A slot for match `index` of `count` in a round whose base is `base`.
 *
 * One match keeps the bare base (`ubf`, `lbr1`), which is what makes the
 * generated 4-team bracket read identically to the hand-written one. A base
 * that already ends in a digit takes a separator, so `lbr1` with two matches is
 * `lbr1-1` and never the unreadable `lbr11`.
 */
function slotFor(base: string, index: number, count: number): string {
  if (count <= 1) return base;
  return /[0-9]$/.test(base) ? `${base}-${index}` : `${base}${index}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "Upper semi" plus its index — with the same guard `slotFor` uses, so a label
 * that already ends in a number ("Lower round 2") gets a separator rather than
 * becoming the unreadable "Lower round 2 2".
 */
function numbered(label: string, index: number, count: number): string {
  if (count <= 1) return label;
  return /[0-9]$/.test(label) ? `${label} · ${index}` : `${label} ${index}`;
}

/* ------------------------------------------------------------------ */
/* The builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * One side of a pairing: where the team comes from, and how deep in the
 * dependency graph that reference already is. A null reference is a bye.
 */
type Side = { ref: string | null; depth: number };

const NOBODY: Side = { ref: null, depth: 0 };

type RoundSpec = {
  bracket: MatchBracket;
  round: number;
  base: string;
  /** Label for one match of the round, before its index is appended. */
  label: string;
  roundLabel: string;
};

class StageBuilder {
  readonly matches: GeneratedMatch[] = [];

  constructor(private readonly config: StageConfig) {}

  /**
   * Build one round of pairings.
   *
   * A pairing with one empty side is not a match: the team that would have had
   * the bye is handed straight to the next round, carrying its own depth so the
   * phase numbering never counts a match that does not exist. A pairing with
   * two empty sides disappears entirely.
   */
  round(spec: RoundSpec, pairs: Array<[Side, Side]>): { winners: Side[]; losers: Side[] } {
    const real = pairs.filter(([a, b]) => a.ref && b.ref).length;
    const winners: Side[] = [];
    const losers: Side[] = [];
    let index = 0;

    for (const [a, b] of pairs) {
      const depth = Math.max(a.depth, b.depth);
      if (!a.ref || !b.ref) {
        // Whichever side exists walks through; nobody loses a match that is not
        // played, so the loser reference is empty and anything downstream of it
        // collapses in turn.
        winners.push(a.ref ? a : b.ref ? b : { ref: null, depth });
        losers.push({ ref: null, depth });
        continue;
      }
      index += 1;
      const slot = slotFor(spec.base, index, real);
      const label = numbered(spec.label, index, real);
      this.push({
        slot,
        round: spec.round,
        phase: depth + 1,
        bracket: spec.bracket,
        group: null,
        sourceA: a.ref,
        sourceB: b.ref,
        label,
        displayLabel: label,
        roundLabel: spec.roundLabel,
        note: null,
        elimination: true,
        conditional: null,
      });
      winners.push({ ref: winnerRef(slot), depth: depth + 1 });
      losers.push({ ref: loserRef(slot), depth: depth + 1 });
    }

    return { winners, losers };
  }

  /** Add a match, filling in the series length and mode sequence from config. */
  push(partial: Omit<GeneratedMatch, "bestOf" | "modes">): GeneratedMatch {
    const bestOf = bestOfFor(this.config, {
      slot: partial.slot,
      round: partial.round,
      bracket: partial.bracket,
    });
    const match: GeneratedMatch = { ...partial, bestOf, modes: modesFor(this.config, bestOf) };
    this.matches.push(match);
    return match;
  }

  find(slot: string): GeneratedMatch | undefined {
    return this.matches.find((m) => m.slot === slot);
  }

  /** Existing matches of one round of one half, in slot order. */
  inRound(bracket: MatchBracket, round: number): GeneratedMatch[] {
    return this.matches.filter((m) => m.bracket === bracket && m.round === round);
  }
}

/* ------------------------------------------------------------------ */
/* Elimination brackets                                               */
/* ------------------------------------------------------------------ */

type EliminationOptions = {
  builder: StageBuilder;
  teamCount: number;
  /** Where bracket position `n` comes from — `seed:n`, or a group rank in a playoff. */
  entrant: (position: number) => string;
  /** Depth the entrant references already carry (a group stage's last round). */
  entrantDepth: number;
  /** `ub` for a double elimination's upper half; empty for a single elimination. */
  prefix: string;
  /** "Upper " for a double elimination; empty for a single one. */
  labelPrefix: string;
};

type EliminationResult = {
  /** Winner of the last round — the bracket's champion, before any grand final. */
  champion: Side;
  /** Losers of each round, in the round's full pairing order (byes are empty). */
  losersByRound: Side[][];
  rounds: number;
};

/**
 * A straight single elimination over `teamCount` teams padded up to the next
 * power of two, with the phantom seeds — and therefore the byes — landing on
 * the top seeds by construction. Also the upper half of a double elimination.
 */
function buildElimination(options: EliminationOptions): EliminationResult {
  const { builder, teamCount, entrant, entrantDepth, prefix, labelPrefix } = options;
  const size = nextPowerOfTwo(Math.max(teamCount, 2));
  const rounds = Math.round(Math.log2(size));

  let sides: Side[] = seedOrder(size).map((position) => ({
    ref: position <= teamCount ? entrant(position) : null,
    depth: entrantDepth,
  }));

  const losersByRound: Side[][] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const name = roundName(size / 2 ** round);
    const isLast = round === rounds;
    const base = isLast && prefix ? `${prefix}f` : `${prefix}${name.key}`;
    const one = isLast && prefix ? `${labelPrefix}final` : `${labelPrefix}${name.one}`;
    const many = isLast && prefix ? `${labelPrefix}final` : `${labelPrefix}${name.many}`;

    const pairs: Array<[Side, Side]> = [];
    for (let i = 0; i < sides.length; i += 2) pairs.push([sides[i], sides[i + 1]]);

    const { winners, losers } = builder.round(
      {
        bracket: "upper",
        round,
        base,
        label: labelPrefix ? one : capitalise(one),
        roundLabel: labelPrefix ? many : capitalise(many),
      },
      pairs
    );
    sides = winners;
    losersByRound.push(losers);
  }

  return { champion: sides[0] ?? NOBODY, losersByRound, rounds };
}

/**
 * The lower half of a double elimination.
 *
 * Standard construction: round 1 pairs the upper first round's losers, then for
 * each subsequent upper round a **major** round drops that round's losers in
 * against the survivors, followed — except after the upper final — by a
 * **minor** round pairing the survivors back down to half.
 *
 * The droppers are assigned to the survivors in reverse order, the usual guard
 * against an immediate rematch of the game somebody has just lost. The dropper
 * is side A, so the lower final reads "upper final loser vs lower round 1
 * winner", exactly as the current board does.
 */
function buildLowerBracket(
  builder: StageBuilder,
  losersByRound: Side[][],
  upperRounds: number
): { champion: Side; rounds: number } {
  if (upperRounds < 2) {
    // Two teams: there is no lower bracket, and the loser of the only upper
    // match *is* the lower-bracket champion — they take their second life in
    // the grand final. Double elimination with two teams is exactly that.
    return { champion: losersByRound[0]?.[0] ?? NOBODY, rounds: 0 };
  }

  const total = 2 * upperRounds - 2;
  let round = 0;

  const spec = (): RoundSpec => {
    round += 1;
    const last = round === total;
    return {
      bracket: "lower",
      round,
      base: last ? "lbf" : `lbr${round}`,
      label: last ? "Lower final" : `Lower round ${round}`,
      roundLabel: last ? "Lower final" : `Lower round ${round}`,
    };
  };

  const first = losersByRound[0];
  const firstPairs: Array<[Side, Side]> = [];
  for (let i = 0; i < first.length; i += 2) firstPairs.push([first[i], first[i + 1]]);
  let survivors = builder.round(spec(), firstPairs).winners;

  for (let upper = 2; upper <= upperRounds; upper += 1) {
    const droppers = [...losersByRound[upper - 1]].reverse();
    const major: Array<[Side, Side]> = survivors.map((survivor, i) => [
      droppers[i] ?? NOBODY,
      survivor,
    ]);
    survivors = builder.round(spec(), major).winners;

    if (upper === upperRounds) break;

    const minor: Array<[Side, Side]> = [];
    for (let i = 0; i < survivors.length; i += 2) minor.push([survivors[i], survivors[i + 1]]);
    survivors = builder.round(spec(), minor).winners;
  }

  return { champion: survivors[0] ?? NOBODY, rounds: round };
}

/* ------------------------------------------------------------------ */
/* Round robin                                                        */
/* ------------------------------------------------------------------ */

/**
 * Circle rotation: seat one team still and rotate the rest, so every round is a
 * perfect pairing and nobody plays twice in it. With an odd field a ghost is
 * added and whoever draws it sits that round out.
 *
 * Pairs are oriented and ordered by seed, which is cosmetic but is also what
 * makes the 4-team case land on exactly the pairing the current board hardcodes
 * — see the parity test.
 */
export function circleRounds(seeds: number[]): Array<Array<[number, number]>> {
  if (seeds.length < 2) return [];
  const list = [...seeds];
  if (list.length % 2 === 1) list.push(0); // the ghost; whoever meets it rests

  const fixed = list[0];
  let rotating = list.slice(1);
  const rounds: Array<Array<[number, number]>> = [];

  for (let round = 0; round < list.length - 1; round += 1) {
    const pairs: Array<[number, number]> = [];
    const add = (a: number, b: number) => {
      if (a === 0 || b === 0) return;
      pairs.push(a < b ? [a, b] : [b, a]);
    };
    add(fixed, rotating[0]);
    for (let i = 1; i <= (rotating.length - 1) / 2; i += 1) {
      add(rotating[i], rotating[rotating.length - i]);
    }
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    rounds.push(pairs);
    rotating = [...rotating.slice(1), rotating[0]];
  }

  return rounds;
}

type RoundRobinOptions = {
  builder: StageBuilder;
  seeds: number[];
  doubleRound: boolean;
  group: string | null;
  /** `rr` normally, `ga` for group A. */
  slotPrefix: string;
  /** "" normally, "Group A · " for a group stage. */
  labelPrefix: string;
  /** What the schedule calls the round: "Round robin 1". */
  roundNoun: string;
};

function buildRoundRobin(options: RoundRobinOptions): number {
  const { builder, seeds, doubleRound, group, slotPrefix, labelPrefix, roundNoun } = options;
  let round = 0;

  for (let leg = 1; leg <= (doubleRound ? 2 : 1); leg += 1) {
    for (const pairs of circleRounds(seeds)) {
      round += 1;
      for (const [low, high] of pairs) {
        // The return leg swaps who is listed first, which is the only thing
        // "home and away" can mean on a board with no home ground.
        const [a, b] = leg === 1 ? [low, high] : [high, low];
        const slot = `${leg === 1 ? slotPrefix : `${slotPrefix}2`}-${a}-${b}`;
        builder.push({
          slot,
          round,
          phase: round,
          bracket: "rr",
          group,
          sourceA: seedRef(a),
          sourceB: seedRef(b),
          label: `${labelPrefix}Round ${round}`,
          displayLabel: `${labelPrefix}Round ${round}`,
          roundLabel: `${labelPrefix}${roundNoun} ${round}`,
          note: null,
          elimination: false,
          conditional: null,
        });
      }
    }
  }

  return round;
}

/* ------------------------------------------------------------------ */
/* Notes and placements                                                */
/* ------------------------------------------------------------------ */

type AnnotateOptions = {
  finalSlot: string | null;
  bronze: "none" | "match" | "lower_final";
  bronzeSlot: string | null;
  /** Rounds to walk, deepest first. */
  elimRounds: Array<{ bracket: MatchBracket; round: number }>;
};

/**
 * Hang the stakes notes and build the placement table.
 *
 * Both come from the same walk: finishing positions fill from the bottom of the
 * bracket upwards, so the losers of the last elimination round take the next
 * block of positions, the round before that takes the block under it, and so
 * on. A round with one match names a place outright ("Loser is 4th"); a round
 * with two names a pair ("Loser is 5th–6th"); anything wider is left unlabelled
 * rather than printing "Loser is 5th–8th" on four separate cards.
 */
function annotate(builder: StageBuilder, options: AnnotateOptions): PlacementRule[] {
  const { finalSlot, bronze, bronzeSlot } = options;
  const placements: PlacementRule[] = [];

  if (finalSlot) {
    const final = builder.find(finalSlot);
    if (final) final.note = "Winner is champion";
    placements.push({ position: 1, shared: 1, slot: finalSlot, from: "winner" });
    placements.push({ position: 2, shared: 1, slot: finalSlot, from: "loser" });
  }

  let cursor = finalSlot ? 3 : 1;

  if (bronze === "lower_final" && bronzeSlot) {
    const match = builder.find(bronzeSlot);
    if (match) {
      match.note = "Loser takes bronze";
      match.displayLabel = `${match.label} · bronze`;
      match.roundLabel = `${match.roundLabel} · bronze`;
    }
    placements.push({ position: cursor, shared: 1, slot: bronzeSlot, from: "loser" });
    cursor += 1;
  } else if (bronze === "match" && bronzeSlot) {
    const match = builder.find(bronzeSlot);
    if (match) match.note = "Winner takes bronze";
    placements.push({ position: cursor, shared: 1, slot: bronzeSlot, from: "winner" });
    placements.push({ position: cursor + 1, shared: 1, slot: bronzeSlot, from: "loser" });
    cursor += 2;
  }

  for (const { bracket, round } of options.elimRounds) {
    const matches = builder
      .inRound(bracket, round)
      .filter((m) => m.slot !== bronzeSlot && m.slot !== finalSlot);
    if (matches.length === 0) continue;
    const shared = matches.length;
    const from = cursor;
    for (const match of matches) {
      if (!match.note) {
        match.note =
          shared === 1
            ? `Loser is ${ordinal(from)}`
            : shared === 2
              ? `Loser is ${ordinal(from)}–${ordinal(from + 1)}`
              : null;
      }
      placements.push({ position: from, shared, slot: match.slot, from: "loser" });
    }
    cursor += shared;
  }

  return placements;
}

/* ------------------------------------------------------------------ */
/* Stage generation                                                   */
/* ------------------------------------------------------------------ */

function clampTeams(teamCount: number): number {
  return Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, Math.trunc(teamCount) || MIN_TEAMS));
}

function finish(
  kind: StageKind,
  teamCount: number,
  config: StageConfig,
  builder: StageBuilder,
  extra: Partial<Omit<GeneratedStage, "kind" | "teamCount" | "config" | "matches" | "bySlot">>
): GeneratedStage {
  const bySlot: Record<string, GeneratedMatch> = {};
  for (const match of builder.matches) bySlot[match.slot] = match;
  return {
    kind,
    teamCount,
    config,
    matches: builder.matches,
    bySlot,
    groups: extra.groups ?? [],
    championSlot: extra.championSlot ?? null,
    resetSlot: extra.resetSlot ?? null,
    placements: extra.placements ?? [],
  };
}

type BracketInput = {
  builder: StageBuilder;
  teamCount: number;
  config: StageConfig;
  entrant: (position: number) => string;
  entrantDepth: number;
};

/** A single elimination, plus its optional bronze match. */
function buildSingleElim(input: BracketInput): {
  championSlot: string | null;
  placements: PlacementRule[];
} {
  const { builder, teamCount, config, entrant, entrantDepth } = input;
  const { rounds } = buildElimination({
    builder,
    teamCount,
    entrant,
    entrantDepth,
    prefix: "",
    labelPrefix: "",
  });

  const finalSlot = builder.inRound("upper", rounds)[0]?.slot ?? null;
  const semis = rounds >= 2 ? builder.inRound("upper", rounds - 1) : [];

  // A bronze match needs two semi-finalists to lose. With three teams only one
  // semi is played, so there is nobody for its loser to play.
  let bronzeSlot: string | null = null;
  if (config.bronze !== "none" && semis.length === 2) {
    bronzeSlot = "bronze";
    builder.push({
      slot: bronzeSlot,
      round: rounds,
      phase: Math.max(semis[0].phase, semis[1].phase) + 1,
      bracket: "bronze",
      group: null,
      sourceA: loserRef(semis[0].slot),
      sourceB: loserRef(semis[1].slot),
      label: "Bronze match",
      displayLabel: "Bronze match",
      roundLabel: "Bronze match",
      note: null,
      elimination: true,
      conditional: null,
    });
  }

  // A bronze match already places both semi losers, so the walk starts a round
  // earlier when there is one.
  const elimRounds: AnnotateOptions["elimRounds"] = [];
  for (let round = rounds - (bronzeSlot ? 2 : 1); round >= 1; round -= 1) {
    elimRounds.push({ bracket: "upper", round });
  }

  const placements = annotate(builder, {
    finalSlot,
    bronze: bronzeSlot ? "match" : "none",
    bronzeSlot,
    elimRounds,
  });

  return { championSlot: finalSlot, placements };
}

/** A double elimination: upper, lower, grand final and the optional reset. */
function buildDoubleElim(input: BracketInput): {
  championSlot: string | null;
  resetSlot: string | null;
  placements: PlacementRule[];
} {
  const { builder, teamCount, config, entrant, entrantDepth } = input;
  const upper = buildElimination({
    builder,
    teamCount,
    entrant,
    entrantDepth,
    prefix: "ub",
    labelPrefix: "Upper ",
  });
  const lower = buildLowerBracket(builder, upper.losersByRound, upper.rounds);

  let championSlot: string | null = null;
  let resetSlot: string | null = null;

  if (upper.champion.ref && lower.champion.ref) {
    const depth = Math.max(upper.champion.depth, lower.champion.depth) + 1;
    // Past the last round of either half, so a per-round series length can name
    // it without also catching a lower-bracket round of the same number.
    const round = Math.max(upper.rounds, lower.rounds) + 1;
    championSlot = "gf";
    builder.push({
      slot: "gf",
      round,
      phase: depth,
      bracket: "final",
      group: null,
      sourceA: upper.champion.ref,
      sourceB: lower.champion.ref,
      label: "Grand final",
      displayLabel: "Grand final",
      roundLabel: "Grand final",
      note: null,
      elimination: true,
      conditional: null,
    });

    if (config.bracketReset) {
      // The reset's two teams are the grand final's two teams whichever way it
      // went — but it is only played when the side that came up from the lower
      // bracket won, which is the one thing a source reference cannot say. The
      // resolver reads `resetSlot` and asks that question itself.
      resetSlot = "gf2";
      builder.push({
        slot: resetSlot,
        round: round + 1,
        phase: depth + 1,
        bracket: "final",
        group: null,
        sourceA: winnerRef("gf"),
        sourceB: loserRef("gf"),
        label: "Bracket reset",
        displayLabel: "Bracket reset",
        roundLabel: "Bracket reset",
        note: null,
        elimination: true,
        conditional: "bracket_reset",
      });
    }
  }

  const lowerFinal = lower.rounds > 0 ? (builder.inRound("lower", lower.rounds)[0]?.slot ?? null) : null;
  const bronze = config.bronze !== "none" && lowerFinal ? "lower_final" : "none";

  const elimRounds: AnnotateOptions["elimRounds"] = [];
  // The lower final is only walked here when it is not already the bronze match.
  for (let round = lower.rounds - (bronze === "lower_final" ? 1 : 0); round >= 1; round -= 1) {
    elimRounds.push({ bracket: "lower", round });
  }
  if (lower.rounds === 0) {
    for (let round = upper.rounds - 1; round >= 1; round -= 1) {
      elimRounds.push({ bracket: "upper", round });
    }
  }

  const placements = annotate(builder, {
    finalSlot: championSlot,
    bronze,
    bronzeSlot: lowerFinal,
    elimRounds,
  });

  return { championSlot, resetSlot, placements };
}

/**
 * Split a field into groups, snaking so the strength is even: with two groups
 * seeds 1 and 4 face 2 and 3, which is the same fairness argument the bracket
 * seeding makes.
 */
export function splitIntoGroups(teamCount: number, groups: number): number[][] {
  const count = Math.min(Math.max(Math.trunc(groups) || 1, 1), teamCount);
  const out: number[][] = Array.from({ length: count }, () => []);
  for (let seed = 1; seed <= teamCount; seed += 1) {
    const row = Math.floor((seed - 1) / count);
    const column = (seed - 1) % count;
    out[row % 2 === 0 ? column : count - 1 - column].push(seed);
  }
  return out;
}

/**
 * Swiss round 1: the top half against the bottom half, in order — 1 v 5, 2 v 6
 * and so on for eight teams.
 *
 * Only the first round can be generated. Every later Swiss pairing is a
 * function of results that do not exist yet, so they are created round by round
 * from the standings; `swissPairings` does that, and the stage carries
 * `config.rounds` so the board knows how many are still to come.
 */
export function swissRoundOne(teamCount: number): Array<[number, number]> {
  const half = Math.ceil(teamCount / 2);
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i <= half; i += 1) {
    if (i + half <= teamCount) pairs.push([i, i + half]);
  }
  return pairs;
}

/**
 * The next Swiss round: pair the table from the top down, skipping anyone
 * already met. An odd field leaves the lowest unpaired team with a bye.
 *
 * Greedy rather than optimal — a perfect Swiss pairing is a weighted matching
 * problem, and at eight teams over three rounds the greedy answer is the same
 * one a tournament director writes on the whiteboard.
 */
export function swissPairings(
  order: string[],
  played: Array<[string, string]>
): { pairs: Array<[string, string]>; bye: string | null } {
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const met = new Set(played.map(([a, b]) => key(a, b)));
  const left = [...order];
  const pairs: Array<[string, string]> = [];

  while (left.length > 1) {
    const a = left.shift() as string;
    let index = left.findIndex((b) => !met.has(key(a, b)));
    if (index < 0) index = 0; // everyone has met: a rematch beats no match
    const [b] = left.splice(index, 1);
    pairs.push([a, b]);
  }

  return { pairs, bye: left[0] ?? null };
}

/**
 * Generate a whole stage.
 *
 * The only entry point that matters: give it a kind, a team count between 2 and
 * 8 and a configuration, and it returns every match with its sources, its
 * series length, its mode sequence and the words to print. Nothing about the
 * team count is special-cased anywhere below it.
 */
export function generateStage(
  kind: StageKind,
  teamCount: number,
  input?: Partial<StageConfig> | null
): GeneratedStage {
  const teams = clampTeams(teamCount);
  const config = normaliseStageConfig(kind, input);
  const builder = new StageBuilder(config);
  const entrant = (position: number) => seedRef(position);

  if (kind === "round_robin") {
    buildRoundRobin({
      builder,
      seeds: Array.from({ length: teams }, (_, i) => i + 1),
      doubleRound: config.doubleRound,
      group: null,
      slotPrefix: "rr",
      labelPrefix: "",
      roundNoun: "Round robin",
    });
    return finish(kind, teams, config, builder, {});
  }

  if (kind === "swiss") {
    for (const [a, b] of swissRoundOne(teams)) {
      builder.push({
        slot: `sw1-${a}-${b}`,
        round: 1,
        phase: 1,
        bracket: "rr",
        group: null,
        sourceA: seedRef(a),
        sourceB: seedRef(b),
        label: "Round 1",
        displayLabel: "Round 1",
        roundLabel: "Swiss round 1",
        note: null,
        elimination: false,
        conditional: null,
      });
    }
    return finish(kind, teams, config, builder, {});
  }

  if (kind === "single_elim") {
    const { championSlot, placements } = buildSingleElim({
      builder,
      teamCount: teams,
      config,
      entrant,
      entrantDepth: 0,
    });
    return finish(kind, teams, config, builder, { championSlot, placements });
  }

  if (kind === "double_elim") {
    const { championSlot, resetSlot, placements } = buildDoubleElim({
      builder,
      teamCount: teams,
      config,
      entrant,
      entrantDepth: 0,
    });
    return finish(kind, teams, config, builder, { championSlot, resetSlot, placements });
  }

  // group_playoff: tables first, then the qualifiers into a bracket.
  // A group of one is not a group — it is a team with nothing to play — so the
  // requested number is capped at what the field can actually fill.
  const split = splitIntoGroups(teams, Math.max(1, Math.min(config.groups, Math.floor(teams / 2))));
  const groups: StageGroup[] = split.map((seeds, i) => ({ key: groupKey(i), seeds }));
  // You cannot advance more teams than the thinnest group holds.
  const advance = Math.max(1, Math.min(config.advancePerGroup, ...split.map((s) => s.length)));

  let deepest = 0;
  for (const { key, seeds } of groups) {
    deepest = Math.max(
      deepest,
      buildRoundRobin({
        builder,
        seeds,
        doubleRound: config.doubleRound,
        group: key,
        slotPrefix: `g${key}`,
        labelPrefix: `Group ${key.toUpperCase()} · `,
        roundNoun: "Round",
      })
    );
  }

  // Cross-seeded: every group's winner first, then every runner-up, so the
  // opening tie of the bracket is A1 against the last group's second.
  const bracket: BracketInput = {
    builder,
    teamCount: groups.length * advance,
    config,
    entrant: (position) =>
      groupRef(
        groups[(position - 1) % groups.length].key,
        Math.floor((position - 1) / groups.length) + 1
      ),
    entrantDepth: deepest,
  };

  if (config.playoffKind === "double_elim") {
    const { championSlot, resetSlot, placements } = buildDoubleElim(bracket);
    return finish(kind, teams, config, builder, { groups, championSlot, resetSlot, placements });
  }
  const { championSlot, placements } = buildSingleElim(bracket);
  return finish(kind, teams, config, builder, { groups, championSlot, placements });
}

/**
 * §8.2's headline: a bracket for any team count from 2 to 8, with no
 * hand-written table per size. An alias for `generateStage` restricted to the
 * two elimination kinds, which is how the admin's Format tab will call it.
 */
export function generateBracket(
  format: EliminationKind,
  teamCount: number,
  config?: Partial<StageConfig> | null
): GeneratedStage {
  return generateStage(format, teamCount, config);
}
