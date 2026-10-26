import { type PlayerBook, playerName } from "@/components/draft";
import {
  EmptyState,
  Eyebrow,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  cx,
  plural,
} from "@/components/ui";
import type { RoundTable } from "@/lib/event-board";
import { roundName } from "@/lib/events-policy";
import type { RoundScoreRow } from "@/lib/round-scoring";

/**
 * The public Results tab of a night scored in rounds (R-234, R-235 / UC-46 4,
 * 3a): the finishing order, every round and every bonus beside the total.
 *
 * R-234's note is the whole design: *a total nobody can see the parts of is a
 * number to be argued with.* So nothing here is a total on its own. Each round
 * is its own column with the score as typed, the bonuses earned in that round
 * are printed under the score they were earned with, and the footnote says what
 * each bonus is worth and what a blank counts as — so the total at the end of
 * the row can be checked by hand from the row itself (R-235: a participant
 * finds their own rounds by finding their own line).
 *
 * ## What it does not do
 *
 * It adds nothing up. `rounds.ranks` is `rankRounds`' output, ordered by
 * `getEventBoard`, and the one place the table could have disagreed with the
 * podium above it is a sum it does not perform. A player with no score in any
 * round is not in `ranks` and so not in the table — decision 006 makes that
 * absence the only representation of "did not play", and the footnote says it
 * rather than listing them as last.
 *
 * ## A server component
 *
 * Nothing on it is an instant and nothing on it is interactive, so it has no
 * `"use client"`: the Next.js guide in `node_modules/next/dist/docs/01-app/01-
 * getting-started/05-server-and-client-components.md` reserves the directive
 * for state, handlers and browser APIs, and a table of numbers is none of them.
 * Unlike the match Results tab beside it, which is a client component only
 * because every time on it is one.
 *
 * ## 400px
 *
 * A round-scored night may have up to `MAX_ROUNDS` columns, so the table is
 * allowed to be wider than a phone and **scrolls horizontally inside its own
 * Panel** (`overflow-x-auto`), which is `StandingsTable`'s pattern and the one
 * `Page.tsx` names for anything wider than the page column. Structural, not
 * measured: no browser runs in this suite.
 */

/**
 * How to read the table, in the rules `rankRounds` applies (R-228, R-232) and
 * what each bonus is worth — the parts a reader needs to check a total by hand.
 */
function footnote(scoring: RoundTable["scoring"]): string {
  const sentences = [
    scoring.lowWins ? "Lowest total wins." : "Highest total wins.",
    `A total is every round added up${
      scoring.bonuses.length > 0 ? ", plus bonuses in the player's favour" : ""
    }.`,
    "A blank round counts as that round's worst recorded score, never as nothing.",
    "Players level on their total share a place, and the next place stays empty.",
    "A player with no score in any round is not placed.",
    ...scoring.bonuses.map(
      (bonus) =>
        `${bonus.key} is worth ${plural(bonus.value, "point")}${
          scoring.lowWins ? " off the total" : ""
        }.`
    ),
  ];
  return sentences.join(" ");
}

export type RoundsTabProps = {
  rounds: RoundTable;
  /** Who the rows name. */
  players: PlayerBook;
};

export default function RoundsTab({ rounds, players }: RoundsTabProps) {
  const { scoring, rows, ranks, scored } = rounds;

  if (ranks.length === 0) {
    return (
      <Panel as="section">
        <Eyebrow className="mb-4">Results</Eyebrow>
        <EmptyState>This night has not been scored yet.</EmptyState>
      </Panel>
    );
  }

  const count = scoring.rounds.length;
  // userId → roundIndex → the row, so a cell is one lookup.
  const byPlayer = new Map<string, Map<number, RoundScoreRow>>();
  for (const row of rows) {
    const own = byPlayer.get(row.userId) ?? new Map<number, RoundScoreRow>();
    own.set(row.roundIndex, row);
    byPlayer.set(row.userId, own);
  }

  return (
    <section className="space-y-6">
      <Panel padding="md">
        <Eyebrow>
          {plural(ranks.length, "player")} · {scored} of {plural(count, "round")} scored
        </Eyebrow>
      </Panel>

      <Panel padding="none" className="overflow-x-auto overflow-y-hidden">
        <Table className="min-w-max">
          <TableHead>
            <TableHeadCell />
            <TableHeadCell>Player</TableHeadCell>
            {scoring.rounds.map((round, index) => (
              <TableHeadCell key={index} align="right" className="whitespace-nowrap">
                {roundName(round, index)}
              </TableHeadCell>
            ))}
            <TableHeadCell align="right">Total</TableHeadCell>
          </TableHead>
          <TableBody>
            {ranks.map((rank) => (
              <TableRow key={rank.userId}>
                <TableCell numeric className="text-muted">
                  {rank.position}
                </TableCell>
                <TableCell className={cx("whitespace-nowrap", rank.position === 1 && "text-union")}>
                  {playerName(players, rank.userId)}
                </TableCell>
                {scoring.rounds.map((_, index) => {
                  const row = byPlayer.get(rank.userId)?.get(index + 1);
                  return (
                    <TableCell key={index} numeric align="right" className="whitespace-nowrap">
                      {row ? (
                        <>
                          {row.score}
                          {scoring.bonuses.map((bonus) =>
                            row.bonuses[bonus.key] ? (
                              <span key={bonus.key} className="block text-11 text-dim">
                                {`${bonus.key} ×${row.bonuses[bonus.key]}`}
                              </span>
                            ) : null
                          )}
                        </>
                      ) : (
                        // A blank, never a zero (R-228). What it counts as is in the footnote.
                        <span className="text-dim">—</span>
                      )}
                    </TableCell>
                  );
                })}
                <TableCell numeric align="right" className="text-union">
                  {rank.total}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <p className="text-12 leading-relaxed text-muted">{footnote(scoring)}</p>
    </section>
  );
}
