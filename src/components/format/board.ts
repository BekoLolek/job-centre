/**
 * What a board *narrates* — the third of this folder's pure modules.
 *
 * `labels.ts` answers "what is this called"; `columns.ts` answers "which column
 * does it go in"; this answers the questions left over once a stage has been
 * laid out — what is on next, who finished where, which of the two numbers on a
 * card is the score, and which day of the *reader's* week a match falls on.
 *
 * Like its two neighbours it is pure and has no database import, so a client
 * component can call it and the node-environment suite can test it.
 *
 * Three behaviours are carried over from the legacy public board deliberately,
 * because they were right there and are right here:
 *
 *  1. A **Bo1 shows its map score**, a longer series shows **maps won**. Two
 *     different numbers, and printing the wrong one makes a 2–1 series read 0–0.
 *  2. **Up next is live matches first, then pending in board order** — never
 *     sorted by start time, because a later match that happens to have been
 *     given one must not jump ahead of an earlier one that has not.
 *  3. A **drawn elimination series is flagged**, not left blank: the resolver
 *     refuses to advance it, so the board has to say why nothing moved.
 */

import { ordinal } from "@/lib/format-policy";
import type { ResolvedMatch, Standing } from "@/lib/format-resolve";
import { matchStatusLabel, modeLabel } from "./labels";

/* ------------------------------------------------------------------ */
/* Series arithmetic, for display                                     */
/* ------------------------------------------------------------------ */

/**
 * The pair of numbers to print between two team names.
 *
 * A Bo1 has no series score worth showing — "1–0" says less than the map score
 * does — so a single game reports its own scoreline and anything longer reports
 * maps won.
 */
export function seriesScore(
  match: Pick<ResolvedMatch, "bestOf" | "games" | "gamesWonA" | "gamesWonB">
): { a: number; b: number } {
  if (match.bestOf === 1) {
    const game = match.games[0];
    return { a: game?.played ? game.scoreA : 0, b: game?.played ? game.scoreB : 0 };
  }
  return { a: match.gamesWonA, b: match.gamesWonB };
}

/** Only the games actually ticked off. A typed-in score never ticked counts for nothing. */
export function playedGames(match: Pick<ResolvedMatch, "games">) {
  return match.games.filter((game) => game.played);
}

/** Every referee named across the series, in order, without repeats. */
export function refereesOf(match: Pick<ResolvedMatch, "games">): string[] {
  const out: string[] = [];
  for (const game of match.games) {
    const name = game.referee?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Has anything at all happened in this match? */
export function matchHasResult(match: Pick<ResolvedMatch, "games" | "status">): boolean {
  return match.status === "done" || match.games.some((game) => game.played);
}

/** "Convoy · Midtown" — what one game of a series was played on. */
export function gameLine(game: { mode: string; map: string }): string {
  const map = game.map.trim();
  const mode = game.mode.trim() ? modeLabel(game.mode) : "";
  if (map && mode) return `${mode} · ${map}`;
  return map || mode || "";
}

/* ------------------------------------------------------------------ */
/* Tone                                                               */
/* ------------------------------------------------------------------ */

/**
 * How a card should read at a glance.
 *
 * `decision` is its own tone rather than a flavour of `done`: every game is in
 * and nobody won, so nothing downstream of it resolves until an admin says who
 * advances. That is the one state a reader must not mistake for "over".
 */
export type MatchTone = "pending" | "live" | "done" | "void" | "decision";

export function matchTone(match: Pick<ResolvedMatch, "status" | "needsDecision">): MatchTone {
  if (match.needsDecision) return "decision";
  return match.status;
}

/**
 * The line a card prints about its own state, or null when there is nothing
 * worth saying — "Not played" on a card that is obviously not played is noise.
 */
export function matchToneNote(
  match: Pick<ResolvedMatch, "status" | "needsDecision">
): string | null {
  const tone = matchTone(match);
  if (tone === "pending" || tone === "done") return null;
  return matchStatusLabel(match);
}

const TONE_TEXT: Record<MatchTone, string> = {
  pending: "text-muted",
  done: "text-muted",
  live: "text-ember",
  decision: "text-ember",
  void: "text-muted/70",
};

export function matchToneClass(tone: MatchTone): string {
  return TONE_TEXT[tone];
}

/** Does this stage have anything a bracket canvas would draw? */
export function hasBracketShape(matches: ResolvedMatch[]): boolean {
  return matches.some((match) => match.bracket !== "rr");
}

/* ------------------------------------------------------------------ */
/* Up next                                                            */
/* ------------------------------------------------------------------ */

/**
 * What is about to happen: anything stalled on a decision, then anything live,
 * then pending in board order.
 *
 * Deliberately *not* sorted by start time — the matches arrive in play order
 * already, and the legacy board learned the hard way that a later match with a
 * time set must not float above an earlier one without one.
 */
export function upNext(matches: ResolvedMatch[], limit = 3): ResolvedMatch[] {
  const seen = new Set<string>();
  const out: ResolvedMatch[] = [];
  const take = (list: ResolvedMatch[]) => {
    for (const match of list) {
      if (seen.has(match.slot)) continue;
      seen.add(match.slot);
      out.push(match);
    }
  };
  take(matches.filter((match) => match.needsDecision));
  take(matches.filter((match) => match.status === "live"));
  take(matches.filter((match) => match.status === "pending"));
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Podium                                                             */
/* ------------------------------------------------------------------ */

export type Placement = { position: number; shared: number; teamId: string };

export type PodiumEntry = Placement & { label: string };

const PODIUM_LABEL: Record<number, string> = {
  1: "Champion",
  2: "Runner-up",
  3: "Bronze",
};

/**
 * The finishing order, best first, with the top three named in words.
 *
 * A block of shared positions is labelled as the range it actually is —
 * "5th–6th" — because two teams knocked out in the same round did not finish
 * fifth and sixth, they finished joint fifth. That is the same distinction
 * `PlacementRule.shared` carries, printed.
 */
export function podiumEntries(placements: Placement[], limit = 4): PodiumEntry[] {
  return [...placements]
    .sort((x, y) => x.position - y.position)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      label:
        PODIUM_LABEL[entry.position] ??
        (entry.shared > 1
          ? `${ordinal(entry.position)}–${ordinal(entry.position + entry.shared - 1)}`
          : ordinal(entry.position)),
    }));
}

/** The champion, once there is one. */
export function championOf(placements: Placement[]): string | null {
  return placements.find((entry) => entry.position === 1)?.teamId ?? null;
}

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every match with something to show, oldest first.
 *
 * Ordered by when it actually finished, falling back to when it was meant to
 * start and then to board order — a results log is a history, so it reads
 * forwards even when half of it was recorded out of sequence.
 */
export function resultsLog(matches: ResolvedMatch[]): ResolvedMatch[] {
  return matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => matchHasResult(match))
    .sort((x, y) => {
      const xs = x.match.finishedAt ?? x.match.scheduledAt;
      const ys = y.match.finishedAt ?? y.match.scheduledAt;
      if (xs && ys && xs !== ys) return xs < ys ? -1 : 1;
      if (xs && !ys) return -1;
      if (ys && !xs) return 1;
      return x.index - y.index;
    })
    .map(({ match }) => match);
}

/** How many games have been played across a set of matches. */
export function gamesPlayed(matches: ResolvedMatch[]): number {
  return matches.reduce((total, match) => total + playedGames(match).length, 0);
}

/* ------------------------------------------------------------------ */
/* The schedule, day by day                                           */
/* ------------------------------------------------------------------ */

export type ScheduleDay = {
  /** The organiser's day, 1-based — "Day 2" of a four-day event. */
  day: number;
  /** The earliest instant in it, for a client component to print the date. */
  startsAt: string | null;
  matches: ResolvedMatch[];
};

/**
 * Split a running order into the organiser's days.
 *
 * **Why not the reader's calendar day.** That was the obvious answer and it is
 * wrong twice over. It is wrong for the reader, because a Saturday evening that
 * overruns past midnight is still Saturday's session to everybody playing it,
 * and splitting it in two at 00:00 fragments one evening into two headings. And
 * it is wrong for the page, because the split would then differ between the
 * server's zone and the browser's — a *structural* hydration mismatch, which no
 * amount of `suppressHydrationWarning` can paper over, unlike a text one.
 *
 * So the day comes from the block plan (`format-schedule`'s `PlannedBlock.day`,
 * via `columns.ts`'s `dayBySlot`), which is the organiser's own answer and the
 * same one on both sides of the wire. Every *time* on the page is still printed
 * in the reader's zone — that part is a text substitution and is safe.
 *
 * Matches with no time at all come back separately rather than being dropped,
 * so the page can say "not scheduled yet" out loud.
 */
export function groupByDay(
  matches: ResolvedMatch[],
  /** `dayBySlot`'s Map, or the plain object a client component is handed. */
  dayOf: ReadonlyMap<string, number> | Readonly<Record<string, number | undefined>>
): { days: ScheduleDay[]; undated: ResolvedMatch[] } {
  // A slot the plan does not mention falls into day 1 rather than a day of its
  // own: it is a match somebody added by hand, and one unexplained heading is
  // worse than one extra row.
  const asMap = dayOf as ReadonlyMap<string, number>;
  const asRecord = dayOf as Readonly<Record<string, number | undefined>>;
  const lookup = (slot: string): number =>
    (typeof asMap.get === "function" ? asMap.get(slot) : asRecord[slot]) ?? 1;

  const byDay = new Map<number, ScheduleDay>();
  const undated: ResolvedMatch[] = [];

  for (const match of matches) {
    if (!match.scheduledAt || Number.isNaN(Date.parse(match.scheduledAt))) {
      undated.push(match);
      continue;
    }
    const number = lookup(match.slot);
    const day = byDay.get(number);
    if (day) {
      day.matches.push(match);
      if (!day.startsAt || match.scheduledAt < day.startsAt) day.startsAt = match.scheduledAt;
    } else {
      byDay.set(number, { day: number, startsAt: match.scheduledAt, matches: [match] });
    }
  }

  const days = [...byDay.values()].sort((x, y) => x.day - y.day);
  for (const day of days) {
    // Within a day the clock wins; ties keep board order, which is what puts
    // two matches sharing a lobby slot in bracket order rather than at random.
    day.matches = day.matches
      .map((match, index) => ({ match, index }))
      .sort(
        (x, y) =>
          (x.match.scheduledAt as string).localeCompare(y.match.scheduledAt as string) ||
          x.index - y.index
      )
      .map(({ match }) => match);
  }

  return { days, undated };
}

/* ------------------------------------------------------------------ */
/* Standings                                                          */
/* ------------------------------------------------------------------ */

/** Has anybody played anything in this table yet? */
export function tableStarted(rows: Standing[]): boolean {
  return rows.some((row) => row.played > 0);
}
