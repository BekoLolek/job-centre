import type { ReactNode } from "react";
import { Eyebrow, Panel, cx } from "@/components/ui";
import type { ResolvedMatch } from "@/lib/format-resolve";
import LocalTime from "./LocalTime";
import { choiceLine, choiceRecap, matchTone } from "./board";
import { modeLabel, seriesLabel, slotOriginLabel } from "./labels";

/**
 * One match, read-only — the card the old board draws, with its data source
 * changed and its editing half removed.
 *
 * Everything it shows has already been decided by `format-resolve`: who the two
 * teams are, whether either of them won, whether the series is a draw waiting
 * on an admin. It re-derives none of that. The one thing it chooses for itself
 * is which number to print beside a team, and even that is a display rule —
 * a Bo1's "score" is the map score, a longer series' is maps won.
 *
 * ## The side and map choice is printed per game, not per match, in both modes
 *
 * §8.4's rule swaps the two roles every game, so "who picks the map" has a
 * different answer in game 2 than in game 1 and a single line under the card
 * could only ever be right about a third of a Bo3. The card prints one row per
 * game of the series, and while the series is still running that includes
 * games nobody has played yet — those are precisely the ones the answer is
 * still needed for (UC-19 2, R-80).
 *
 * ## …but only while the answer is still needed
 *
 * That sentence used to be the whole rule, and it is false the moment a series
 * stops. A Bo3 won 2–0 will never play a game 3, so `G3 — Voss Vanguard picks
 * the side · Bergstrom Brigade picks the map` was a promise about a game that
 * does not exist: future tense, same classes as the two games that were
 * actually played, on an event that finished a month ago. Beside it a live
 * semi at 1–0 printed the identical shape, so the one thing the list should
 * have told a reader apart — a decided series from an undecided one — was the
 * one thing it hid. UC-19 5 is explicit that a manager records maps only
 * "until one team has won the series"; there are no remaining maps after that.
 *
 * So a choice row now survives only while its answer is still needed: once the
 * series will add no further games, the rows for the games it never played go.
 *
 * **Dropped rather than kept and marked "not needed."** The card already says
 * the series is over twice over — the scoreline and the winner's styling — and
 * a third and fourth repetition of it, one per unplayed game, would push the
 * rows that record what actually happened out of a compact bracket column for
 * no new fact. Nothing is lost with them: played games keep their recaps here,
 * and the admin's per-game editor prints `choiceLine` beside every game row it
 * offers, played or not (`admin/events/ResultsTab.tsx`), so the one reader who
 * can still cause a game 3 to exist is the one reader who never read this list
 * to find out who would pick its side.
 *
 * **"Over" is `matchTone`, not `winner !== null`**, and that is the whole trap.
 * A series whose decider was drawn has no winner and is *not* over: it is
 * frozen on `needsDecision`, waiting for an admin to set `winner_override_id`,
 * and the resolver gives it its own tone (`decision`) precisely so that it is
 * never mistaken for `done`. Every one of its rows stays. A skipped bracket
 * reset is the other way round — tone `void`, no winner, no games and nothing
 * left to play — so its whole list goes and the card is left saying only what
 * it already said: not needed, the grand final settled it.
 *
 * Being derived rather than stored is what keeps this honest under R-79: an
 * admin who corrects a 2–0 back to 1–0, or clears an override, re-resolves the
 * match to a live one and game 3's row comes back on every surface at once.
 *
 * ## A slot nobody has played into yet says where it comes from
 *
 * UC-11 8a. `format-resolve` hands the card a name either way — the team, once
 * there is one, and the feeding match's placeholder until then — so the card
 * has never had to choose *what* to print. It does have to choose which way
 * round: "Upper semi 1 winner" puts the relationship last, and two rows deep in
 * a bracket column, under that match's own heading, it reads as the name of a
 * team called Upper semi 1. `slotOriginLabel` turns it round to "Winner of
 * Upper semi 1", and only for a slot that has not resolved — a real team's
 * name goes through untouched, which is why the source is consulted rather
 * than the end of the string.
 *
 * ## Why there is a `children` slot
 *
 * The public results page and the admin's Results tab draw the same card; only
 * the admin's has a form under it. A slot keeps the card free of any notion of
 * who is looking at it, which is what lets both surfaces import this one file.
 */

export type MatchCardProps = {
  match: ResolvedMatch;
  /** Union-blue border — the grand final, or whatever is on right now. */
  featured?: boolean;
  /** Hides the played-games list, for a dense bracket column. */
  compact?: boolean;
  /** Pinned under the card, above nothing. The admin editor lives here. */
  children?: ReactNode;
  className?: string;
};

export default function MatchCard({
  match,
  featured,
  compact,
  children,
  className,
}: MatchCardProps) {
  const played = match.games.filter((game) => game.played);
  const referees = [
    ...new Set(match.games.map((game) => game.referee.trim()).filter(Boolean)),
  ];
  // Keyed by `index`, the way the resolver keys it: `match.choices` pairs each
  // game with `games.find((g) => g.index === index)` (`format-resolve.ts`), so
  // reading the same list by array position is only right while every stored
  // series is contiguous and 0-based. It is today, and while an unplayed row
  // merely came out in the wrong tense that was a cheap assumption. The rule
  // below spends it differently: a mismatch here now deletes a row instead.
  const wasPlayed = (index: number) =>
    match.games.find((game) => game.index === index)?.played === true;
  // A series that will add no further games. `done` is a winner (or a drawn
  // table game, which is finished too); `void` is a reset the grand final made
  // unnecessary. `decision` — a drawn decider waiting on an admin — is neither.
  const tone = matchTone(match);
  const settled = tone === "done" || tone === "void";
  const choices = settled
    ? match.choices.filter((choice) => wasPlayed(choice.index))
    : match.choices;
  const aWon = match.status === "done" && match.winner !== null && match.winner === match.teamAId;
  const bWon = match.status === "done" && match.winner !== null && match.winner === match.teamBId;

  return (
    <Panel
      as="article"
      padding="sm"
      className={cx(
        featured && "border-union/40",
        match.status === "live" && "border-flare/40",
        match.skipped && "opacity-55",
        className
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow className="truncate">
            {match.displayLabel} · {seriesLabel(match.bestOf)}
          </Eyebrow>
          {match.note && <Eyebrow className="mt-1 text-dim">{match.note}</Eyebrow>}
        </div>

        <div className="shrink-0 text-right">
          {/*
            Through `LocalTime` rather than `formatWhen` directly: a card is
            drawn by server components as well as client ones, and an instant
            formatted during a server render comes out in the deployment's zone
            — UTC on Vercel — for every reader on earth.
          */}
          {match.scheduledAt && (
            <LocalTime at={match.scheduledAt} className="block text-11 text-muted" />
          )}
          {match.finishedAt ? (
            <div className="num text-11 text-muted">
              ran to <LocalTime at={match.finishedAt} format="clock" />
              {match.durationMin !== null && ` · ${match.durationMin} min`}
            </div>
          ) : (
            match.durationMin !== null && (
              <div className="num text-11 text-muted">{match.durationMin} min</div>
            )
          )}
          {referees.length > 0 && (
            <div className="max-w-[160px] truncate text-11 text-dim">
              Referee: <span className="text-chalk/70">{referees.join(" · ")}</span>
            </div>
          )}
          {match.needsDecision ? (
            <Eyebrow className="mt-1 text-flare">Needs a winner</Eyebrow>
          ) : match.status === "live" ? (
            <Eyebrow className="mt-1 text-flare">In progress</Eyebrow>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <TeamRow
          name={
            match.teamAId ? match.nameA : slotOriginLabel(match.sourceA, match.nameA)
          }
          score={scoreFor(match, "a")}
          won={aWon}
          dim={!match.teamAId}
        />
        <TeamRow
          name={
            match.teamBId ? match.nameB : slotOriginLabel(match.sourceB, match.nameB)
          }
          score={scoreFor(match, "b")}
          won={bWon}
          dim={!match.teamBId}
        />
      </div>

      {match.skipped && (
        <p className="mt-3 border-t border-hair pt-3 text-11 text-muted">
          Not needed — the grand final settled it.
        </p>
      )}

      {/*
        Who picks what, per game. Drawn from `match.choices`, which the resolver
        derives from one stored coin — nothing here works it out, and a re-flip
        therefore rewrites the whole list at once rather than leaving game 3
        disagreeing with game 1.
      */}
      {choices.length > 0 && (
        <div className="mt-3 border-t border-hair pt-3">
          {/*
            Shown in a compact bracket column too, unlike the played-games list:
            a card nobody has played yet is exactly the one whose next game
            still needs somebody told who picks what. Only the heading goes.
            A finished series is down to its recaps here, which is the same
            handful of rows the full card shows, so the column does not grow.
          */}
          {!compact && <Eyebrow className="mb-1.5 text-dim">Side and map</Eyebrow>}
          <ul className="space-y-1">
            {choices.map((choice) => (
              <li key={choice.index} className="flex items-baseline gap-2 text-11">
                <Eyebrow as="span" className="shrink-0">
                  G{choice.index + 1}
                </Eyebrow>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {wasPlayed(choice.index) ? choiceRecap(choice) : choiceLine(choice)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && played.length > 0 && match.bestOf > 1 && (
        <ul className="mt-3 space-y-1 border-t border-hair pt-3">
          {match.games.map((game, index) =>
            game.played ? (
              <li key={index} className="text-11">
                <div className="flex items-baseline gap-2">
                  <Eyebrow as="span" className="shrink-0">
                    G{index + 1}
                  </Eyebrow>
                  <span className="flex-1 truncate text-muted">
                    {game.map || modeLabel(game.mode)}
                    {game.map && game.mode ? ` · ${game.mode}` : ""}
                  </span>
                  <span className="num text-chalk/80">
                    {game.scoreA}–{game.scoreB}
                  </span>
                </div>
                {/* Only worth repeating per game when the series had more than one. */}
                {referees.length > 1 && game.referee && (
                  <div className="pl-7 text-dim">Referee: {game.referee}</div>
                )}
              </li>
            ) : null
          )}
        </ul>
      )}

      {!compact && played.length > 0 && match.bestOf === 1 && match.games[0]?.map && (
        <p className="mt-3 border-t border-hair pt-3 text-11 text-muted">
          {match.games[0].map}
        </p>
      )}

      {children && <div className="mt-3 border-t border-hair pt-3">{children}</div>}
    </Panel>
  );
}

/** A Bo1 shows the map score; anything longer shows maps won. */
function scoreFor(match: ResolvedMatch, side: "a" | "b"): number {
  if (match.bestOf === 1) {
    const game = match.games[0];
    if (!game) return 0;
    return side === "a" ? game.scoreA : game.scoreB;
  }
  return side === "a" ? match.gamesWonA : match.gamesWonB;
}

function TeamRow({
  name,
  score,
  won,
  dim,
}: {
  name: string;
  score: number;
  won: boolean;
  dim: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className={cx(
          "flex-1 truncate",
          dim
            ? "italic text-muted"
            : won
              ? "font-display text-20 leading-tight text-union"
              : "text-chalk"
        )}
      >
        {name}
      </span>
      <span className={cx("num text-20", won ? "text-union" : "text-muted")}>
        {dim ? "–" : score}
      </span>
    </div>
  );
}
