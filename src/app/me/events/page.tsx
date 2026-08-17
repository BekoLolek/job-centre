/**
 * `/me/events` — my applications (docs/platform-plan.md §4).
 *
 * Everything I have applied to, what happened to it, and the three things I can
 * still change: which days I can make, whether I am still coming, and whether I
 * want to keep my place at all.
 *
 * The page is a server component; each card is a client one that saves its own
 * taps, exactly like `/me/profile`'s sections. Nothing about a member's status
 * is recomputed here — `getMyApplications` carries the status and the queue
 * position, `capacityState` the seat counts, and `viewerAction` decides what a
 * withdrawn application's next move is.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import MyEventCard, { type MyEventRow } from "@/components/me/MyEventCard";
import { viewerAction } from "@/components/events";
import { Alert, Button, Eyebrow, Panel, StatTile, plural } from "@/components/ui";
import { getEventById, getMyApplications } from "@/lib/events";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My events · Job Centre Events",
};

export default async function MyEventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const now = new Date();

  // Set by the apply form on its way here. The confirmation is rendered from
  // the stored application rather than from anything the client remembers, so
  // a reload says the same thing and a made-up slug says nothing at all.
  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | null =>
    (Array.isArray(value) ? value[0] : value) ?? null;

  const justApplied = one(params.applied);
  const justWithdrew = one(params.withdrew);
  const promotedSomebody = one(params.promoted) === "1";

  const mine = await getMyApplications(user.id, { now });

  // The days and the live application state per event. `getMyApplications`
  // carries the event row but not its days, and the day chips are the whole
  // point of this page.
  const eventIds = [...new Set(mine.map((row) => row.eventId))];
  const details = await Promise.all(eventIds.map((id) => getEventById(id, { now })));
  const detailById = new Map(details.flatMap((event) => (event ? [[event.id, event]] : [])));

  const rows: MyEventRow[] = mine.flatMap((application) => {
    const event = detailById.get(application.eventId);
    if (!event) return [];

    const end = event.endsAt ?? event.startsAt;
    const past =
      event.status === "complete" ||
      event.status === "cancelled" ||
      (end !== null && end.getTime() < now.getTime());

    return [
      {
        applicationId: application.id,
        eventId: event.id,
        slug: event.slug,
        title: event.title,
        type: event.type,
        eventStatus: event.status,
        startsAt: event.startsAt ? event.startsAt.toISOString() : null,
        endsAt: event.endsAt ? event.endsAt.toISOString() : null,
        status: application.status,
        waitlistPosition: application.waitlistPosition,
        seats: event.seats,
        days: event.days.map((day) => ({
          id: day.id,
          dayIndex: day.dayIndex,
          label: day.label,
          startsAt: day.startsAt ? day.startsAt.toISOString() : null,
        })),
        availability: application.availability,
        confirmation: application.confirmation,
        past,
        // Eligibility is left out deliberately: it costs a read per event and
        // only changes the wording for somebody who has withdrawn and might
        // re-apply. The apply page itself shows the rank gate before anything
        // is filled in, which is where §8.3 wants it.
        action: viewerAction({
          slug: event.slug,
          signedIn: true,
          state: event.applicationsState,
          application: {
            status: application.status,
            waitlistPosition: application.waitlistPosition,
          },
        }),
      },
    ];
  });

  const current = rows.filter(
    (row) => !row.past && (row.status === "accepted" || row.status === "waitlisted")
  );
  const rest = rows.filter((row) => !current.includes(row));

  const landed = justApplied
    ? (rows.find((row) => row.slug === justApplied && row.status !== "withdrawn") ?? null)
    : null;

  const gone = justWithdrew
    ? (rows.find((row) => row.slug === justWithdrew && row.status === "withdrawn") ?? null)
    : null;

  const accepted = current.filter((row) => row.status === "accepted").length;
  const queued = current.filter((row) => row.status === "waitlisted").length;
  const unanswered = current.filter(
    (row) => row.days.length > 0 && Object.keys(row.availability).length === 0
  ).length;

  return (
    <div className="min-h-screen">
      <AppHeader section="MY EVENTS" />

      <main className="mx-auto max-w-[1000px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">
              {user.displayName ?? user.name ?? "Member"} · Applications
            </Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">MY EVENTS</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everything you have applied to. Availability and the &quot;still coming?&quot;
              answer save the moment you tap them — there is no submit button on this page.
            </p>
          </div>

          {rows.length > 0 && (
            <div className="ml-auto flex gap-8">
              <StatTile
                label="Seats"
                value={accepted}
                valueClassName={accepted > 0 ? "text-signal" : "text-muted"}
              />
              <StatTile
                label="Queueing"
                value={queued}
                valueClassName={queued > 0 ? "text-gold" : "text-muted"}
              />
              <StatTile label="Applications" value={rows.length} />
            </div>
          )}
        </header>

        {/* --- Just applied: the news, from the stored application ---- */}
        {landed && (
          <Panel
            as="section"
            className={landed.status === "waitlisted" ? "border-gold/50" : "border-signal/40"}
          >
            <Eyebrow
              className={landed.status === "waitlisted" ? "mb-3 text-gold" : "mb-3 text-signal"}
            >
              Application submitted · {landed.title}
            </Eyebrow>
            <h2 className="font-display text-4xl leading-none tracking-wide">
              {landed.status === "waitlisted"
                ? landed.waitlistPosition === null
                  ? "YOU'RE IN THE QUEUE"
                  : `YOU'RE #${landed.waitlistPosition} IN THE QUEUE`
                : "YOU'RE IN"}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              {landed.status === "waitlisted"
                ? "The seats were gone, so you joined the waitlist. If somebody withdraws you move up automatically — nobody has to approve it, and you do not have to apply again."
                : "You have a seat. Closer to the day you will be asked to confirm you are still coming; until then you can change your availability or withdraw whenever you like."}
            </p>
          </Panel>
        )}

        {/* --- Just withdrew: what it cost, if anything ---------------- */}
        {gone && (
          <Alert tone="signal">
            <span className="block font-medium">
              You have withdrawn from {gone.title}
            </span>
            <span className="mt-1 block opacity-90">
              {promotedSomebody
                ? "Somebody moved up off the waitlist and took your seat — that happens on its own, so there is nobody to tell."
                : "Nobody was waiting on it. You can apply again while signups are open, and your answers are still here."}
            </span>
          </Alert>
        )}

        {rows.length === 0 ? (
          <Panel as="section">
            <Eyebrow className="mb-3">Nothing yet</Eyebrow>
            <h2 className="font-display text-3xl leading-none tracking-wide">
              YOU HAVEN&apos;T APPLIED TO ANYTHING
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              When you apply to an event it appears here with its status, your place in the
              queue if there is one, and the days you said you could make. Fill in your
              profile first and the application itself is three taps.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href="/events" variant="gold">
                What&apos;s on
              </Button>
              <Button href="/me/profile">My profile</Button>
            </div>
          </Panel>
        ) : (
          <>
            {unanswered > 0 && (
              <p className="text-xs text-gold">
                {plural(unanswered, "event")} still waiting on your availability — the day
                chips below are one tap each.
              </p>
            )}

            {current.length > 0 && (
              <section className="space-y-4">
                <Eyebrow>Coming up</Eyebrow>
                {current.map((row) => (
                  <MyEventCard key={row.applicationId} row={row} />
                ))}
              </section>
            )}

            {rest.length > 0 && (
              <section className="space-y-4">
                <Eyebrow>Finished, declined and withdrawn</Eyebrow>
                {rest.map((row) => (
                  <MyEventCard key={row.applicationId} row={row} />
                ))}
              </section>
            )}
          </>
        )}

        <p className="pb-4 text-center text-xs text-muted">
          Nothing here is ever deleted. A withdrawn application keeps its answers, so
          applying again is still three taps —{" "}
          <Link href="/events" className="text-gold underline underline-offset-4">
            see what else is on
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
