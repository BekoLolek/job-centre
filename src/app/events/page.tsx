/**
 * `/events` — every published event (docs/platform-plan.md §4).
 *
 * "All events, filterable, with a past/upcoming toggle." Both controls are
 * links carrying a query string rather than client state, which costs nothing
 * and buys three things: the page stays a server component, a filtered view is
 * a URL somebody can paste into Discord, and the whole thing works before any
 * JavaScript arrives. Filtering is a click, which is the standing rule (§2).
 *
 * Drafts are never here. `listEvents` with no status filter is the only read
 * that returns them and it belongs to `/admin/events`; a member seeing a draft
 * would be seeing an event that cannot be applied to and may never happen.
 */

import AppHeader from "@/components/AppHeader";
import { EventRow, EventRows, eventTypeLabel } from "@/components/events";
import { Button, Eyebrow, Panel, Section, TabLinks, plural } from "@/components/ui";
import type { EventStatus } from "@/db/schema";
import { type EventSummary, listEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Events · Job Centre Events",
  description: "Everything the Job Centre has coming up, and everything it has run.",
};

/** Everything a member may see. Deliberately not `draft`. */
const PUBLIC_STATUSES: EventStatus[] = ["published", "live", "complete", "cancelled"];

type When = "upcoming" | "past";

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const when: When = first(params.when) === "past" ? "past" : "upcoming";
  const type = first(params.type);

  const now = new Date();
  const [upcoming, past] = await Promise.all([
    listEvents({ status: PUBLIC_STATUSES, upcoming: true, now }),
    listEvents({ status: PUBLIC_STATUSES, upcoming: false, now }),
  ]);

  const scope = when === "upcoming" ? upcoming : past;
  const types = countTypes(scope);
  const shown = type ? scope.filter((event) => event.type === type) : scope;

  const nothingAtAll = upcoming.length === 0 && past.length === 0;

  /** A filter link that keeps whatever else is set. */
  const href = (next: { when?: When; type?: string | null }): string => {
    const query = new URLSearchParams();
    const wantWhen = next.when ?? when;
    const wantType = next.type === undefined ? type : next.type;
    if (wantWhen === "past") query.set("when", "past");
    if (wantType) query.set("type", wantType);
    const search = query.toString();
    return search ? `/events?${search}` : "/events";
  };

  return (
    <div className="min-h-screen">
      <AppHeader section="Events" />

      <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Job Centre · Events</Eyebrow>
            <h1 className="font-display text-4xl leading-none">Events</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everything the community has coming up, and everything it has run. Nothing is
              ever deleted — a finished event keeps its page for the record.
            </p>
          </div>

        </header>

        {/*
          Both menus share one rule: when on the left, kind on the right. They
          are the same control at different weights — which set of events, then
          which slice of that set — and putting them on one edge says so
          without a word of explanation or a box around either.
        */}
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b border-hair">
          <TabLinks
            aria-label="When"
            rule={false}
            items={[
              {
                href: href({ when: "upcoming" }),
                label: "Upcoming",
                count: upcoming.length,
                current: when === "upcoming",
              },
              {
                href: href({ when: "past" }),
                label: "Past",
                count: past.length,
                current: when === "past",
              },
            ]}
          />

          {types.length > 1 && (
            <TabLinks
              aria-label="Kind"
              rule={false}
              size="sm"
              items={[
                {
                  href: href({ type: null }),
                  label: "All kinds",
                  count: scope.length,
                  current: type === null,
                },
                ...types.map(([value, total]) => ({
                  href: href({ type: value }),
                  label: eventTypeLabel(value),
                  count: total,
                  current: type === value,
                })),
              ]}
            />
          )}
        </div>

        {shown.length === 0 ? (
          <Panel as="section">
            <Eyebrow className="mb-3">Nothing here</Eyebrow>
            <p className="max-w-xl text-sm leading-relaxed text-muted">
              {nothingAtAll
                ? "No events have been published yet. When an admin publishes one it appears here, and on the hub, straight away."
                : type
                  ? `No ${eventTypeLabel(type).toLowerCase()} events ${when === "upcoming" ? "coming up" : "in the archive"}.`
                  : when === "upcoming"
                    ? "Nothing is coming up at the moment. The archive has everything that has already run."
                    : "Nothing has finished yet — everything the Job Centre has published is still to come."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {type && <Button href={href({ type: null })}>Clear the filter</Button>}
              {when === "upcoming" && past.length > 0 && (
                <Button href={href({ when: "past", type: null })}>See the archive</Button>
              )}
              {when === "past" && upcoming.length > 0 && (
                <Button href={href({ when: "upcoming", type: null })}>What&apos;s coming up</Button>
              )}
              <Button href="/">Back to the hub</Button>
            </div>
          </Panel>
        ) : (
          <Section first tone="plain" className="pb-14 pt-2">
            <p className="mb-1 text-[13px] text-muted">
              {plural(shown.length, "event")} ·{" "}
              {when === "upcoming" ? "soonest first" : "most recent first"}
            </p>
            <EventRows>
              {shown.map((event) => (
                <EventRow key={event.id} event={event} href={`/events/${event.slug}`} />
              ))}
            </EventRows>
          </Section>
        )}
      </main>
    </div>
  );
}

/** Which types are represented in this scope, commonest first. */
function countTypes(events: readonly EventSummary[]): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const event of events) totals.set(event.type, (totals.get(event.type) ?? 0) + 1);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
