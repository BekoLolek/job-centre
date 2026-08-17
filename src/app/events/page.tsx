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

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { EventCard, eventTypeLabel } from "@/components/events";
import { Button, Eyebrow, Panel, cx, plural } from "@/components/ui";
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
      <AppHeader section="EVENTS" />

      <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Job Centre · Events</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">EVENTS</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everything the community has coming up, and everything it has run. Nothing is
              ever deleted — a finished event keeps its page for the record.
            </p>
          </div>

          {/* The past/upcoming toggle. Two links, styled as the segmented
              control the rest of the site uses. */}
          <div className="ml-auto flex border border-hair">
            <ToggleLink href={href({ when: "upcoming" })} on={when === "upcoming"}>
              Upcoming ({upcoming.length})
            </ToggleLink>
            <ToggleLink href={href({ when: "past" })} on={when === "past"}>
              Past ({past.length})
            </ToggleLink>
          </div>
        </header>

        {/* Type filter — only when there is more than one kind to choose. */}
        {types.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow as="span" className="mr-1">
              Filter
            </Eyebrow>
            <FilterLink href={href({ type: null })} on={type === null}>
              All ({scope.length})
            </FilterLink>
            {types.map(([value, total]) => (
              <FilterLink key={value} href={href({ type: value })} on={type === value}>
                {eventTypeLabel(value)} ({total})
              </FilterLink>
            ))}
          </div>
        )}

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
          <>
            <p className="text-xs text-muted">
              {plural(shown.length, "event")}
              {type ? ` · ${eventTypeLabel(type)}` : ""} ·{" "}
              {when === "upcoming" ? "soonest first" : "most recent first"}
            </p>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((event) => (
                <EventCard key={event.id} event={event} href={`/events/${event.slug}`} />
              ))}
            </div>
          </>
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

function ToggleLink({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cx("btn border-0", on ? "bg-gold/10 text-gold" : "bg-transparent text-muted")}
    >
      {children}
    </Link>
  );
}

function FilterLink({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={on ? "true" : undefined}
      className={cx(
        "border px-3 py-2 text-sm transition-colors",
        on
          ? "border-gold bg-gold/15 text-gold"
          : "border-hair bg-raised text-chalk/75 hover:border-gold/50 hover:text-gold"
      )}
    >
      {children}
    </Link>
  );
}
