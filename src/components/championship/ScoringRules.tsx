import { Eyebrow } from "@/components/ui";
import { scoringRulesText } from "@/lib/championship-policy";
import { ordinal } from "@/lib/format-policy";

/**
 * How the season scores, on the page (UC-34 2a, 2d, and R-196).
 *
 * The table itself, what taking part is worth, and the rule that settles two
 * players level on points — printed rather than implied, because a standing
 * nobody can check is a standing people argue about. The sentences come from
 * `scoringRulesText`, which is where those rules are stated once; this file
 * only lays them out.
 *
 * **This is the season's table, not every table the season used.** An event
 * may carry its own (R-177), and one that does is marked in the events list
 * rather than reprinted here — see `SeasonEvent.ownTable`.
 */

export default function ScoringRules({
  pointsTable,
  participationPoints,
  countBest,
}: {
  pointsTable: number[];
  participationPoints: number;
  countBest: number | null;
}) {
  return (
    <div className="space-y-6">
      <div>
        <Eyebrow as="h3" className="mb-3">
          What each finish is worth
        </Eyebrow>
        <ol className="flex flex-wrap gap-2">
          {pointsTable.map((points, index) => (
            <li
              key={index}
              className="min-w-[4.25rem] rounded border border-hair px-3 py-2"
            >
              <span className="block text-12 text-muted">{ordinal(index + 1)}</span>
              <span className="num block text-16 text-chalk">{points}</span>
            </li>
          ))}
        </ol>
      </div>

      <ul className="space-y-2">
        {scoringRulesText({ participationPoints, countBest }).map((line) => (
          <li key={line} className="max-w-[62ch] text-14 leading-relaxed text-muted">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
