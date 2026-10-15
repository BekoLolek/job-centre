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
 * `applyToEvent` refuses anybody below `min_rank_to_enter` for whom no manager
 * has waived it (UC-12 2a). Being told "you need Platinum III, you are Gold I"
 * *after* filling a form in is exactly the friction §8.3 exists to remove, so
 * the requirement is on screen before the form is — and when it is not met,
 * instead of it. The message is the gate's own
 * (`eligibility().enterReason`), so the page and the write can never disagree
 * about why.
 *
 * **Both** rules are listed, each with this member's standing against it
 * (UC-12 2) — the captain rule included, because it is the one that matters
 * most to somebody who came to lead a team and it used to be something they
 * learned about from a manager after they had applied. A rule a waiver has
 * opened (R-59) says so in those words: "waived for you" is a different fact
 * from "you clear it", and the member is entitled to know which one is keeping
 * them in.
 *
 * ## Everything else that would waste their time is also checked first
 *
 * Signups not open, already applied, previously declined: each gets its own
 * panel saying so, with somewhere to go next. A form you can fill in and cannot
 * submit is the worst of the available options.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
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
import {
  Alert,
  Badge,
  Button,
  Eyebrow,
  Page,
  Panel,
  StatTile,
} from "@/components/ui";
import { getEventBySlug, loadApplicationForm } from "@/lib/events";
import { entryMode } from "@/lib/events-policy";
import { canSeeEvent } from "@/lib/hosting";
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
  if (!(await canSeeEvent(user, event))) notFound();

  const form = await loadApplicationForm(event.id, user.id, { now });
  if (!form) notFound();

  const application = form.application;
  // `pending` counts: an approval event's application (R-27) is very much
  // alive — it is not holding a seat, but it is the application the organisers
  // will read, and its answers are still the member's to change.
  const live =
    application !== null &&
    (application.status === "pending" ||
      application.status === "accepted" ||
      application.status === "waitlisted");

  const days: ApplyDay[] = event.days.map((day) => ({
    id: day.id,
    dayIndex: day.dayIndex,
    label: day.label,
    startsAt: day.startsAt ? day.startsAt.toISOString() : null,
  }));

  const declined = application?.status === "declined";
  const blocked = !form.eligibility.canEnter;

  /*
   * Both of §8.3's rules, and this member's standing against each (UC-12 2).
   *
   * The entry rule used to be the only one on this page, which made the
   * captain rule something a member found out about from a manager after
   * applying — and it is the rule most likely to matter to somebody who came
   * to captain a team. Only rules the event actually sets are listed: a row
   * saying "no minimum" is noise, and an event with neither drops the panel.
   *
   * Every verdict is `form.eligibility`'s, so this page and `applyToEvent`
   * cannot disagree about who is in — including when the reason they are in is
   * a waiver (R-59), which gets its own wording rather than being painted as
   * though they met the bar.
   */
  const rules = [
    {
      label: "To enter",
      minRank: event.minRankToEnter,
      met: form.eligibility.enterCheck.ok,
      waived: form.eligibility.enterWaived,
      message: form.eligibility.enterWaived
        ? form.eligibility.enterReason
        : form.eligibility.enterCheck.message,
    },
    {
      label: "To captain",
      minRank: event.minRankToCaptain,
      met: form.eligibility.captainCheck.ok,
      waived: form.eligibility.captainWaived,
      message: form.eligibility.captainWaived
        ? form.eligibility.captainReason
        : form.eligibility.captainCheck.message,
    },
  ].filter((rule): rule is typeof rule & { minRank: string } => Boolean(rule.minRank));
  /** The reason applications are shut, or null when they are open. */
  const closedBecause = form.state.open ? null : form.state.message;
  /** Open, but every seat is taken — so this application joins the queue (§14). */
  const willWaitlist = form.state.open && form.state.willWaitlist;
  /**
   * How this event's applications land (R-27). An approval event gives neither
   * a seat nor a place in the queue, so every sentence on this page that
   * promises one has to know about it.
   */
  const mode = entryMode(event.config);

  return (
    <div className="min-h-screen">
      <AppHeader />

      <Page className="space-y-5">
        <nav className="text-12 text-muted">
          <Link href={`/events/${event.slug}`} className="hover:text-union">
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
                {event.game && <Badge tone="union">{event.game.name}</Badge>}
              </div>

              <Eyebrow className="mb-2">Applying to</Eyebrow>
              <h1 className="font-display text-36 leading-none">
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

        {/* --- Both entry rules, said before anything is filled in ---- */}
        {rules.length > 0 && (
          <Panel as="section" className={blocked ? "border-flare/50" : undefined}>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Eyebrow>{rules.length === 1 ? "Entry requirement" : "Entry requirements"}</Eyebrow>
              <span className="text-14 text-muted">
                Your recorded rank:{" "}
                <span className={form.rank ? "text-chalk" : "text-muted"}>
                  {form.rank ?? "not set"}
                </span>
              </span>
            </div>

            <dl className="mt-3 space-y-2 border-t border-hair pt-3">
              {rules.map((rule) => (
                <div key={rule.label} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <dt className="eyebrow min-w-[9rem] text-chalk/70">{rule.label}</dt>
                  <dd className="min-w-0 flex-1 text-14">
                    <span className="text-union">{rule.minRank}</span> or above
                    <span className="mt-1 block text-12 leading-relaxed text-muted">
                      {rule.message}
                    </span>
                  </dd>
                  <dd
                    className={
                      rule.waived
                        ? "text-14 text-union"
                        : rule.met
                          ? "text-14 text-success"
                          : "text-14 text-flare"
                    }
                  >
                    {rule.waived ? "✓ Waived for you" : rule.met ? "✓ You clear it" : "✕ Below the bar"}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        )}

        {/* --- Why they cannot apply, if they cannot ------------------ */}
        {declined ? (
          <Panel as="section">
            <Eyebrow className="mb-3 text-flare">
              {applicationStatusLabel("declined")}
            </Eyebrow>
            <h2 className="font-display text-30 leading-none">
              This one was declined
            </h2>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              An admin decided against this application, so it cannot be re-submitted here.
              Have a word with them in Discord if that looks wrong — they can accept you
              from the applicant list at any time.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events">Other events</Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : live ? (
          /*
           * They are already in, so this page is where they change their mind
           * about an answer (R-53 / UC-13 3) — the same form, the same writes,
           * because a second form over the same questions is a second set of
           * rules about them.
           *
           * The entry gate is deliberately **not** consulted on this branch.
           * `blocked` belongs to somebody who cannot apply; a member who is
           * already in and has since slipped below the bar is a decision for a
           * manager (UC-14), not a reason to stop them fixing a typo — and
           * `editApplicationAnswers` moves no seat, so there is nothing for the
           * gate to protect here.
           */
          <>
            {form.canEditAnswers ? (
              <>
                <Alert tone="union">
                  <span className="block font-medium">
                    {application.status === "accepted"
                      ? "You're in — this is your application"
                      : application.status === "waitlisted"
                        ? "You are in the queue — this is your application"
                        : "Awaiting review — this is your application"}
                  </span>
                  <span className="mt-1 block opacity-90">
                    Change anything you like until sign-ups close. Your place does not move:
                    answers are not a decision about a seat. Withdrawing is on{" "}
                    <Link href="/me/events" className="underline underline-offset-4">
                      My events
                    </Link>
                    , and that stays open even after this does.
                  </span>
                </Alert>

                <ApplyForm
                  eventId={event.id}
                  slug={event.slug}
                  mode="edit"
                  profile={form.profile}
                  questions={form.questions}
                  days={days}
                  rankLadder={event.rankLadder}
                  availability={form.availability}
                  willWaitlist={willWaitlist}
                  entryMode={mode}
                />
              </>
            ) : (
              /*
               * UC-13 4a: sign-ups have closed, so the answers stand. Saying so
               * is the honest version of hiding the form — and the sentence
               * names the one thing that has *not* closed, because R-54 and
               * UC-13 extensions E3 keep withdrawing open and that is the whole
               * reason locking the answers is acceptable.
               */
              <Panel as="section">
                <Eyebrow className="mb-3">Answers closed</Eyebrow>
                <h2 className="font-display text-30 leading-none">
                  These answers stand
                </h2>
                <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
                  Sign-ups for this event have closed, so what you answered is what the
                  organisers are working from — the running order gets built on answers
                  that will not move. If you can no longer make it, withdrawing still
                  works, and it frees your seat for whoever is waiting.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button href="/me/events" variant="union">
                    My events
                  </Button>
                  <Button href={`/events/${event.slug}`}>Back to the event</Button>
                </div>
              </Panel>
            )}
          </>
        ) : closedBecause ? (
          <Panel as="section">
            <Eyebrow className="mb-3">Not taking applications</Eyebrow>
            <h2 className="font-display text-30 leading-none">
              {closedBecause.toUpperCase()}
            </h2>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              Nothing you can do from here. Everything currently taking applications is on
              the events page.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events" variant="union">
                What&apos;s open
              </Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : blocked ? (
          <Panel as="section">
            <Eyebrow className="mb-3 text-flare">You cannot apply to this one yet</Eyebrow>
            <h2 className="font-display text-30 leading-none">
              {form.eligibility.enterCheck.reason === "no_rank"
                ? "Your rank isn't set"
                : "Below the entry rank"}
            </h2>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              {form.eligibility.enterReason} Rank is a two-tap picker on your profile and it
              is remembered, so this is a one-time job rather than something to retype every
              event.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/me/profile" variant="union">
                Update my profile
              </Button>
              <Button href={`/events/${event.slug}`}>Back to the event</Button>
            </div>
          </Panel>
        ) : (
          <>
            {application?.status === "withdrawn" && (
              <Alert tone="union">
                <span className="block font-medium">You withdrew from this one before</span>
                <span className="mt-1 block opacity-90">
                  {mode === "approval"
                    ? "Applying again is fine. Your old answers are still here — the new application goes back to the organisers for review, so it holds no seat and no place in a queue until one of them decides."
                    : "Applying again is fine. Your old answers are still here — you would join at the back of whatever queue exists now, which is what first-come means."}
                </span>
              </Alert>
            )}

            {willWaitlist && (
              <Alert tone="union">
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
              mode="apply"
              profile={form.profile}
              questions={form.questions}
              days={days}
              rankLadder={event.rankLadder}
              availability={form.availability}
              willWaitlist={willWaitlist}
              entryMode={mode}
            />
          </>
        )}
      </Page>
    </div>
  );
}
