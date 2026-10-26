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
} from "@/components/ui";
import { type PlayerBook, playerName } from "@/components/draft";
import { type RoundScoring, roundName, roundScoringSummary } from "@/lib/events-policy";
import { type RoundScoreRow, rankRounds } from "@/lib/round-scoring";

/**
 * The night's table — the finishing order with every scored round and every
 * bonus beside the total (R-231, R-234, R-235 / UC-46 3, 3a, 4a).
 *
 * ## The parts, not just the total
 *
 * R-234's note is the whole brief: "a total nobody can see the parts of is a
 * number to be argued with". So this is one column per round that has a score
 * in it and one per bonus, and the total at the end is visibly the sum of the
 * row — with the one exception R-228 forces said out loud under the table: a
 * blank round counts as that round's worst recorded score, so a row with a dash
 * in it adds up to more than it shows. The footnote is drawn only when some
 * placed player has such a dash, because an explanation of a thing that is not
 * on the screen is noise.
 *
 * Rounds nobody has scored get no column. They contribute nothing to anybody's
 * total (`rankRounds`'s rule), so they are not a part of it, and six empty
 * columns on a phone would push the total off the screen for nothing. The
 * sentence above the table says how many rounds it covers instead (UC-46 3a).
 *
 * ## The order is chosen, not inherited
 *
 * `listRoundScores` orders a round's rows by their uuid, which is random, and
 * `rankRounds` keeps tied players in the order their rows arrived — so a table
 * that drew the ranking as handed back would swap two tied players between one
 * render and the next. {@link nightTable} breaks every tie by name and nothing
 * else, so the same rows draw the same table whatever order they came in.
 *
 * ## Who is on it
 *
 * Everyone `rankRounds` placed, which is everyone with a score in some round
 * (seat or no seat — a recorded player who has since withdrawn is still in the
 * total), then everyone holding a seat with no row anywhere, last and by name,
 * marked as not scored. Task 86 keeps them out of the *ranking* because playing
 * nothing is not a finishing place; the *manager* still needs to see that they
 * exist, or a player who was never typed in looks like a player who was never
 * there. Decision 006's rule that the season pays them taking-part points is
 * unchanged by their appearing here — this is a screen, not an input.
 *
 * ## 400px
 *
 * A column per round and per bonus is the widest thing on this site, so the
 * table is `whitespace-nowrap` inside the `overflow-x-auto` panel
 * `StandingsTable` uses: it scrolls sideways within its own box rather than
 * widening the page. Structural, not measured — there is no browser in the
 * suite.
 *
 * No `"use client"`: it holds no state, and `ResultsTab` is the client boundary
 * that renders it, which puts it in the client bundle anyway
 * (`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`,
 * "Using Client Components").
 */

/** One row of the table, as {@link nightTable} orders them. */
export type TableLine = {
  userId: string;
  name: string;
  /** 1-based, shared on a tie — or null for a seated player with no row anywhere. */
  position: number | null;
  total: number | null;
  /** The player's row in each round they played, by round index. */
  byRound: ReadonlyMap<number, RoundScoreRow>;
  /** How many times each bonus was earned, across every round, by key. */
  bonuses: ReadonlyMap<string, number>;
};

/**
 * The table's rows in display order, and which rounds it covers.
 *
 * Pure, so the one decision this screen owns — the order — is asserted
 * directly over plain data rather than read back out of markup. Rows arriving
 * in any order produce the same answer: placed players by position, a shared
 * place broken by name, then the unplaced by name.
 */
export function nightTable(
  scoring: RoundScoring,
  rows: readonly RoundScoreRow[],
  seated: readonly string[],
  nameOf: (userId: string) => string
): { rounds: number[]; lines: TableLine[] } {
  const rounds = [...new Set(rows.map((row) => row.roundIndex))].sort((x, y) => x - y);

  const byPlayer = new Map<string, { byRound: Map<number, RoundScoreRow>; bonuses: Map<string, number> }>();
  for (const row of rows) {
    const own = byPlayer.get(row.userId) ?? { byRound: new Map(), bonuses: new Map() };
    own.byRound.set(row.roundIndex, row);
    for (const [key, count] of Object.entries(row.bonuses)) {
      own.bonuses.set(key, (own.bonuses.get(key) ?? 0) + count);
    }
    byPlayer.set(row.userId, own);
  }

  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);

  const placed: TableLine[] = rankRounds(scoring, rows)
    .map((rank) => ({
      userId: rank.userId,
      name: nameOf(rank.userId),
      position: rank.position,
      total: rank.total,
      ...byPlayer.get(rank.userId)!,
    }))
    .sort((x, y) => x.position! - y.position! || byName(x, y));

  const unplaced: TableLine[] = seated
    .filter((userId) => !byPlayer.has(userId))
    .map((userId) => ({
      userId,
      name: nameOf(userId),
      position: null,
      total: null,
      byRound: new Map<number, RoundScoreRow>(),
      bonuses: new Map<string, number>(),
    }))
    .sort(byName);

  return { rounds, lines: [...placed, ...unplaced] };
}

const DASH = "—";

/** How many of the setup's rounds the table has a score in, said as a sentence. */
function coverage(scoring: RoundScoring, rounds: readonly number[]): string {
  const count = scoring.rounds.length;
  const scored = rounds.filter((round) => round >= 1 && round <= count).length;
  if (scored < count) return `Covers ${scored} of ${count} rounds so far — the order as it stands.`;
  return count === 1 ? "Covers the night's only round." : `Covers all ${count} rounds.`;
}

export default function RoundTable({
  scoring,
  rows,
  players,
  seated,
}: {
  /** As stored, and not null here — the tab draws nothing for a night not scored in rounds. */
  scoring: RoundScoring;
  /** Every recorded score for the event, from `listRoundScores`, in no particular order. */
  rows: readonly RoundScoreRow[];
  players: PlayerBook;
  /** The accepted applicants' user ids — who is a player whether or not they are scored. */
  seated: readonly string[];
}) {
  const nameOf = (userId: string) => playerName(players, userId, "A former member");
  const { rounds, lines } = nightTable(scoring, rows, seated, nameOf);
  const sign = scoring.lowWins ? "−" : "+";
  const blanks = lines.some(
    (line) => line.position !== null && rounds.some((round) => !line.byRound.has(round))
  );

  return (
    <Panel
      as="section"
      padding="none"
      className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0"
    >
      <Eyebrow>Table</Eyebrow>

      {rows.length === 0 ? (
        <EmptyState>
          Nothing is scored yet. Save a round above and the table appears here — every round
          and every bonus beside the total.
        </EmptyState>
      ) : (
        <>
          <p className="max-w-[62ch] text-13 leading-relaxed text-muted">
            {`${coverage(scoring, rounds)} ${roundScoringSummary(scoring)}.`}
          </p>

          <Panel padding="none" className="overflow-x-auto overflow-y-hidden">
            <Table className="whitespace-nowrap">
              <TableHead>
                <TableHeadCell />
                <TableHeadCell>Player</TableHeadCell>
                {rounds.map((round) => (
                  <TableHeadCell key={round} align="right">
                    {roundName(scoring.rounds[round - 1], round - 1)}
                  </TableHeadCell>
                ))}
                {scoring.bonuses.map((bonus) => (
                  <TableHeadCell key={bonus.key} align="right">
                    {`${bonus.key} ${sign}${bonus.value}`}
                  </TableHeadCell>
                ))}
                <TableHeadCell align="right">Total</TableHeadCell>
              </TableHead>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.userId}>
                    <TableCell numeric className="text-muted">
                      {line.position ?? DASH}
                    </TableCell>
                    <TableCell>
                      {line.name}
                      {line.position === null && (
                        <span className="block text-11 text-dim">Not scored in any round</span>
                      )}
                    </TableCell>
                    {rounds.map((round) => (
                      <TableCell key={round} numeric align="right">
                        {line.byRound.get(round)?.score ?? DASH}
                      </TableCell>
                    ))}
                    {scoring.bonuses.map((bonus) => {
                      const times = line.bonuses.get(bonus.key);
                      return (
                        <TableCell key={bonus.key} numeric align="right" className="text-muted">
                          {times ? `×${times}` : DASH}
                        </TableCell>
                      );
                    })}
                    <TableCell numeric align="right" className="text-union">
                      {line.total ?? DASH}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          {blanks && (
            <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
              A dash is a round the player did not play. It counts as the worst score anybody
              recorded in that round, so a total can differ from the row&apos;s visible sum.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
