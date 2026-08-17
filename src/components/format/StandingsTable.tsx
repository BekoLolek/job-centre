import {
  EmptyState,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  cx,
} from "@/components/ui";
import type { Standing } from "@/lib/format-resolve";

/**
 * A stage's table, in the columns the old board uses.
 *
 * The order is `format-resolve`'s — points, then the stage's configured
 * tiebreakers — and nothing here re-sorts it. `qualify` only draws a line:
 * whether a row is above it was settled by the same sort.
 */

export type StandingsTableProps = {
  rows: Standing[];
  /** Rule under this many rows — the group's qualification line. */
  qualify?: number | null;
  /** Include the maps-won pair. Off for a Bo1 table, where it duplicates W/L. */
  showGames?: boolean;
  className?: string;
};

export default function StandingsTable({
  rows,
  qualify,
  showGames,
  className,
}: StandingsTableProps) {
  if (rows.length === 0) {
    return <EmptyState>No teams in this table yet.</EmptyState>;
  }

  return (
    <Panel padding="none" className={cx("overflow-x-auto", className)}>
      <Table className="min-w-[520px]">
        <TableHead>
          <TableHeadCell />
          <TableHeadCell>Team</TableHeadCell>
          <TableHeadCell align="right">P</TableHeadCell>
          <TableHeadCell align="right">W</TableHeadCell>
          <TableHeadCell align="right">D</TableHeadCell>
          <TableHeadCell align="right">L</TableHeadCell>
          {showGames && <TableHeadCell align="right">Maps</TableHeadCell>}
          <TableHeadCell align="right">Diff</TableHeadCell>
          <TableHeadCell align="right">Pts</TableHeadCell>
        </TableHead>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow
              key={row.id}
              className={cx(
                qualify != null && index + 1 === qualify && "border-b-2 border-gold/40"
              )}
            >
              <TableCell numeric className="text-muted">
                {index + 1}
              </TableCell>
              <TableCell className={qualify != null && index < qualify ? "text-gold" : undefined}>
                {row.name}
              </TableCell>
              <TableCell numeric align="right" className="text-muted">
                {row.played}
              </TableCell>
              <TableCell numeric align="right">
                {row.won}
              </TableCell>
              <TableCell numeric align="right">
                {row.drawn}
              </TableCell>
              <TableCell numeric align="right">
                {row.lost}
              </TableCell>
              {showGames && (
                <TableCell numeric align="right" className="text-muted">
                  {row.gamesWon}–{row.gamesLost}
                </TableCell>
              )}
              <TableCell numeric align="right" className="text-muted">
                {row.diff > 0 ? `+${row.diff}` : row.diff}
              </TableCell>
              <TableCell numeric align="right" className="text-gold">
                {row.points}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
