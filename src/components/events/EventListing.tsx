import Link from "next/link";
import { Button, Eyebrow, Panel, Section, TabLinks, plural } from "@/components/ui";
import type { EventSummary } from "@/lib/events";
import EventRow, { EventRows } from "./EventRow";
import { eventTypeLabel } from "./labels";

/**
 * The body `/events` and `/archive` share.
 *
 * They used to be one page with a `?when=` toggle, and splitting them is not
 * cosmetic. "Coming up" and "what we have run" are two questions, asked by
 * different people at different times — one is planning, the other is history —
 * and a toggle made the second one a state of the first, reachable only by
 * noticing a control. Two addresses put the archive in the navigation, make it
 * linkable on its own, and let each page say something true in its heading
 * instead of one heading hedging across both.
 *
 * What is genuinely shared is the shape: a kind filter, a list, and an empty
 * state that points at the other page. That lives here so the two cannot drift
 * into looking like different products.
 */

export type EventListingScope = "upcoming" | "past";

export type EventListingProps = {
  scope: EventListingScope;
  /** Events in this scope, already ordered by the read. */
  events: EventSummary[];
  /** How many are on the other page, so the empty state can offer it. */
  otherCount: number;
  /** The `?type=` filter, or null for all of them. */
  type: string | null;
  /** True when there are no published events at all, anywhere. */
  nothingAtAll: boolean;
};

const COPY = {
  upcoming: {
    path: "/events",
    other: { path: "/archive", label: "See the archive" },
    order: "soonest first",
    emptyFiltered: (kind: string) => `No ${kind} events coming up.`,
    empty:
      "Nothing is coming up at the moment. The archive has everything that has already run.",
  },
  past: {
    path: "/archive",
    other: { path: "/events", label: "What's coming up" },
    order: "most recent first",
    emptyFiltered: (kind: string) => `No ${kind} events in the archive.`,
    empty: "Nothing has finished yet — everything published is still to come.",
  },
} as const;

export default function EventListing({
  scope,
  events,
  otherCount,
  type,
  nothingAtAll,
}: EventListingProps) {
  const copy = COPY[scope];
  const types = countTypes(events);
  const shown = type ? events.filter((event) => event.type === type) : events;

  const href = (nextType: string | null): string =>
    nextType ? `${copy.path}?type=${encodeURIComponent(nextType)}` : copy.path;

  return (
    <>
      {/*
        Only the kind filter now. The when-toggle that used to share this rule
        is the navigation instead, which is where a choice between two pages
        belongs.
      */}
      {types.length > 1 && (
        <div className="flex flex-wrap items-stretch gap-x-8 gap-y-2 shadow-rail">
          <TabLinks
            aria-label="Kind"
            rule={false}
            items={[
              {
                href: href(null),
                label: "All kinds",
                count: events.length,
                current: type === null,
              },
              ...types.map(([value, total]) => ({
                href: href(value),
                label: eventTypeLabel(value),
                count: total,
                current: type === value,
              })),
            ]}
          />
        </div>
      )}

      {shown.length === 0 ? (
        <Panel as="section" tone="wash" padding="lg">
          <Eyebrow className="mb-3">Nothing here</Eyebrow>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            {nothingAtAll
              ? "No events have been published yet. When an admin publishes one it appears here, and on the hub, straight away."
              : type
                ? copy.emptyFiltered(eventTypeLabel(type).toLowerCase())
                : copy.empty}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {type && <Button href={href(null)}>Clear the filter</Button>}
            {otherCount > 0 && (
              <Button href={copy.other.path}>{copy.other.label}</Button>
            )}
            <Button href="/">Back to the hub</Button>
          </div>
        </Panel>
      ) : (
        <Section first tone="plain" className="pb-14 pt-2">
          <p className="mb-1 text-[13px] text-muted">
            {plural(shown.length, "event")} · {copy.order}
            {otherCount > 0 && (
              <>
                {" · "}
                <Link
                  href={copy.other.path}
                  className="text-union underline underline-offset-4"
                >
                  {copy.other.label.toLowerCase()}
                </Link>
              </>
            )}
          </p>
          <EventRows>
            {shown.map((event) => (
              <EventRow key={event.id} event={event} href={`/events/${event.slug}`} />
            ))}
          </EventRows>
        </Section>
      )}
    </>
  );
}

/** Which types are represented here, commonest first. */
function countTypes(events: readonly EventSummary[]): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const event of events) totals.set(event.type, (totals.get(event.type) ?? 0) + 1);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
