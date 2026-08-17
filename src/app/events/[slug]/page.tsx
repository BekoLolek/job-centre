/**
 * `/events/[slug]` — the event page (docs/platform-plan.md §6.2).
 *
 * Header, then tabs: what it is, when it runs, where it is in its life, who is
 * in, and the primary action *for the person reading it* — Apply, You're in,
 * You're #3 in the queue, Sign in to apply, or Applications closed with the
 * reason it closed. Every one of those sentences comes from
 * `applicationsOpen()` and `viewerAction()`; nothing on this page decides a
 * rule of its own.
 *
 * **Tabs appear only when they have something in them.** A Jackbox night has no
 * bracket, so it never shows a bracket tab (§8.1's capability set, made
 * literal); an event with one day and no applicants yet is a single page with
 * no tab strip at all, because a row of tabs where two are empty is worse than
 * no tabs.
 *
 * No session is required to read any of this. A draft is the one exception: it
 * is invisible to everyone but an admin, and answers 404 rather than 403 —
 * members must not be able to learn that an unpublished event exists.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import {
  Countdown,
  EventAction,
  EventDateRange,
  EventSeats,
  EventStatusPill,
  ApplicationsPill,
  eventStatusMeaning,
  eventTypeLabel,
  formatSummary,
  viewerAction,
} from "@/components/events";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Panel,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import {
  type EventDetail,
  getApplicationsForEvent,
  getEventBySlug,
  loadApplicationForm,
} from "@/lib/events";
import { fieldTypeInfo } from "@/lib/profile-fields";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  if (!event || event.status === "draft") return { title: "Event · Job Centre Events" };
  return {
    title: `${event.title} · Job Centre Events`,
    description: event.description ?? undefined,
  };
}

type Tab = "overview" | "who" | "schedule";

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const now = new Date();

  const [event, user] = await Promise.all([getEventBySlug(slug, { now }), getCurrentUser()]);
  if (!event) notFound();
  // A draft does not exist as far as anybody but an admin is concerned.
  if (event.status === "draft" && !user?.isAdmin) notFound();

  // Only signed-in readers need the second read: it is their application and
  // their rank check. A visitor's action is decided by the clock alone.
  const mine = user ? await loadApplicationForm(event.id, user.id, { now }) : null;
  const applicants = await getApplicationsForEvent(event.id);

  const action = viewerAction({
    slug: event.slug,
    signedIn: Boolean(user),
    state: event.applicationsState,
    application: mine?.application ?? null,
    eligibility: mine?.eligibility ?? null,
  });

  const accepted = applicants.filter((row) => row.status === "accepted");
  const queued = applicants.filter((row) => row.status === "waitlisted");

  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    { value: "overview", label: "Overview" },
  ];
  if (accepted.length + queued.length > 0) {
    tabs.push({ value: "who", label: "Who's in", count: accepted.length });
  }
  if (event.days.length > 0) {
    tabs.push({ value: "schedule", label: "Schedule", count: event.days.length });
  }

  const raw = (await searchParams).tab;
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  const tab: Tab = tabs.some((entry) => entry.value === wanted) ? (wanted as Tab) : "overview";

  return (
    <div className="min-h-screen">
      <AppHeader section="EVENTS" />

      <main className="mx-auto max-w-[1100px] space-y-6 px-4 py-8 sm:px-6">
        <nav className="text-xs text-muted">
          <Link href="/events" className="hover:text-gold">
            ← All events
          </Link>
        </nav>

        {event.status === "draft" && (
          <Alert tone="gold">
            <span className="block font-medium">This event is still a draft</span>
            <span className="mt-1 block opacity-90">
              {eventStatusMeaning("draft")} Publish it from{" "}
              <Link
                href={`/admin/events/${event.id}`}
                className="text-gold underline underline-offset-4"
              >
                the editor
              </Link>
              .
            </span>
          </Alert>
        )}

        {/* --- Header ----------------------------------------------- */}
        <Panel as="header" padding="none" className="overflow-hidden rise">
          {event.bannerUrl && (
            <div
              aria-hidden
              className="h-24 w-full border-b border-hair bg-raised bg-cover bg-center"
              style={{ backgroundImage: `url(${JSON.stringify(event.bannerUrl)})` }}
            />
          )}

          <div className="grid gap-6 p-6 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <EventStatusPill status={event.status} />
                <ApplicationsPill state={event.applicationsState} />
                <Badge>{eventTypeLabel(event.type)}</Badge>
                {event.game && <Badge tone="gold">{event.game.name}</Badge>}
              </div>

              <h1 className="font-display text-5xl leading-[0.9] tracking-wide">{event.title}</h1>

              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <EventDateRange
                  startsAt={event.startsAt}
                  endsAt={event.endsAt}
                  className="text-sm"
                />
                <EventSeats seats={event.seats} size="md" />
              </div>
            </div>

            <div className="space-y-5 border-t border-hair pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              {event.startsAt && (
                <StatTile
                  label="Starts in"
                  value={<Countdown to={event.startsAt} passed="Under way" />}
                />
              )}
              {event.applicationsState.open && event.applicationsState.closesAt && (
                <StatTile
                  label="Applications close in"
                  value={
                    <Countdown
                      to={event.applicationsState.closesAt}
                      passed="Closed"
                      className="text-chalk/80"
                    />
                  }
                />
              )}

              <EventAction action={action} />
            </div>
          </div>
        </Panel>

        {/* --- Tabs, only when there is more than one --------------- */}
        {tabs.length > 1 && (
          <div className="flex flex-wrap border border-hair">
            {tabs.map((entry) => (
              <Link
                key={entry.value}
                href={
                  entry.value === "overview"
                    ? `/events/${event.slug}`
                    : `/events/${event.slug}?tab=${entry.value}`
                }
                className={cx(
                  "btn border-0",
                  tab === entry.value ? "bg-gold/10 text-gold" : "bg-transparent text-muted"
                )}
              >
                {entry.label}
                {entry.count !== undefined && (
                  <span className="ml-2 opacity-70">{entry.count}</span>
                )}
              </Link>
            ))}
          </div>
        )}

        {tab === "overview" && <Overview event={event} accepted={accepted.length} />}

        {tab === "who" && (
          <Panel as="section">
            <Eyebrow className="mb-4">
              Who&apos;s in · {plural(accepted.length, "member")}
            </Eyebrow>

            {accepted.length === 0 ? (
              <EmptyState>
                Nobody has a seat yet. The first application to arrive takes one.
              </EmptyState>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {accepted.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center gap-3 border border-hair bg-raised px-3 py-2"
                  >
                    <Avatar name={row.member.displayName ?? "Member"} size="sm" />
                    <span className="min-w-0 truncate text-sm">
                      {row.member.displayName ?? "Unknown member"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {queued.length > 0 && (
              <p className="mt-5 border-t border-hair pt-4 text-xs text-muted">
                {plural(queued.length, "person", "people")} waiting in the queue. Places are
                first come, and everyone moves up automatically when a seat frees.
              </p>
            )}
          </Panel>
        )}

        {tab === "schedule" && (
          <Panel as="section">
            <Eyebrow className="mb-4">Running order</Eyebrow>
            <ol className="space-y-2">
              {event.days.map((day) => (
                <li
                  key={day.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-hair bg-raised px-4 py-3"
                >
                  <span className="eyebrow">Day {day.dayIndex + 1}</span>
                  <span className="text-sm">{day.label ?? `Day ${day.dayIndex + 1}`}</span>
                  <EventDateRange
                    startsAt={day.startsAt}
                    fallback="Time to be confirmed"
                    className="ml-auto"
                  />
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted">
              Times are shown in your own timezone. Applicants say which days they can make;
              the running order for matches arrives with the format engine.
            </p>
          </Panel>
        )}
      </main>
    </div>
  );
}

/** The Overview tab: what it is, the format in plain words, and who may enter. */
function Overview({ event, accepted }: { event: EventDetail; accepted: number }) {
  const summary = formatSummary({
    type: event.type,
    config: event.config,
    days: event.days.length,
    capacity: event.capacity,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-6">
        <Panel as="section">
          <Eyebrow className="mb-3">What this is</Eyebrow>
          {event.description ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-chalk/85">
              {event.description}
            </p>
          ) : (
            <EmptyState>
              No description yet. The dates and the format below are the whole story for now.
            </EmptyState>
          )}

          <div className="mt-5 flex flex-wrap gap-2 border-t border-hair pt-4">
            {summary.map((part) => (
              <Badge key={part}>{part}</Badge>
            ))}
          </div>
        </Panel>

        {event.questions.length > 0 && (
          <Panel as="section">
            <Eyebrow className="mb-3">What the application asks</Eyebrow>
            <ul className="space-y-2">
              {event.questions.map((question) => (
                <li
                  key={question.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair/60 pb-2 last:border-0"
                >
                  <span className="text-sm">{question.label}</span>
                  <span className="eyebrow">{fieldTypeInfo(question.type).label}</span>
                  {question.required && <Badge tone="gold">Required</Badge>}
                  {question.profileFieldId && (
                    <span className="ml-auto text-xs text-signal">
                      Already on your profile
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs leading-relaxed text-muted">
              Anything marked <span className="text-signal">already on your profile</span>{" "}
              arrives filled in — you confirm it rather than typing it again.
            </p>
          </Panel>
        )}
      </div>

      <div className="space-y-6">
        <Panel as="section">
          <Eyebrow className="mb-4">Getting in</Eyebrow>

          <dl className="space-y-4 text-sm">
            <Line label="Seats">
              <EventSeats seats={event.seats} />
            </Line>
            <Line label="Taken">
              {accepted === 0 ? "Nobody yet" : plural(accepted, "member")}
            </Line>
            <Line label="Signups open">
              <EventDateRange startsAt={event.signupOpensAt} fallback="As soon as published" />
            </Line>
            <Line label="Signups close">
              <EventDateRange
                startsAt={event.signupClosesAt}
                fallback="When the event starts"
              />
            </Line>
            {event.minRankToEnter && (
              <Line label="Minimum rank">
                <span className="text-gold">{event.minRankToEnter}</span>
              </Line>
            )}
            {event.minRankToCaptain && (
              <Line label="To captain">
                <span className="text-gold">{event.minRankToCaptain}</span>
              </Line>
            )}
          </dl>

          {event.minRankToEnter && (
            <p className="mt-5 border-t border-hair pt-4 text-xs leading-relaxed text-muted">
              Rank comes from your profile, so it is checked before you fill anything in. If
              yours has moved,{" "}
              <Link href="/me/profile" className="text-gold underline underline-offset-4">
                update it first
              </Link>
              .
            </p>
          )}
        </Panel>

        <Panel as="section">
          <Eyebrow className="mb-3">Status</Eyebrow>
          <p className="text-xs leading-relaxed text-muted">
            {eventStatusMeaning(event.status)}
          </p>
          <div className="mt-4">
            <Button href="/events" size="sm">
              All events
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="eyebrow w-28 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 text-chalk/85">{children}</dd>
    </div>
  );
}
