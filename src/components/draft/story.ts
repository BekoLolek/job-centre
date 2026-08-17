/**
 * The sentences the draft room says about lots.
 *
 * Every one of these is a *description of something that already happened*, or
 * of something a button is about to do. None of them decides anything: the
 * statuses come from `draft_lots`, the prices come from the row, and the
 * money is formatted by `./money`. A screen that has to explain an undo before
 * somebody presses it needs the wording in one place, tested, rather than
 * inlined three times in a client component where nothing can check it.
 *
 * ## Why the undo sentence is here and not next to the button
 *
 * `voidLastLot` picks the newest **non-voided** lot by `openedAt`, and an open
 * lot qualifies — so pressing Undo while somebody is on the block cancels that
 * lot rather than reversing the last award. That is a genuine surprise, and the
 * only defence against it is for the button to say which of the two it is going
 * to do. Working that out is a small piece of logic over the view, so it is a
 * function with tests rather than a ternary in JSX.
 */

import type { DraftPoolKind } from "@/db/schema";
import type { DraftView, SettledLot } from "@/lib/draft-policy";
import { POOL_KINDS } from "./labels";
import { formatMoney } from "./money";
import type { PlayerBook } from "./types";
import { playerName } from "./types";

/** Just enough of a team to name it. Every team shape on the site satisfies this. */
export type NamedTeam = { id: string; name: string };

export type LotContext = {
  players: PlayerBook;
  teams: readonly NamedTeam[];
};

/** A team's name, or something honest when the id names nothing we hold. */
export function teamNameFor(
  teams: readonly NamedTeam[],
  teamId: string | null | undefined,
  fallback = "an unknown team"
): string {
  if (!teamId) return fallback;
  return teams.find((team) => team.id === teamId)?.name ?? fallback;
}

const POOL_WORD: Record<DraftPoolKind, string> = {
  main: "main pool",
  reserve: "reserve pool",
};

export type LotTone = "gold" | "muted" | "ember";

export type LotLine = {
  player: string;
  /** What became of them, as it reads in a list. */
  outcome: string;
  tone: LotTone;
  /** Present only on an award, so the list can set it in the money face. */
  price: number | null;
};

/**
 * One settled lot, as a row in the ticker.
 *
 * A voided lot keeps its winner and its price in the database — that is the
 * whole point of not deleting it — so the row says it was undone rather than
 * repeating a price nobody paid. Showing "→ Rivals Red · 250" struck through
 * would be worse: at a glance it still reads as a sale.
 */
export function lotLine(lot: SettledLot, ctx: LotContext): LotLine {
  const player = playerName(ctx.players, lot.playerUserId);

  switch (lot.status) {
    case "awarded":
      return {
        player,
        outcome: `→ ${teamNameFor(ctx.teams, lot.winnerTeamId)}`,
        tone: "gold",
        price: lot.price ?? 0,
      };
    case "reserved":
      return { player, outcome: "→ held over", tone: "muted", price: null };
    case "discarded":
      return { player, outcome: "→ taken off the list", tone: "muted", price: null };
    case "voided":
      return { player, outcome: "→ undone", tone: "ember", price: null };
    default:
      return { player, outcome: "→ on the block", tone: "muted", price: null };
  }
}

/** The same lot as a sentence, for the line under the wheel between spins. */
export function lotSentence(lot: SettledLot, ctx: LotContext): string {
  const player = playerName(ctx.players, lot.playerUserId);

  switch (lot.status) {
    case "awarded":
      return `${player} went to ${teamNameFor(ctx.teams, lot.winnerTeamId)} for ${formatMoney(
        lot.price ?? 0
      )}.`;
    case "reserved":
      return `${player} was held over for the ${POOL_WORD.reserve}.`;
    case "discarded":
      return `${player} was taken off the list.`;
    case "voided":
      return `${player}'s lot was undone.`;
    default:
      return `${player} is on the block.`;
  }
}

/**
 * The newest lot an undo would touch — the same one `voidLastLot` picks.
 *
 * `history` arrives newest first by `openedAt`, which is the order
 * `voidLastLot` sorts by, so the first non-voided entry is its answer. An open
 * lot beats all of them, because it is newer than anything settled and it is
 * not voided either.
 */
export function undoTarget(view: {
  lot: { id: string } | null;
  history: readonly SettledLot[];
}): { kind: "open"; id: string } | { kind: "settled"; lot: SettledLot } | null {
  if (view.lot) return { kind: "open", id: view.lot.id };
  const settled = view.history.find((lot) => lot.status !== "voided");
  return settled ? { kind: "settled", lot: settled } : null;
}

export type UndoPlan = {
  /** False when there is nothing to undo — the button is off. */
  available: boolean;
  /** What pressing it does, in one sentence. Always safe to render. */
  sentence: string;
  /** The word on the button, because cancelling a live lot is not "undo". */
  label: string;
};

/**
 * What the undo button will actually do, said out loud.
 *
 * §11 gives the admin the button; nothing says the room has to make them guess
 * which lot it lands on. The wording distinguishes the two cases that behave
 * differently — cancelling the lot in front of everyone moves no money, whereas
 * reversing an award gives a balance back — because those are the two mistakes
 * an admin makes under pressure and they are not recoverable in the same way.
 */
export function undoPlan(
  view: Pick<DraftView, "lot" | "history">,
  players: PlayerBook,
  teams: readonly NamedTeam[]
): UndoPlan {
  const target = undoTarget(view);

  if (!target) {
    return {
      available: false,
      sentence: "Nothing has been drafted yet, so there is nothing to undo.",
      label: "Undo",
    };
  }

  if (target.kind === "open") {
    const named = view.lot?.playerUserId
      ? playerName(players, view.lot.playerUserId)
      : null;
    return {
      available: true,
      label: "Cancel this lot",
      sentence: named
        ? `Undo cancels the lot on ${named} and puts them back on the wheel. No money moves.`
        : "Undo cancels the lot that is being spun for. No money moves.",
    };
  }

  const lot = target.lot;
  const player = playerName(players, lot.playerUserId);
  const back = POOL_WORD[lot.fromKind];

  switch (lot.status) {
    case "awarded":
      return {
        available: true,
        label: "Undo the last lot",
        sentence:
          `Undo takes ${player} off ${teamNameFor(teams, lot.winnerTeamId)}, gives back ` +
          `${formatMoney(lot.price ?? 0)} and returns them to the ${back}.`,
      };
    case "reserved":
      return {
        available: true,
        label: "Undo the last lot",
        sentence: `Undo brings ${player} back out of the reserve pool into the ${back}.`,
      };
    case "discarded":
      return {
        available: true,
        label: "Undo the last lot",
        sentence: `Undo puts ${player} back into the ${back}.`,
      };
    default:
      return {
        available: true,
        label: "Undo the last lot",
        sentence: `Undo reverses the last lot — ${player}.`,
      };
  }
}

/**
 * Where the draft has got to, for the banner across the top.
 *
 * `draftComplete` reports *why* it is over, and the two reasons need different
 * sentences: every roster full is the end of a job well done, an empty pool
 * with teams still short is a problem somebody has to deal with tonight.
 */
export function completionSentence(
  view: Pick<DraftView, "completion" | "teams">
): string | null {
  const { completion } = view;
  if (!completion.complete) return null;

  const short = completion.short
    .map((entry) => {
      const team = view.teams.find((row) => row.id === entry.teamId);
      return `${team?.name ?? "A team"} (${entry.slotsLeft} short)`;
    })
    .join(", ");

  switch (completion.reason) {
    case "rosters_full":
      return "Every roster is full. The draft is done.";
    case "both":
      return "Every roster is full and the pool is empty. The draft is done.";
    case "pool_empty":
      return short
        ? `The pool is empty and there are still slots to fill: ${short}.`
        : "The pool is empty.";
    default:
      return null;
  }
}

/** The wheel's own status word, for the eyebrow above it. */
export function stageLabel(phase: DraftView["phase"], hasLot: boolean): string {
  if (phase === "spinning") return "Spinning";
  if (phase === "bidding" && hasLot) return "Bidding open";
  return "Standby";
}

/** `POOL_KINDS` in a sentence-shaped place, so the room never retypes it. */
export function poolLabel(kind: DraftPoolKind): string {
  return POOL_KINDS[kind];
}
