"use client";

import LocalTime from "@/components/format/LocalTime";
import ZoneNote from "@/components/format/ZoneNote";
import { matchStatusLabel, seriesLabel } from "@/components/format/labels";
import {
  choiceRecap,
  gameLine,
  gamesPlayed,
  groupByDay,
  playedGames,
  refereesOf,
  resultsLog,
  seriesScore,
} from "@/components/format/board";
import { EmptyState, Eyebrow, Panel, cx, plural } from "@/components/ui";
import type { ResolvedMatch } from "@/lib/format-resolve";

/**
 * The Results tab (§4: every match and game played — maps, referees, scores,
 * times).
 *
 * The full record, and the only tab that shows the *inside* of a series. A
 * bracket card says 2–1; this says which two maps, on which modes, who
 * refereed, and how long the whole thing took. That is the part somebody comes
 * back for three weeks later, and the part the old board could only give you by
 * scrolling the whole bracket looking for cards with numbers on.
 *
 * Ordered oldest first and grouped by the day it was played on, so it reads as
 * a history rather than as a bracket rearranged. Nothing that has not been played
 * appears at all — this tab exists only once there is something in it, so an
 * empty state here means the last result was un-recorded rather than that
 * nothing ever happened.
 *
 * A client component, because every time on it is an instant and an instant is
 * only meaningful in somebody's own zone.
 */

export type ResultsTabProps = {
  matches: ResolvedMatch[];
  /** Which day each slot ran on, from the block plan. */
  dayBySlot: Record<string, number>;
};

export default function ResultsTab({ matches, dayBySlot }: ResultsTabProps) {
  const log = resultsLog(matches);

  if (log.length === 0) {
    return (
      <Panel as="section">
        <Eyebrow className="mb-4">Results</Eyebrow>
        <EmptyState>Nothing has been played yet.</EmptyState>
      </Panel>
    );
  }

  const { days, undated } = groupByDay(log, dayBySlot);
  const games = gamesPlayed(log);

  return (
    <section className="space-y-6">
      <Panel padding="md">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <Eyebrow>
            {plural(log.length, "match", "matches")} · {plural(games, "game")} played
          </Eyebrow>
          <ZoneNote />
        </div>
      </Panel>

      {days.map((day) => (
        <Panel as="section" key={day.day} padding="none">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hair px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-3">
              {days.length > 1 && <Eyebrow as="h3">Day {day.day}</Eyebrow>}
              <LocalTime at={day.startsAt} format="day" className="text-sm text-chalk" />
            </div>
            <Eyebrow as="span">{plural(day.matches.length, "match", "matches")}</Eyebrow>
          </div>

          <ul className="divide-y divide-hair/60">
            {day.matches.map((match) => (
              <ResultRow key={match.slot} match={match} />
            ))}
          </ul>
        </Panel>
      ))}

      {undated.length > 0 && (
        <Panel as="section" padding="none">
          <div className="border-b border-hair px-5 py-4">
            <Eyebrow as="h3">No time recorded</Eyebrow>
          </div>
          <ul className="divide-y divide-hair/60">
            {undated.map((match) => (
              <ResultRow key={match.slot} match={match} />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}

/**
 * One match, opened up.
 *
 * The score line uses the same rule as every card on the site: a Bo1 prints its
 * map score, anything longer prints maps won. The per-game rows below it always
 * print the map score, which is why a Bo3 can read "2–1" over three rows of
 * "3–1", "2–3", "3–0" without contradicting itself.
 *
 * Each game also carries who was entitled to pick its side and who its map
 * (§8.4). Which map got played is already on the row; *who chose it* is the
 * separate fact, and it is the one an argument three weeks later is about —
 * which is the whole reason this tab exists.
 */
function ResultRow({ match }: { match: ResolvedMatch }) {
  const score = seriesScore(match);
  const games = playedGames(match);
  const referees = refereesOf(match);
  const decided = match.status === "done" && Boolean(match.winner);
  const aWon = decided && match.winner === match.teamAId;
  const bWon = decided && match.winner === match.teamBId;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Eyebrow as="span" className="text-dim">
          {match.displayLabel} · {seriesLabel(match.bestOf)}
        </Eyebrow>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted">
          {match.scheduledAt && <LocalTime at={match.scheduledAt} />}
          {match.finishedAt && (
            <span className="num">
              ran to <LocalTime at={match.finishedAt} format="clock" />
              {match.durationMin !== null && ` · ${match.durationMin} min`}
            </span>
          )}
          {!decided && (
            <Eyebrow as="span" className="text-ember">
              {matchStatusLabel(match)}
            </Eyebrow>
          )}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <span className={cx("min-w-0 flex-1 truncate", aWon ? "text-gold" : "text-chalk/85")}>
          {match.nameA}
        </span>
        <span className="num shrink-0 text-lg">
          <span className={aWon ? "text-gold" : "text-muted"}>{score.a}</span>
          <span className="text-muted">–</span>
          <span className={bWon ? "text-gold" : "text-muted"}>{score.b}</span>
        </span>
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-right",
            bWon ? "text-gold" : "text-chalk/85"
          )}
        >
          {match.nameB}
        </span>
      </div>

      {games.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-hair/60 pt-2">
          {match.games.map((game, index) =>
            game.played ? (
              <li
                key={index}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]"
              >
                <Eyebrow as="span" className="w-6 shrink-0">
                  G{index + 1}
                </Eyebrow>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {gameLine(game) || "Map not recorded"}
                </span>
                {game.referee && (
                  <span className="shrink-0 text-dim">
                    ref <span className="text-chalk/70">{game.referee}</span>
                  </span>
                )}
                <span className="num shrink-0 text-chalk/80">
                  {game.scoreA}–{game.scoreB}
                </span>
                {match.choices[index] && (
                  <span className="w-full pl-9 text-dim">
                    {choiceRecap(match.choices[index])}
                  </span>
                )}
              </li>
            ) : null
          )}
        </ul>
      )}

      {games.length === 0 && referees.length > 0 && (
        <p className="mt-2 text-[11px] text-muted">Referee: {referees.join(" · ")}</p>
      )}
    </li>
  );
}
