/**
 * `/me` — the member dashboard (docs/platform-plan.md §4).
 *
 * "My next event, open applications, to-dos." Small on purpose: this page's job
 * is to be looked at for four seconds and then left, so it holds the one event
 * that matters next, a list of things only the member can resolve, and the
 * links onward. Anything that needs more than a line belongs on `/me/events`.
 *
 * Every to-do is derived, never stored — the same rule §14 applies to seat
 * counts. A "confirm your attendance" nudge that outlived the confirmation
 * would be worse than no nudge at all.
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
  applicationStatusLabel,
  applicationStatusTone,
  viewerAction,
} from "@/components/events";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Panel,
  StatTile,
  StatusPill,
  plural,
} from "@/components/ui";
import { getEventById, getMyApplications, listEvents } from "@/lib/events";
import { loadProfile } from "@/lib/profile";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your dashboard · Job Centre Events",
};

/** How close an event has to be before "are you still coming?" is a to-do. */
const CONFIRM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export default async function MePage() {
  const user = await requireUser();
  const now = new Date();

  const [mine, upcoming, profile] = await Promise.all([
    getMyApplications(user.id, { now }),
    listEvents({ status: "published", upcoming: true, now }),
    loadProfile(user.id),
  ]);

  const live = mine.filter(
    (row) =>
      (row.status === "accepted" || row.status === "waitlisted") &&
      (row.event.endsAt ?? row.event.startsAt ?? null) !== null &&
      (row.event.endsAt ?? row.event.startsAt ?? now).getTime() >= now.getTime()
  );

  // Soonest first is how `getMyApplications` already sorts, so the next event
  // is simply the first live one.
  const next = live[0] ?? null;
  const nextEvent = next ? await getEventById(next.eventId, { now }) : null;

  /* --- What only they can resolve --------------------------------- */

  const todos: Array<{ label: string; detail: string; href: string; action: string }> = [];

  const requiredMissing = profile.sections.reduce(
    (total, section) => total + section.completeness.missing.length,
    0
  );
  if (requiredMissing > 0) {
    todos.push({
      label: `${plural(requiredMissing, "profile question")} unanswered`,
      detail:
        "Answering them once is what makes every future application three taps — and a missing rank is what stops an entry gate letting you in.",
      href: "/me/profile",
      action: "Fill them in",
    });
  }

  for (const row of live) {
    const event = row.event;
    const starts = event.startsAt;

    if (row.status === "accepted" && row.confirmation === null && starts) {
      if (starts.getTime() - now.getTime() <= CONFIRM_WINDOW_MS) {
        todos.push({
          label: `Confirm you are coming to ${event.title}`,
          detail: "It is close enough that the admin needs to know who is actually turning up.",
          href: "/me/events",
          action: "Answer it",
        });
      }
    }
  }

  const awaitingAvailability = live.filter(
    (row) => Object.keys(row.availability).length === 0
  );
  for (const row of awaitingAvailability) {
    todos.push({
      label: `Say which days you can make ${row.event.title}`,
      detail: "One tap per day, and it is what the running order gets built around.",
      href: "/me/events",
      action: "Set availability",
    });
  }

  const appliedTo = new Set(
    mine
      .filter((row) => row.status !== "withdrawn" && row.status !== "declined")
      .map((row) => row.eventId)
  );
  const open = upcoming.filter(
    (event) => event.applicationsState.open && !appliedTo.has(event.id)
  );

  const name = user.displayName ?? user.name ?? "Member";

  return (
    <div className="min-h-screen">
      <AppHeader section="DASHBOARD" />

      <main className="mx-auto max-w-[1000px] space-y-6 px-4 py-8 sm:px-6">
        {/* --- Who --------------------------------------------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={name} size="lg" />
            <div className="min-w-0">
              <Eyebrow className="mb-1">Signed in</Eyebrow>
              <h1 className="font-display text-4xl leading-none tracking-wide">{name}</h1>
              {user.isAdmin && (
                <p className="mt-2">
                  <Badge tone="gold">Admin</Badge>
                </p>
              )}
            </div>

            <div className="ml-auto flex gap-8">
              <StatTile
                label="Live applications"
                value={live.length}
                valueClassName={live.length > 0 ? "text-signal" : "text-muted"}
              />
              <StatTile
                label="To do"
                value={todos.length}
                valueClassName={todos.length > 0 ? "text-gold" : "text-muted"}
              />
            </div>
          </div>
        </Panel>

        {/* --- My next event ----------------------------------------- */}
        <section className="space-y-3">
          <Eyebrow>Your next event</Eyebrow>

          {next && nextEvent ? (
            <Panel as="article">
              <div className="flex flex-wrap items-start gap-6">
                <div className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <StatusPill
                      status={applicationStatusTone(next.status)}
                      label={
                        next.status === "waitlisted" && next.waitlistPosition !== null
                          ? `Queue #${next.waitlistPosition}`
                          : applicationStatusLabel(next.status)
                      }
                    />
                    <EventStatusPill status={nextEvent.status} />
                  </div>

                  <h2 className="font-display text-3xl leading-none tracking-wide">
                    <Link href={`/events/${nextEvent.slug}`} className="hover:text-gold">
                      {nextEvent.title}
                    </Link>
                  </h2>

                  <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                    <EventDateRange
                      startsAt={nextEvent.startsAt}
                      endsAt={nextEvent.endsAt}
                    />
                    <EventSeats seats={nextEvent.seats} />
                  </div>
                </div>

                <div className="ml-auto space-y-4 text-right">
                  {nextEvent.startsAt && (
                    <StatTile
                      label="Starts in"
                      value={<Countdown to={nextEvent.startsAt} passed="Under way" />}
                    />
                  )}
                  <Button href="/me/events" variant="gold" size="sm">
                    Manage it
                  </Button>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel as="article">
              <EmptyState>
                You have no live applications. Everything currently taking them is below.
              </EmptyState>
              <div className="mt-4">
                <Button href="/events" size="sm">
                  What&apos;s on
                </Button>
              </div>
            </Panel>
          )}
        </section>

        {/* --- Awaiting my attention --------------------------------- */}
        <section className="space-y-3">
          <Eyebrow>Awaiting your attention</Eyebrow>

          {todos.length === 0 ? (
            <Panel as="article">
              <EmptyState>
                Nothing needs you right now. Your profile is filled in and every application
                is answered.
              </EmptyState>
            </Panel>
          ) : (
            <ul className="space-y-2">
              {todos.map((todo) => (
                <li key={`${todo.href}-${todo.label}`}>
                  <Panel padding="sm" className="flex flex-wrap items-center gap-4">
                    <div className="min-w-0">
                      <div className="text-sm text-chalk">{todo.label}</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{todo.detail}</p>
                    </div>
                    <Button href={todo.href} size="sm" className="ml-auto">
                      {todo.action}
                    </Button>
                  </Panel>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Open to apply ----------------------------------------- */}
        {open.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <Eyebrow>Taking applications</Eyebrow>
              <Link href="/events" className="text-xs text-muted hover:text-gold">
                All events →
              </Link>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {open.slice(0, 4).map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  href={`/events/${event.slug}`}
                  footer={
                    <EventAction
                      size="sm"
                      action={viewerAction({
                        slug: event.slug,
                        signedIn: true,
                        state: event.applicationsState,
                        application: null,
                      })}
                    />
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* --- Onward ------------------------------------------------ */}
        <Panel as="section" className="flex flex-wrap items-center gap-3">
          <Eyebrow className="mr-2">Elsewhere</Eyebrow>
          <Button href="/me/events" size="sm">
            My events
          </Button>
          <Button href="/me/profile" size="sm">
            My profile
          </Button>
          <Button href="/events" size="sm">
            All events
          </Button>
          <Button href="/board" size="sm">
            Tournament board
          </Button>
          {user.isAdmin && (
            <Button href="/admin/events" size="sm" className="ml-auto">
              Admin
            </Button>
          )}
        </Panel>
      </main>
    </div>
  );
}
