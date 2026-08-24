import type { ReactNode } from "react";
import { Eyebrow, Panel, cx } from "@/components/ui";
import type { ResolvedMatch } from "@/lib/format-resolve";
import LocalTime from "./LocalTime";
import { choiceLine, choiceRecap } from "./board";
import { modeLabel, seriesLabel } from "./labels";

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
 * game of the series — including games that have not been played, which are
 * precisely the ones the answer is still needed for.
 *
 * ## Why there is a `children` slot
 *
 * The public results page and the admin's Results tab draw the same card; only
 * the admin's has a form under it. A slot keeps the card free of any notion of
 * who is looking at it, which is what lets both surfaces import this one file.
 */

export type MatchCardProps = {
  match: ResolvedMatch;
  /** Gold border — the grand final, or whatever is on right now. */
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
  const aWon = match.status === "done" && match.winner !== null && match.winner === match.teamAId;
  const bWon = match.status === "done" && match.winner !== null && match.winner === match.teamBId;

  return (
    <Panel
      as="article"
      padding="sm"
      className={cx(
        featured && "border-gold/40",
        match.status === "live" && "border-ember/40",
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
            <LocalTime at={match.scheduledAt} className="block text-[11px] text-muted" />
          )}
          {match.finishedAt ? (
            <div className="num text-[11px] text-muted">
              ran to <LocalTime at={match.finishedAt} format="clock" />
              {match.durationMin !== null && ` · ${match.durationMin} min`}
            </div>
          ) : (
            match.durationMin !== null && (
              <div className="num text-[11px] text-muted">{match.durationMin} min</div>
            )
          )}
          {referees.length > 0 && (
            <div className="max-w-[160px] truncate text-[11px] text-dim">
              Referee: <span className="text-chalk/70">{referees.join(" · ")}</span>
            </div>
          )}
          {match.needsDecision ? (
            <Eyebrow className="mt-1 text-ember">Needs a winner</Eyebrow>
          ) : match.status === "live" ? (
            <Eyebrow className="mt-1 text-ember">In progress</Eyebrow>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <TeamRow
          name={match.nameA}
          score={scoreFor(match, "a")}
          won={aWon}
          dim={!match.teamAId}
        />
        <TeamRow
          name={match.nameB}
          score={scoreFor(match, "b")}
          won={bWon}
          dim={!match.teamBId}
        />
      </div>

      {match.skipped && (
        <p className="mt-3 border-t border-hair pt-3 text-[11px] text-muted">
          Not needed — the grand final settled it.
        </p>
      )}

      {/*
        Who picks what, per game. Drawn from `match.choices`, which the resolver
        derives from one stored coin — nothing here works it out, and a re-flip
        therefore rewrites the whole list at once rather than leaving game 3
        disagreeing with game 1.
      */}
      {match.choices.length > 0 && (
        <div className="mt-3 border-t border-hair pt-3">
          {/*
            Shown in a compact bracket column too, unlike the played-games list:
            a card nobody has played yet is exactly the one whose next game
            still needs somebody told who picks what. Only the heading goes.
          */}
          {!compact && <Eyebrow className="mb-1.5 text-dim">Side and map</Eyebrow>}
          <ul className="space-y-1">
            {match.choices.map((choice) => (
              <li key={choice.index} className="flex items-baseline gap-2 text-[11px]">
                <Eyebrow as="span" className="shrink-0">
                  G{choice.index + 1}
                </Eyebrow>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {match.games[choice.index]?.played ? choiceRecap(choice) : choiceLine(choice)}
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
              <li key={index} className="text-[11px]">
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
        <p className="mt-3 border-t border-hair pt-3 text-[11px] text-muted">
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
              ? "font-display text-lg leading-tight text-gold"
              : "text-chalk"
        )}
      >
        {name}
      </span>
      <span className={cx("num text-lg", won ? "text-gold" : "text-muted")}>
        {dim ? "–" : score}
      </span>
    </div>
  );
}
