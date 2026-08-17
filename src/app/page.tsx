/**
 * `/` — the public hub (docs/platform-plan.md §4, §6.1).
 *
 * The page somebody who has never heard of us lands on, and the one place that
 * answers "is anything happening?" without a login. §6.1's order, exactly:
 *
 *  1. **Live now** — and *only* when something is. A permanently-present empty
 *     "nothing is live" box teaches people to ignore that part of the page.
 *  2. **Next up** — the closest upcoming event as the hero, with a countdown
 *     and the call to action *for this viewer*: Apply, Join the waitlist, Sign
 *     in to apply, You're in, You're #3 in the queue, or the reason it is shut.
 *  3. **Upcoming** — everything else that is coming.
 *  4. **Recently finished** — the last handful, into the archive.
 *
 * When nothing at all is scheduled the hero becomes a short "nothing on right
 * now" panel with the archive under it, because §6.1 is explicit that this must
 * never be an empty page.
 *
 * Nothing here requires a session. The signed-out visitor sees the whole board;
 * the only thing they are invited to sign in for is applying — and the
 * invitation appears at the point of applying, not before it.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import {
  Countdown,
  EventAction,
  EventCard,
  EventDateRange,
  EventSeats,
  EventStatusPill,
  formatSummary,
  viewerAction,
} from "@/components/events";
import { Badge, Button, Eyebrow, Panel, StatTile } from "@/components/ui";
import { type EventSummary, listEvents, loadApplicationForm } from "@/lib/events";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Job Centre Events",
  description: "What's running now, what's next, and how to get in.",
};

/** How many finished events the hub shows before sending you to the archive. */
const RECENT_LIMIT = 3;

export default async function HubPage() {
  const now = new Date();

  // Three reads rather than one filtered in here: `listEvents` owns what
  // "upcoming" means (§14's derived-not-stored rule applies to the calendar as
  // much as to the seat count), and a live event with no end time would fall
  // out of an upcoming filter written by hand here.
  const [live, upcoming, finished, user] = await Promise.all([
    listEvents({ status: "live", now }),
    listEvents({ status: "published", upcoming: true, now }),
    listEvents({ status: "complete", upcoming: false, now }),
    getCurrentUser(),
  ]);

  const [hero, ...rest] = upcoming;

  // The viewer's own standing on the hero event — the difference between an
  // Apply button and "you're #3 in the queue". One extra read, for one event.
  const mine = hero ? await loadApplicationForm(hero.id, user?.id ?? null, { now }) : null;

  const heroAction = hero
    ? viewerAction({
        slug: hero.slug,
        signedIn: Boolean(user),
        state: hero.applicationsState,
        application: mine?.application ?? null,
        eligibility: user ? (mine?.eligibility ?? null) : null,
      })
    : null;

  return (
    <div className="min-h-screen">
      <AppHeader section="EVENTS" />

      <main className="mx-auto max-w-[1400px] space-y-10 px-4 py-10 sm:px-6">
        {/* --- 1. Live now, and only when it is ---------------------- */}
        {live.length > 0 && (
          <section className="space-y-3">
            <Eyebrow className="text-ember">Live now</Eyebrow>
            {live.map((event) => (
              <LivePanel key={event.id} event={event} />
            ))}
          </section>
        )}

        {/* --- 2. Next up ------------------------------------------- */}
        {hero && heroAction ? (
          <section className="space-y-3">
            <Eyebrow>Next up</Eyebrow>

            <Panel as="article" padding="none" className="overflow-hidden rise">
              {hero.bannerUrl && (
                <div
                  aria-hidden
                  className="h-24 w-full border-b border-hair bg-raised bg-cover bg-center"
                  style={{ backgroundImage: `url(${JSON.stringify(hero.bannerUrl)})` }}
                />
              )}

              <div className="grid gap-6 p-6 lg:grid-cols-[1.6fr_1fr]">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <EventStatusPill status={hero.status} />
                    {formatSummary({
                      type: hero.type,
                      config: hero.config,
                      days: 0,
                      capacity: hero.capacity,
                    }).map((part) => (
                      <Badge key={part}>{part}</Badge>
                    ))}
                  </div>

                  <h1 className="font-display text-5xl leading-[0.9] tracking-wide">
                    <Link href={`/events/${hero.slug}`} className="hover:text-gold">
                      {hero.title}
                    </Link>
                  </h1>

                  {hero.description && (
                    <p className="max-w-2xl text-sm leading-relaxed text-muted">
                      {hero.description.length > 260
                        ? `${hero.description.slice(0, 260).trimEnd()}…`
                        : hero.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                    <EventDateRange
                      startsAt={hero.startsAt}
                      endsAt={hero.endsAt}
                      className="text-sm"
                    />
                    <EventSeats seats={hero.seats} size="md" />
                  </div>
                </div>

                <div className="space-y-5 border-t border-hair pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                  <StatTile
                    label={hero.startsAt ? "Starts in" : "No date yet"}
                    value={<Countdown to={hero.startsAt} passed="Under way" fallback="—" />}
                  />

                  {hero.applicationsState.open && hero.applicationsState.closesAt && (
                    <StatTile
                      label="Applications close in"
                      value={
                        <Countdown
                          to={hero.applicationsState.closesAt}
                          passed="Closed"
                          className="text-chalk/80"
                        />
                      }
                    />
                  )}

                  <EventAction action={heroAction} />

                  <Button href={`/events/${hero.slug}`} size="sm">
                    Event details
                  </Button>
                </div>
              </div>
            </Panel>
          </section>
        ) : (
          <Panel as="section" className="rise">
            <Eyebrow className="mb-3">Nothing on right now</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">
              NOTHING SCHEDULED
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              There is no upcoming event taking applications at the moment. Everything the
              community has run is kept in the archive, and the next one will appear here the
              moment it is published.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events">All events</Button>
              <Button href="/events?when=past">Archive</Button>
            </div>
          </Panel>
        )}

        {/* --- 3. Upcoming ------------------------------------------ */}
        {rest.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <Eyebrow>Also coming up</Eyebrow>
              <Link href="/events" className="text-xs text-muted hover:text-gold">
                See all events →
              </Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((event) => (
                <EventCard key={event.id} event={event} href={`/events/${event.slug}`} />
              ))}
            </div>
          </section>
        )}

        {/* --- 4. Recently finished --------------------------------- */}
        {finished.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <Eyebrow>Recently finished</Eyebrow>
              <Link href="/events?when=past" className="text-xs text-muted hover:text-gold">
                Archive →
              </Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {finished.slice(0, RECENT_LIMIT).map((event) => (
                <EventCard key={event.id} event={event} href={`/events/${event.slug}`} />
              ))}
            </div>
          </section>
        )}

      </main>
    </div>
  );
}

/**
 * §6.1's live panel: full width, only ever on screen while something is
 * running, and the only part of the hub that is about *now* rather than about
 * the calendar.
 */
function LivePanel({ event }: { event: EventSummary }) {
  return (
    <Panel className="border-ember/40">
      <div className="flex flex-wrap items-center gap-5">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <EventStatusPill status={event.status} />
            <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} />
          </div>
          <h2 className="font-display text-3xl leading-none tracking-wide">
            <Link href={`/events/${event.slug}`} className="hover:text-gold">
              {event.title}
            </Link>
          </h2>
          <p className="mt-2 text-xs text-muted">
            Running now · <EventSeats seats={event.seats} />
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          <Button href={`/events/${event.slug}`} variant="gold">
            Follow it
          </Button>
        </div>
      </div>
    </Panel>
  );
}
