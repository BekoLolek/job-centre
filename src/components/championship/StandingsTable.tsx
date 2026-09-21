"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import {
  Avatar,
  Badge,
  Chevron,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  cx,
} from "@/components/ui";
import type { SeasonPlayer } from "@/lib/championship-season";
import { ordinal } from "@/lib/format-policy";

/**
 * The season's standings, and where any one player's points came from
 * (UC-34 2, 2b, 2c, 2d, 3-4).
 *
 * A row is a button: pressing it opens that player's season underneath, event
 * by event and game by game. That is UC-34 3-4, and it is a fold rather than a
 * second page because the question it answers — "how is *she* ahead of me?" —
 * is asked while looking at the table, and an answer that takes the table away
 * to give it is an answer you have to remember your way back from.
 *
 * The only client component on the page, and it holds one piece of state: which
 * row is open. Everything it renders was computed on the server; nothing here
 * decides a rule, and in particular nothing here sorts — the order is
 * `scoreChampionship`'s, and a second opinion about it on the client is exactly
 * how a table starts disagreeing with the page it is on.
 */

/** What the table needs to know about an event, to name a line in the breakdown. */
export type StandingsEvent = {
  eventId: string;
  slug: string;
  title: string;
  gameName: string | null;
  weight: number;
  /** True when the night scored off its own points table (R-177), not the season's. */
  ownTable: boolean;
};

export type StandingsTableProps = {
  rows: SeasonPlayer[];
  /** The counted events, in the order they were played, keyed by id. */
  events: StandingsEvent[];
  /** The signed-in reader, so their own row can be marked (UC-34 2b). */
  viewerId: string | null;
  /**
   * Whether to draw the movement column. False before a second event has
   * counted, when every `moved` is null and a column of dashes would be a
   * column of nothing.
   */
  showMovement: boolean;
  /** Set when only the best N results count, so the table can say so. */
  countBest: number | null;
};

export default function StandingsTable({
  rows,
  events,
  viewerId,
  showMovement,
  countBest,
}: StandingsTableProps) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(events.map((event) => [event.eventId, event]));

  /*
   * The header, as a list, so that `colSpan` on the breakdown row below is a
   * count of it rather than a number kept in step with it by hand. The hand-kept
   * version was already one column behind the day anybody added a seventh
   * thing to say about a player.
   */
  const columns = [
    <TableHeadCell key="position" className="w-12">
      #
    </TableHeadCell>,
    <TableHeadCell key="player">Player</TableHeadCell>,
    ...(showMovement
      ? [
          <TableHeadCell key="moved" align="center" className="w-16">
            Moved
          </TableHeadCell>,
        ]
      : []),
    <TableHeadCell key="points" align="right" className="w-20">
      Points
    </TableHeadCell>,
  ];

  return (
    <Table>
      <TableHead>{columns}</TableHead>

      <TableBody>
        {rows.map((row) => {
          const mine = viewerId !== null && row.userId === viewerId;
          const shown = open === row.userId;
          const panelId = `season-${row.userId}`;

          return (
            <Fragment key={row.userId}>
              <TableRow className={cx(mine && "bg-overlay-2", shown && "border-b-0")}>
                <TableCell numeric className="align-top text-muted">
                  {/* A shared position is shown shared, which is the whole
                      point of the tie rule saying so out loud — and it has to
                      be *said*, not only drawn. The `=` is a mark a sighted
                      reader recognises and a screen reader either skips or
                      reads as "equals" out of nowhere, so the word goes
                      alongside it: without this, two rows both announce "1"
                      and nothing explains why (R-181). `Podium` says the same
                      thing in the same words. */}
                  {row.level && (
                    <>
                      <span aria-hidden>=</span>
                      <span className="sr-only">Equal </span>
                    </>
                  )}
                  {row.position}
                </TableCell>

                <TableCell className="align-top">
                  <button
                    type="button"
                    onClick={() => setOpen(shown ? null : row.userId)}
                    aria-expanded={shown}
                    aria-controls={panelId}
                    className="group flex w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-union"
                  >
                    <Chevron open={shown} />
                    <Avatar
                      name={row.name}
                      src={row.avatarUrl}
                      size="sm"
                      className="hidden sm:inline-flex"
                    />
                    <span className="min-w-0 truncate text-chalk transition-colors group-hover:text-hot">
                      {row.name}
                    </span>
                    {mine && <Badge tone="union">You</Badge>}
                  </button>
                  {countBest !== null && (
                    <span className="mt-0.5 block text-12 text-dim">
                      {row.counted} of {row.played} count
                    </span>
                  )}
                </TableCell>

                {showMovement && (
                  <TableCell align="center" className="align-top">
                    <Movement places={row.moved} />
                  </TableCell>
                )}

                <TableCell numeric align="right" className="align-top text-16 text-chalk">
                  {row.points}
                </TableCell>
              </TableRow>

              {shown && (
                <TableRow className={cx(mine && "bg-overlay-2")}>
                  <TableCell id={panelId} colSpan={columns.length} className="pb-5 pt-0">
                    <Breakdown row={row} byId={byId} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Where one player's points came from — one line per event, in the order the
 * season was played (UC-34 4).
 *
 * The lines a `countBest` rule threw away are shown, quietened and labelled,
 * rather than hidden: a total that silently ignores a night somebody played is
 * the one figure on this page nobody would be able to check.
 */
function Breakdown({
  row,
  byId,
}: {
  row: SeasonPlayer;
  byId: Map<string, StandingsEvent>;
}) {
  return (
    <ul className="space-y-1.5 border-l border-hair pl-4 sm:ml-6">
      {row.results.map((result) => {
        const event = byId.get(result.eventId);
        return (
          <li
            key={result.eventId}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-13"
          >
            <span className={cx("min-w-0", result.counted ? "text-body" : "text-dim")}>
              {event ? (
                <Link
                  href={`/events/${event.slug}`}
                  className="underline-offset-4 hover:text-union hover:underline"
                >
                  {event.title}
                </Link>
              ) : (
                "That event"
              )}
            </span>

            {event?.gameName && <span className="text-12 text-dim">{event.gameName}</span>}

            <span className={cx("text-12", result.counted ? "text-muted" : "text-dim")}>
              {result.position === null ? "Took part" : `Finished ${ordinal(result.position)}`}
              {event && event.weight > 1 && ` · ${event.weight}× night`}
              {/*
                The other reason a line here does not match the table printed
                below (R-177). A reader opening their own row to check the
                arithmetic against that table is the reader UC-34 4 is written
                for, and a night scored off a different table has to say so or
                the sum looks wrong rather than different.
              */}
              {event?.ownTable && " · own points table"}
            </span>

            <span
              className={cx(
                "num ml-auto",
                result.counted ? "text-chalk" : "text-dim line-through"
              )}
            >
              {result.points}
            </span>

            {!result.counted && (
              <span className="text-12 text-dim">Outside the best results</span>
            )}
          </li>
        );
      })}

      <li className="flex items-baseline gap-3 border-t border-hair pt-2 text-13 text-muted">
        <span>Counted total</span>
        <span className="num ml-auto text-chalk">{row.points}</span>
      </li>
    </ul>
  );
}

/**
 * How far the last event moved this player (UC-34 2c).
 *
 * The arrow and the number carry the meaning; the colour only agrees with them,
 * because a reader who cannot tell green from red still has to be able to read
 * the column.
 */
function Movement({ places }: { places: number | null }) {
  if (places === null) {
    /*
     * What "New" means, said rather than hidden in a `title`. A tooltip on a
     * `<span>` is not keyboard-reachable, never appears on a touch screen and
     * is announced by some screen readers and not others — so the one case on
     * this column that needs explaining was the one case nobody could be sure
     * of getting. `sr-only`, as the two branches below already do it.
     */
    return (
      <span className="text-12 text-dim">
        <span aria-hidden>New</span>
        <span className="sr-only">New, not in the standings before this event</span>
      </span>
    );
  }
  if (places === 0) {
    return (
      <span className="text-muted">
        <span aria-hidden>–</span>
        <span className="sr-only">No change</span>
      </span>
    );
  }
  const up = places > 0;
  return (
    <span className={cx("num text-13", up ? "text-success" : "text-flare")}>
      {/* The arrow *and* the figure are the drawn version, so both are
          hidden: with the digit left announced beside the sentence below it,
          a one-place gain read as "1 up 1 place". */}
      <span aria-hidden>
        {up ? "▲" : "▼"}
        {Math.abs(places)}
      </span>
      <span className="sr-only">
        {up ? "up" : "down"} {Math.abs(places)} place{Math.abs(places) === 1 ? "" : "s"}
      </span>
    </span>
  );
}
