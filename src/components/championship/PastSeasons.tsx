import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { seasonMonths } from "@/lib/championship-policy";
import type { FinishedSeason } from "@/lib/championship-season";

/**
 * The seasons that are over, and who took them (UC-35 3-4).
 *
 * A finished season keeps its page for good, so every name here is a link. The
 * winner is re-derived from the recorded places on every read rather than
 * written down when the season closed — see `finishedSeasons` — which is why a
 * correction to a three-year-old night still shows up here.
 */

export default function PastSeasons({
  seasons,
  thisOneFinished,
}: {
  /** Every finished season except the one this page is about. */
  seasons: FinishedSeason[];
  /** True when the season this page is about is itself a finished one. */
  thisOneFinished: boolean;
}) {
  if (seasons.length === 0) {
    return <EmptyState>{noPastSeasonsText(thisOneFinished)}</EmptyState>;
  }

  return (
    <ul className="space-y-3">
      {seasons.map((season) => {
        const months = seasonMonths(season.runsFrom, season.runsTo);
        return (
          <li
            key={season.slug}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hair/60 pb-3 last:border-0 last:pb-0"
          >
            <Link
              href={`/championship/${season.slug}`}
              className="text-14 text-chalk underline-offset-4 hover:text-union hover:underline"
            >
              {season.name}
            </Link>
            {months && <span className="text-12 text-muted">{months}</span>}
            <span className="ml-auto text-13 text-body">
              {season.winners.length === 0 ? (
                <span className="text-muted">Nobody played</span>
              ) : (
                <>
                  <span className="text-muted">Won by </span>
                  {season.winners.join(" and ")}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the section says when there is nothing to list (UC-35 4).
 *
 * The list never contains the season you are reading — both routes filter it
 * out, because a page that links to itself under "past seasons" is a page that
 * has lost track of where you are. That filter is what makes an empty list
 * ambiguous: on a running season's page it means no season has ever finished,
 * and on a finished one's it means no *other* one has. The second case was
 * printing the first case's sentence, which the page it sat on disproved.
 *
 * Exported and pure so the two sentences can be pinned without rendering:
 * which one is true is a fact about the season, not about the markup.
 */
export function noPastSeasonsText(thisOneFinished: boolean): string {
  return thisOneFinished
    ? "No other season has finished yet. When one does it joins this one here, with its standings and its winner, for good."
    : "No season has finished yet. When one does it stays here, with its standings and its winner, for good.";
}
