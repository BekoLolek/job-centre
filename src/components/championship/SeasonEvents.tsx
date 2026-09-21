import Link from "next/link";
import { EventDateRange, iso } from "@/components/events";
import { Badge, EmptyState, Eyebrow } from "@/components/ui";
import type { CountedEvent, SeasonEvent } from "@/lib/championship-season";

/**
 * The season's events: the ones that have counted, with who won each, and the
 * ones still to come (UC-34 5-6).
 *
 * Two lists rather than one with a marker, because they answer two different
 * questions — "how did we get here" and "what is left" — and a reader looking
 * for the second should not have to scan past the first to find out there is
 * nothing in it.
 *
 * **No instant is formatted here.** Every date goes through `EventDateRange`,
 * which re-keys on mount and prints in the reader's own zone; the server has no
 * idea what that is.
 */

export default function SeasonEvents({
  counted,
  toCome,
}: {
  counted: CountedEvent[];
  toCome: SeasonEvent[];
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <div>
        <Eyebrow as="h3" className="mb-4">
          Counted so far · {counted.length}
        </Eyebrow>
        {counted.length === 0 ? (
          <EmptyState>
            Nothing has been scored yet. The first finishing order an admin records starts
            the table.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {counted.map((event) => (
              <Row key={event.eventId} event={event}>
                <span className="text-13 text-body">
                  {event.winners.length === 0 ? (
                    <span className="text-muted">No winner recorded</span>
                  ) : (
                    <>
                      <span className="text-muted">Won by </span>
                      {event.winners.join(" and ")}
                    </>
                  )}
                </span>
              </Row>
            ))}
          </ul>
        )}
      </div>

      <div>
        <Eyebrow as="h3" className="mb-4">
          Still to come · {toCome.length}
        </Eyebrow>
        {toCome.length === 0 ? (
          <EmptyState>
            Every event in this season has been scored. New ones appear here as they are
            added.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {toCome.map((event) => (
              <Row key={event.eventId} event={event}>
                <span className="text-13 text-muted">Not scored yet</span>
              </Row>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One event: what it was, when, which game, and whatever the list adds under it. */
function Row({
  event,
  children,
}: {
  event: SeasonEvent;
  children: React.ReactNode;
}) {
  return (
    <li className="border-b border-hair/60 pb-3 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/events/${event.slug}`}
          className="min-w-0 text-14 text-chalk underline-offset-4 hover:text-union hover:underline"
        >
          {event.title}
        </Link>
        {event.gameName && <Badge>{event.gameName}</Badge>}
        {event.weight > 1 && <Badge tone="union">{event.weight}× points</Badge>}
        {/*
          The two ways a night can score differently from the table printed
          further down the page (R-176, R-177), marked in the same place and in
          the same vocabulary. Without this the section below says "the
          season's table" and nothing on the page ever says which nights did
          not use it — see the note on `SeasonEvent.ownTable`.
        */}
        {event.ownTable && <Badge tone="union">Own points table</Badge>}
        <EventDateRange
          startsAt={iso(event.startsAt)}
          fallback="No date yet"
          className="ml-auto"
        />
      </div>
      <div className="mt-1">{children}</div>
    </li>
  );
}
