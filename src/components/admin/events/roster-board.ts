// A type only, as in `TeamsTab`: the action module is a server file.
import type { RosterMove } from "@/app/admin/events/draft-actions";

/**
 * The rules a card follows on the Rosters board — R-257, R-260 / UC-53
 * (Task 121).
 *
 * ## Why this is its own module
 *
 * `placement-order.ts`'s reason, one file over: the suite has no DOM to drop a
 * card in, so what a drop means is decided here over plain data and the tab's
 * handlers do what these say. A "Move to" select, the Off button and a drop
 * all ask `moveFor` the same question, which is what keeps the gesture an
 * addition to the selects rather than a second write path.
 *
 * ## Two things, and a move writes to only one of them
 *
 * `rosters` is written only from a server answer — for a move, the rows
 * `placeOnRosterAction` and `removeFromRosterAction` hand back. `pending` is
 * the moves that have been asked for and not yet answered. The board the
 * screen draws is the first with the second laid over it (`boardOf`), and it
 * is worked out, never stored.
 *
 * That is the whole of the optimism. A card is on its new team the moment its
 * move joins `pending`; an answer adopts the server's rosters and drops the
 * move; a refusal only drops the move — and the card is back exactly where it
 * was, because the row it came from was never touched. There is no undo to get
 * wrong.
 */

/** One write asked for and not yet answered. `teamId` is the team the action is aimed at. */
export type BoardMove =
  | { kind: "place"; userId: string; teamId: string }
  /** `teamId` is the team they are leaving, which `removeFromRoster` checks against the row. */
  | { kind: "remove"; userId: string; teamId: string };

/**
 * The write a card let go on `to` asks for — a team's id, or `null` for the
 * unplaced list — or `null` when it asks for none:
 *
 *  - **One of theirs is already in flight.** The first move stands until the
 *    server has answered it; a second is not queued behind it, because it
 *    would be a decision taken against a board that has not settled.
 *  - **It was let go where it started** (UC-53 3b). Nothing to write.
 *  - **The team is not open to them.** `open` is `teamsOpenTo`'s answer, so a
 *    full team is not a place a card can be put. The server refuses it too,
 *    in its own words, when this screen is older than the roster.
 */
export function moveFor(
  board: { rosters: readonly RosterMove[]; pending: readonly BoardMove[] },
  userId: string,
  to: string | null,
  open: readonly string[]
): BoardMove | null {
  if (board.pending.some((move) => move.userId === userId)) return null;

  // Nothing of theirs is in flight, so the saved rosters are where they are.
  const from = board.rosters.find((row) => row.userId === userId)?.teamId ?? null;
  if (to === null) return from === null ? null : { kind: "remove", userId, teamId: from };
  if (to === from) return null;
  return open.includes(to) ? { kind: "place", userId, teamId: to } : null;
}

/**
 * The rosters as the screen draws them: what is saved, with every move still
 * in flight already made.
 *
 * A placed card that had no row gets the row `placeOnRoster` writes — no price,
 * not a captain — at the end, where the server's answer will put it. One that
 * had a row keeps it, position and price, on its new team. Laying a move over
 * rosters that already carry it changes nothing, which matters when one
 * player's answer lands while another's is still out.
 */
export function boardOf(
  rosters: readonly RosterMove[],
  pending: readonly BoardMove[]
): RosterMove[] {
  return pending.reduce<RosterMove[]>((board, move) => {
    if (move.kind === "remove") return board.filter((row) => row.userId !== move.userId);
    if (!board.some((row) => row.userId === move.userId)) {
      return [...board, { teamId: move.teamId, userId: move.userId, price: 0, isCaptain: false }];
    }
    return board.map((row) =>
      row.userId === move.userId ? { ...row, teamId: move.teamId } : row
    );
  }, [...rosters]);
}
