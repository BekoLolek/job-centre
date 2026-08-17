/**
 * `/events/[slug]/apply` — the application (docs/platform-plan.md §2, §4, §8.3).
 *
 * The page the project exists to make painless. Everything on it comes from one
 * read: `loadApplicationForm` assembles the event, whether it is taking
 * applications and why not, whether this member clears the rank gate, and every
 * question already carrying either their previous answer or the one sitting on
 * their profile.
 *
 * ## The gate is shown before the form, never after it
 *
 * `applyToEvent` refuses anybody below `min_rank_to_enter`. Being told "you
 * need Platinum III, you are Gold I" *after* filling a form in is exactly the
 * friction §8.3 exists to remove, so the requirement is on screen before the
 * form is — and when it is not met, instead of it. The message is the gate's
 * own (`eligibility().enterReason`), so the page and the write can never
 * disagree about why.
 *
 * ## Everything else that would waste their time is also checked first
 *
 * Signups not open, already applied, previously declined: each gets its own
 * panel saying so, with somewhere to go next. A form you can fill in and cannot
 * submit is the worst of the available options.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import ApplyForm, { type ApplyDay } from "@/components/apply/ApplyForm";
import {
  ApplicationsPill,
  Countdown,
  EventDateRange,
  EventSeats,
  EventStatusPill,
  applicationStatusLabel,
  eventTypeLabel,
} from "@/components/events";
import { Alert, Badge, Button, Eyebrow, Panel, StatTile } from "@/components/ui";
import { getEventBySlug, loadApplicationForm } from "@/lib/events";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  return { title: event ? `Apply · ${event.title}` : "Apply · Job Centre Events" };
}

export default async function ApplyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Signing in is the one thing this page needs that the rest of the public
  // side does not. Everything before this point on the journey was readable
  // signed out (§2: invited to sign in only at the point of applying).
  const user = await requireUser();

  const now = new Date();
  const event = await getEventBySlug(slug, { now });
  if (!event) notFound();
  if (event.status === "draft" && !user.isAdmin) notFound();

  const form = await loadApplicationForm(event.id, user.id, { now });
  if (!form) notFound();

  const application = form.application;
  const live =
    application && (application.status === "accepted" || application.status === "waitlisted");

  // Someone with a live application has nothing to do here; `applyToEvent`
  // would refuse it. Their page is `/me/events`, where they can change
  // availability, confirm attendance or withdraw.
  if (live) redirect("/me/events");

  const days: ApplyDay[] = event.days.map((day) => ({
    id: day.id,
    dayIndex: day.dayIndex,
    label: day.label,
    startsAt: day.startsAt ? day.startsAt.toISOString() : null,
  }));

  const declined = application?.status === "declined";
  const blocked = !form.eligibility.canEnter;
  /** The reason applications are shut, or null when they are open. */
  const closedBecause = form.state.open ? null : form.state.message;
  /** Open, but every seat is taken — so this application joins the queue (§14). */
  const willWaitlist = form.state.open && form.state.willWaitlist;

  return (
    <div className="min-h-screen">
      <AppHeader section="EVENTS" />

      <main className="mx-auto max-w-[900px] space-y-5 px-4 py-8 sm:px-6">
        <nav className="text-xs text-muted">
          <Link href={`/events/${event.slug}`} className="hover:text-gold">
            ← {event.title}
          </Link>
        </nav>

        {/* --- Which event, and how much of it is left ---------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <EventStatusPill status={event.status} />
                <ApplicationsPill state={form.state} />
                <Badge>{eventTypeLabel(event.type)}</Badge>
                {event.game && <Badge tone="gold">{event.game.name}</Badge>}
              </div>

              <Eyebrow className="mb-2">Applying to</Eyebrow>
              <h1 className="font-display text-4xl leading-none tracking-wide">
                {event.title}
              </h1>

              <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} />
                <EventSeats seats={event.seats} />
              </div>
            </div>

            {form.state.open && form.state.closesAt && (
              <StatTile
                className="ml-auto text-right"
                label="Applications close in"
                value={<Countdown to={form.state.closesAt} passed="Closed" />}
              />
            )}
          </div>
        </Panel>

        {/* --- The entry rule, said before anything is filled in ------ */}
        {event.minRankToEnter && (
          <Panel as="section" className={blocked ? "border-ember/50" : undefined}>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Eyebrow>Entry requirement</Eyebrow>
              <span className="text-sm">
                <span className="text-gold">{event.minRankToEnter}</span> or above
              </span>
              <span className="text-sm text-muted">
                Your recorded rank:{" "}
                <span className={blocked ? "text-ember" : "text-signal"}>
                  {form.rank ?? "not set"}
                </span>
              </span>
              <span className={blocked ? "ml-auto text-ember" : "ml-auto text-signal"}>
                {blocked ? "✕ Below the bar" : "✓ You clear it"}
              </span>
            </div>
            <p className="mt-3 border-t border-hair pt-3 text-xs leading-relaxed text-muted">
              {form.eligibility.enterCheck.message}
            </p>
          </Panel>
        )}

        {/* --- Why they cannot apply, if they cannot ------------------ */}
        {declined ? (
          <Panel as="section">
            <Eyebrow className="mb-3 text-ember">
              {applicationStatusLabel("declined")}
            </Eyebrow>
            <h2 className="font-display text-3xl leading-none tracking-wide">
              THIS ONE WAS DECLINED
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              An admin decided against this application, so it cannot be re-submitted here.
              Have a word with them in Discord if that looks wrong — they can accept you
              from the applicant list at any time.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events">Other events</Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : closedBecause ? (
          <Panel as="section">
            <Eyebrow className="mb-3">Not taking applications</Eyebrow>
            <h2 className="font-display text-3xl leading-none tracking-wide">
              {closedBecause.toUpperCase()}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Nothing you can do from here. Everything currently taking applications is on
              the events page.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events" variant="gold">
                What&apos;s open
              </Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : blocked ? (
          <Panel as="section">
            <Eyebrow className="mb-3 text-ember">You cannot apply to this one yet</Eyebrow>
            <h2 className="font-display text-3xl leading-none tracking-wide">
              {form.eligibility.enterCheck.reason === "no_rank"
                ? "YOUR RANK ISN'T SET"
                : "BELOW THE ENTRY RANK"}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              {form.eligibility.enterReason} Rank is a two-tap picker on your profile and it
              is remembered, so this is a one-time job rather than something to retype every
              event.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/me/profile" variant="gold">
                Update my profile
              </Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : (
          <>
            {application?.status === "withdrawn" && (
              <Alert tone="gold">
                <span className="block font-medium">You withdrew from this one before</span>
                <span className="mt-1 block opacity-90">
                  Applying again is fine. Your old answers are still here — you would join
                  at the back of whatever queue exists now, which is what first-come means.
                </span>
              </Alert>
            )}

            {willWaitlist && (
              <Alert tone="gold">
                <span className="block font-medium">Every seat is taken</span>
                <span className="mt-1 block opacity-90">
                  You can still apply — it joins the waitlist, and everybody moves up
                  automatically when somebody withdraws.
                </span>
              </Alert>
            )}

            <ApplyForm
              eventId={event.id}
              slug={event.slug}
              questions={form.questions}
              days={days}
              rankLadder={event.rankLadder}
              availability={form.availability}
              willWaitlist={willWaitlist}
            />
          </>
        )}
      </main>
    </div>
  );
}
