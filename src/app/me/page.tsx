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
import { confirmationTodo } from "@/components/me/todos";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Page,
  Panel,
  Section,
  StatTile,
  StatusPill,
  plural,
} from "@/components/ui";
import { getEventById, getMyApplications, listEvents } from "@/lib/events";
import { handleOf } from "@/lib/players";
import { loadProfile } from "@/lib/profile";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your dashboard · Job Centre Events",
};

/**
 * How close an event has to be before "are you still coming?" is a to-do.
 *
 * Seven days, against R-200's two-day deadline, so the nudge has five days on
 * screen before the answer closes — and it is a ceiling, not a schedule: the
 * loop below stops showing it the moment the answer can no longer be given.
 */
const CONFIRM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export default async function MePage() {
  const user = await requireUser();
  const now = new Date();

  const [mine, upcoming, profile, handle] = await Promise.all([
    getMyApplications(user.id, { now }),
    listEvents({ status: "published", upcoming: true, now }),
    loadProfile(user.id),
    // Assigns one if they have not got it yet, so the link below always works.
    handleOf(user.id),
  ]);

  // An application still going somewhere: a seat, a place in the queue, or an
  // approval event's manager who has not decided yet (R-27). The pill says
  // which, and the to-dos below ask only for what that status can answer.
  const live = mine.filter(
    (row) =>
      (row.status === "pending" ||
        row.status === "accepted" ||
        row.status === "waitlisted") &&
      (row.event.endsAt ?? row.event.startsAt ?? null) !== null &&
      (row.event.endsAt ?? row.event.startsAt ?? now).getTime() >= now.getTime()
  );

  // Soonest first is how `getMyApplications` already sorts, so the next event
  // is simply the first live one.
  const next = live[0] ?? null;
  const nextEvent = next ? await getEventById(next.eventId, { now }) : null;

  /* --- What only they can resolve --------------------------------- */

  const todos: Array<{ label: string; detail: string; href: string; action: string }> = [];

  /*
   * UC-13 2's first kind of to-do: a question this application needs and
   * cannot get on its own — a required answer that is not there, or one the
   * question has changed out from under (`detailAttention`). Named per event,
   * because "a question changed" is only worth saying next to the event that
   * is asking it, and it links to that event's own form where the answer can
   * be given.
   *
   * A **retired** question never appears here. That is `detailAttention`'s
   * doing, not this page's, and it has to be: a question an admin has stopped
   * asking has no row on the form this to-do links to, so it would be a job
   * with nowhere to do it (R-09, UC-03 5a).
   */
  const changed = new Set<string>();
  for (const row of live) {
    const stale = row.outstanding.filter((item) => item.why === "stale");
    const blank = row.outstanding.filter((item) => item.why === "missing");
    for (const item of row.outstanding) {
      if (item.where === "profile") changed.add(item.id);
    }

    if (stale.length > 0) {
      todos.push({
        label: `${plural(stale.length, "question")} changed on ${row.event.title}`,
        detail: `Your answer to ${stale.map((item) => item.label).join(", ")} cannot be read against the question as it now stands. Your old answer is still saved — answering again replaces it.`,
        href: `/events/${row.event.slug}/apply`,
        action: "Answer it again",
      });
    }
    if (blank.length > 0) {
      todos.push({
        label: `${plural(blank.length, "answer")} missing for ${row.event.title}`,
        detail: `${blank.map((item) => item.label).join(", ")} — this event asks for it, and the organisers are reading your application without it.`,
        href: `/events/${row.event.slug}/apply`,
        action: "Fill it in",
      });
    }
  }

  // The same nudge for the rest of the profile — the questions no open
  // application has already named above, so one missing rank does not produce
  // two to-dos saying the same thing. Counted from `attention` rather than from
  // `completeness`, so an answer a question has outgrown counts too.
  const requiredMissing = profile.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.attention !== null && !changed.has(field.id)).length;
  if (requiredMissing > 0) {
    todos.push({
      label: `${plural(requiredMissing, "profile question")} unanswered`,
      detail:
        "Answering them once is what makes every future application three taps — and a missing rank is what stops an entry gate letting you in.",
      href: "/me/profile",
      action: "Fill them in",
    });
  }

  // Whether each seat still owes an answer, and which kind — the rule is in
  // `confirmationTodo` (R-199, R-200), which is also where the reasoning for
  // the two new cases is written down.
  for (const row of live) {
    const event = row.event;
    const todo = confirmationTodo({
      status: row.status,
      confirmation: row.confirmation,
      startsAt: event.startsAt,
      within: CONFIRM_WINDOW_MS,
      now,
    });

    if (todo === "answer") {
      todos.push({
        label: `Confirm you are coming to ${event.title}`,
        detail: "It is close enough that the admin needs to know who is actually turning up.",
        href: "/me/events",
        action: "Answer it",
      });
    } else if (todo === "settle") {
      todos.push({
        label: `Settle whether you are coming to ${event.title}`,
        detail:
          "You said you were not sure. Your seat is still yours, and nothing will take it — but the running order is built from who is actually coming, and only you can turn this into a yes or a no.",
        href: "/me/events",
        action: "Settle it",
      });
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
      <AppHeader />

      <Page className="space-y-6">
        {/* --- Who --------------------------------------------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={name} size="lg" />
            <div className="min-w-0">
              <Eyebrow className="mb-1">Signed in</Eyebrow>
              <h1 className="font-display text-36 leading-none">{name}</h1>
              <p className="mt-2 flex flex-wrap items-center gap-2">
                {user.isAdmin && <Badge tone="union">Admin</Badge>}
                {handle && (
                  <Link href={`/players/${handle}`} className="text-12 text-muted hover:text-union">
                    Your public profile → /players/{handle}
                  </Link>
                )}
              </p>
            </div>

            <div className="ml-auto flex gap-8">
              <StatTile
                label="Live applications"
                value={live.length}
                valueClassName={live.length > 0 ? "text-body" : "text-muted"}
              />
              <StatTile
                label="To do"
                value={todos.length}
                valueClassName={todos.length > 0 ? "text-union" : "text-muted"}
              />
            </div>
          </div>
        </Panel>

        <div>
          {/* --- My next event --------------------------------------- */}
          <Section
            first
            icon="calendar"
            title="Your next event"
            description="The soonest thing you hold a seat or a queue place for."
          >
            {next && nextEvent ? (
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

                  <h3 className="font-display text-30 leading-none">
                    <Link href={`/events/${nextEvent.slug}`} className="hover:text-union">
                      {nextEvent.title}
                    </Link>
                  </h3>

                  <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                    <EventDateRange startsAt={nextEvent.startsAt} endsAt={nextEvent.endsAt} />
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
                  <Button href="/me/events" variant="union" size="sm">
                    Manage it
                  </Button>
                </div>
              </div>
            ) : (
              <div className="py-4">
                <EmptyState>
                  You have no live applications. Everything currently taking them is below.
                </EmptyState>
                <div className="mt-4">
                  <Button href="/events" size="sm">
                    What&apos;s on
                  </Button>
                </div>
              </div>
            )}
          </Section>

          {/* --- Every open application ------------------------------ */}
          {live.length > 0 && (
            <Section
              icon="list"
              title="Your open applications"
              description="Where each one stands. A queue number is your place in it, and you move up on your own."
              aside={
                <Link href="/me/events" className="text-12 text-muted hover:text-union">
                  Manage them →
                </Link>
              }
            >
              <ul className="divide-y divide-hair/60">
                {live.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-4 py-4">
                    <StatusPill
                      status={applicationStatusTone(row.status)}
                      label={
                        // R-52 in one line: in, queued — and *where* in the
                        // queue, because "waitlisted" without a number tells
                        // somebody nothing about whether to make other plans.
                        row.status === "waitlisted" && row.waitlistPosition !== null
                          ? `Queue #${row.waitlistPosition}`
                          : applicationStatusLabel(row.status)
                      }
                    />
                    <div className="min-w-0">
                      <Link
                        href={`/events/${row.event.slug}`}
                        className="text-14 text-chalk hover:text-union"
                      >
                        {row.event.title}
                      </Link>
                      <div className="mt-1">
                        <EventDateRange
                          startsAt={row.event.startsAt}
                          endsAt={row.event.endsAt}
                          fallback="Date to be confirmed"
                        />
                      </div>
                    </div>
                    {row.outstanding.length > 0 && (
                      <Badge tone="union">
                        {plural(row.outstanding.length, "answer")} needed
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* --- Awaiting my attention ------------------------------- */}
          <Section
            icon="flag"
            title="Awaiting your attention"
            description="Things only you can resolve. Each one is worked out as the page loads, so it goes the moment you deal with it."
          >
            {todos.length === 0 ? (
              <div className="py-4">
                <EmptyState>
                  Nothing needs you right now. Your profile is filled in and every
                  application is answered.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-hair/60">
                {todos.map((todo) => (
                  <li
                    key={`${todo.href}-${todo.label}`}
                    className="flex flex-wrap items-center gap-4 py-5"
                  >
                    <div className="min-w-0">
                      <div className="text-14 text-chalk">{todo.label}</div>
                      <p className="mt-1 text-12 leading-relaxed text-muted">{todo.detail}</p>
                    </div>
                    <Button href={todo.href} size="sm" className="ml-auto">
                      {todo.action}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* --- Open to apply --------------------------------------- */}
          {open.length > 0 && (
            <Section
              icon="spark"
              title="Taking applications"
              description="Open right now, and you have not applied to any of these yet."
              aside={
                <Link href="/events" className="text-12 text-muted hover:text-union">
                  All events →
                </Link>
              }
            >
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
            </Section>
          )}

          {/* --- Onward ---------------------------------------------- */}
          <Section
            icon="grid"
            title="Elsewhere"
            description="The rest of your side of the site."
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button href="/me/events" size="sm">
                My events
              </Button>
              <Button href="/me/profile" size="sm">
                My profile
              </Button>
              {handle && (
                <Button href={`/players/${handle}`} size="sm">
                  Public profile
                </Button>
              )}
              <Button href="/events" size="sm">
                All events
              </Button>
              {user.isAdmin && (
                <Button href="/admin" size="sm" className="ml-auto">
                  Admin
                </Button>
              )}
            </div>
          </Section>
        </div>
      </Page>
    </div>
  );
}
