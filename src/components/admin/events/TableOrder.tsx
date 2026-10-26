import Link from "next/link";
import { Alert, EmptyState, Eyebrow, Panel, plural } from "@/components/ui";
import type { FinishingOrder } from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import { ordinal } from "@/lib/format-policy";

/**
 * Where everyone finished, for a night scored in rounds — UC-46 5, read-only.
 *
 * ## Why it is shown rather than hidden
 *
 * The season takes a round-scored night's places from its table (R-236), so
 * there is nothing to type here. The panel stays because "where did these
 * places come from" is the question an admin opening the Championship tab will
 * have, and the honest answer is the table itself: each place with the total
 * that produced it, the direction the table was read in, and the Results tab
 * named as the one place a wrong result is corrected. Decision 006 accepted the
 * cost — there is no dragging a player to first — and this is where the cost is
 * said out loud, beside the number it protects.
 *
 * ## A hand-typed order the night has outgrown
 *
 * `order.shadowed` is the UC-33 order saved before this night was switched to
 * round scoring. The decision in `finishingOrdersFor` is that such rows are kept,
 * never read as places, and named on the screen that would have read them —
 * this one. So they are listed here in full, in the words they were typed, with
 * a plain statement that the season is not reading them. A standing alert, not
 * an announced one: it is on the page as it first renders, and interrupting
 * every visit with it is the trap `Alert`'s docblock describes.
 */

export type TableOrderProps = {
  eventId: string;
  /** The season, its table and its weight — everything a place is worth. */
  counting: EventChampionship;
  order: Extract<FinishingOrder, { source: "table" }>;
};

export default function TableOrder({ eventId, counting, order }: TableOrderProps) {
  const season = counting.season;
  const table = counting.pointsTable?.length ? counting.pointsTable : season.pointsTable;

  return (
    <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12">
      <div>
        <Eyebrow className="mb-2">Where everyone finished</Eyebrow>
        <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
          This night is scored in rounds, so its places come from its table: the round
          scores on the{" "}
          <Link
            href={`/admin/events/${eventId}?tab=results`}
            className="text-union underline-offset-2 hover:underline"
          >
            Results tab
          </Link>
          , added up and ranked. Nothing here is typed. To change a place, correct the round
          it came from.
        </p>
        <p className="mt-2 max-w-[62ch] text-12 leading-relaxed text-muted">
          {season.name} pays{" "}
          <span className="text-chalk/80">{table.join(", ") || "no places at all"}</span>, and{" "}
          <span className="text-chalk/80">{season.participationPoints} for taking part</span>
          {counting.weight === 1 ? "" : `, all multiplied by ${counting.weight}`}. Players level
          on their total share a place, and the next one stays empty.
        </p>
      </div>

      {order.places.length === 0 ? (
        <EmptyState>
          No round has been scored yet. Once one is, the table is ranked here and the season
          reads it.
        </EmptyState>
      ) : (
        <ol className="divide-y divide-hair border-y border-hair">
          {order.places.map((place) => (
            <li key={place.id} className="flex flex-wrap items-baseline gap-4 py-3">
              <span className="w-12 shrink-0 text-14 tabular-nums text-chalk/80">
                {ordinal(place.position)}
              </span>
              <span className="min-w-0 flex-1 text-14 text-chalk/80">{place.name}</span>
              <span className="text-12 tabular-nums text-muted">total {place.total}</span>
            </li>
          ))}
        </ol>
      )}

      {order.shadowed.length > 0 && (
        <Alert tone="union" standing>
          {plural(order.shadowed.length, "place")} were typed by hand before this night was
          scored in rounds:{" "}
          {order.shadowed.map((place) => `${place.name} ${ordinal(place.position)}`).join(", ")}.
          They are kept but not read; the season takes its places from the table above. They
          would be read again only if this night stopped being scored in rounds.
        </Alert>
      )}
    </Panel>
  );
}
