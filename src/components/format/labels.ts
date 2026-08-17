/**
 * The words the format engine's output is printed with.
 *
 * Pure, and deliberately kept out of the `.tsx` files so both a server
 * component and a client one can call them — the same reason
 * `src/components/events/when.ts` exists. Nothing here decides anything: every
 * number it prints has already been settled by `src/lib/bracket.ts` or
 * `src/lib/format-policy.ts`, and this only chooses the noun.
 */

import type { GeneratedStage, MatchBracket } from "@/lib/bracket";
import type { BronzeMode, StageKind, Tiebreaker } from "@/lib/format-policy";
import type { MatchStatus, ResolvedMatch } from "@/lib/format-resolve";

/* ------------------------------------------------------------------ */
/* Stage kinds                                                        */
/* ------------------------------------------------------------------ */

export type Choice<T extends string> = { value: T; label: string; blurb: string };

/**
 * The five shapes an event can be played in, in the order an organiser thinks
 * about them: the flat table first, then knockouts, then the two-part ones.
 */
export const STAGE_KIND_CHOICES: ReadonlyArray<Choice<StageKind>> = [
  {
    value: "round_robin",
    label: "Round robin",
    blurb: "Everyone plays everyone. No knockout, the table decides.",
  },
  {
    value: "single_elim",
    label: "Single elimination",
    blurb: "One loss and you are out. Byes go to the top seeds.",
  },
  {
    value: "double_elim",
    label: "Double elimination",
    blurb: "A lower bracket gives everyone a second life.",
  },
  {
    value: "group_playoff",
    label: "Groups into a bracket",
    blurb: "Group tables first, then the qualifiers play a bracket.",
  },
  {
    value: "swiss",
    label: "Swiss",
    blurb: "Round one is generated; later rounds pair off the table.",
  },
];

export function stageKindLabel(kind: StageKind | string): string {
  return STAGE_KIND_CHOICES.find((choice) => choice.value === kind)?.label ?? String(kind);
}

/* ------------------------------------------------------------------ */
/* Halves of a stage                                                  */
/* ------------------------------------------------------------------ */

/**
 * What a half of a bracket is called on screen.
 *
 * `upper` is "Upper bracket" only when there is a lower one to be upper *of* —
 * in a single elimination it is the whole bracket and calling it "upper" would
 * invite the question of where the other half went.
 */
export function bracketLabel(bracket: MatchBracket, hasLower: boolean): string {
  switch (bracket) {
    case "rr":
      return "Table";
    case "upper":
      return hasLower ? "Upper bracket" : "Bracket";
    case "lower":
      return "Lower bracket";
    case "bronze":
      return "Bronze";
    case "final":
      return "Grand final";
  }
}

/** The `bestOfByBracket` keys, in board order, with the words for each. */
export const BRACKET_HALVES: ReadonlyArray<{ key: MatchBracket; label: string }> = [
  { key: "rr", label: "Table games" },
  { key: "upper", label: "Upper bracket" },
  { key: "lower", label: "Lower bracket" },
  { key: "bronze", label: "Bronze match" },
  { key: "final", label: "Grand final" },
];

/* ------------------------------------------------------------------ */
/* Series and modes                                                   */
/* ------------------------------------------------------------------ */

export function seriesLabel(bestOf: number): string {
  return `Bo${bestOf}`;
}

/** `domination` → "Domination"; `payload_escort` → "Payload escort". */
export function modeLabel(mode: string): string {
  const words = mode.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed mode";
}

/** Every mode this stage actually plays, first appearance first. */
export function modesInUse(spec: GeneratedStage): string[] {
  const seen: string[] = [];
  for (const match of spec.matches) {
    for (const mode of match.modes) if (!seen.includes(mode)) seen.push(mode);
  }
  return seen;
}

/** Every series length this stage actually plays, shortest first. */
export function seriesLengthsInUse(spec: GeneratedStage): number[] {
  return [...new Set(spec.matches.map((match) => match.bestOf))].sort((a, b) => a - b);
}

/**
 * "Bo3 throughout", or "Bo3, grand final Bo5".
 *
 * The commonest length is the rule and everything else is named as the
 * exception, which is how §8.2 states it and how an organiser says it out loud.
 */
export function seriesSentence(spec: GeneratedStage): string {
  const counts = new Map<number, number>();
  for (const match of spec.matches) {
    counts.set(match.bestOf, (counts.get(match.bestOf) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  if (counts.size === 1) return `${seriesLabel([...counts.keys()][0])} throughout`;

  const base = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  const named = [
    ...new Set(
      spec.matches
        .filter((match) => match.bestOf !== base)
        .map((match) => `${match.roundLabel.toLowerCase()} ${seriesLabel(match.bestOf)}`)
    ),
  ];
  return [seriesLabel(base), ...named].join(", ");
}

/* ------------------------------------------------------------------ */
/* Bronze, tiebreakers                                                */
/* ------------------------------------------------------------------ */

export const BRONZE_CHOICES: ReadonlyArray<Choice<BronzeMode>> = [
  { value: "none", label: "No third place", blurb: "Nobody is named third." },
  {
    value: "lower_final",
    label: "Lower final doubles as bronze",
    blurb: "Third place costs no extra match. Double elimination only.",
  },
  {
    value: "separate",
    label: "A separate bronze match",
    blurb: "The two beaten semi-finalists play for it. Single elimination only.",
  },
];

/**
 * What `normaliseStageConfig` will actually store for this kind — it reads
 * `lower_final` as `separate` in a single elimination and the reverse in a
 * double one, so the screen says which one is going to happen rather than
 * letting the admin discover it in the preview.
 */
export function bronzeFor(kind: StageKind, chosen: BronzeMode): BronzeMode {
  if (chosen === "none") return "none";
  if (kind === "single_elim") return "separate";
  if (kind === "double_elim") return "lower_final";
  return "none";
}

export function bronzeLabel(mode: BronzeMode): string {
  return BRONZE_CHOICES.find((choice) => choice.value === mode)?.label ?? String(mode);
}

export const TIEBREAKER_LABELS: Record<Tiebreaker, string> = {
  mini_league: "Mini league between the level teams",
  head_to_head: "Head to head",
  wins: "Most wins",
  diff: "Score difference",
  score_for: "Score for",
  name: "Name (last word, always)",
};

export function tiebreakerLabel(rule: Tiebreaker | string): string {
  return TIEBREAKER_LABELS[rule as Tiebreaker] ?? String(rule);
}

/* ------------------------------------------------------------------ */
/* Match status                                                       */
/* ------------------------------------------------------------------ */

/** The status word, taking the drawn-series stall into account. */
export function matchStatusLabel(match: Pick<ResolvedMatch, "status" | "needsDecision">): string {
  if (match.needsDecision) return "Needs a winner";
  switch (match.status) {
    case "done":
      return "Played";
    case "live":
      return "In progress";
    case "void":
      return "Not needed";
    case "pending":
      return "Not played";
  }
}

/** The `StatusPill` status this match maps onto. */
export function matchStatusTone(
  match: Pick<ResolvedMatch, "status" | "needsDecision">
): "draft" | "open" | "closed" | "live" | "complete" | "cancelled" {
  if (match.needsDecision) return "open";
  const map: Record<MatchStatus, "draft" | "live" | "complete" | "cancelled"> = {
    pending: "draft",
    live: "live",
    done: "complete",
    void: "cancelled",
  };
  return map[match.status];
}

/* ------------------------------------------------------------------ */
/* Clocks                                                             */
/* ------------------------------------------------------------------ */

/** "2h 05m" — the schedule preview's units, carried over from the old board. */
export function hhmm(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}h ${String(safe % 60).padStart(2, "0")}m`;
}

/* ------------------------------------------------------------------ */
/* The plain-words summary (§6.2)                                     */
/* ------------------------------------------------------------------ */

/**
 * "8 teams · double elimination · Bo3, grand final Bo5 · lower final doubles as
 * bronze" — the format in the words §6.2 asks the overview tab to use.
 */
export function formatSentence(spec: GeneratedStage): string[] {
  const parts: string[] = [
    `${spec.teamCount} teams`,
    stageKindLabel(spec.kind).toLowerCase(),
  ];

  if (spec.kind === "group_playoff") {
    parts.push(
      `${spec.groups.length} groups, top ${advancePerGroup(spec)} through`,
      `${stageKindLabel(spec.config.playoffKind).toLowerCase()} playoff`
    );
  }
  if (spec.config.doubleRound && spec.matches.some((match) => match.bracket === "rr")) {
    parts.push("home and away");
  }
  if (spec.kind === "swiss") parts.push(`${spec.config.rounds} rounds`);

  const series = seriesSentence(spec);
  if (series) parts.push(series);

  if (spec.config.bronze === "lower_final") parts.push("lower final doubles as bronze");
  else if (spec.config.bronze === "separate") parts.push("separate bronze match");

  if (spec.resetSlot) parts.push("bracket reset on");

  return parts;
}

/**
 * How many actually go through per group — capped by the thinnest group, which
 * is a decision `generateStage` already made and this must not make again.
 */
export function advancePerGroup(spec: GeneratedStage): number {
  if (spec.groups.length === 0) return 0;
  const thinnest = Math.min(...spec.groups.map((group) => group.seeds.length));
  return Math.max(1, Math.min(spec.config.advancePerGroup, thinnest));
}
