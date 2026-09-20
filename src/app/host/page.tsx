/**
 * `/host` — "I would like to run an event."
 *
 * Members only. The form asks for the game and for what the host needs to know
 * about each player, because those two are what an admin needs in order to
 * *approve* it rather than to start a conversation about it — see
 * `src/lib/hosting.ts`.
 */

import AppHeader from "@/components/AppHeader";
import HostApplyForm from "@/components/host/HostApplyForm";
import { Badge, Eyebrow, Page, Section } from "@/components/ui";
import { eventsHostedBy, hostableGames, myHostApplications } from "@/lib/hosting";
import { requireUser } from "@/lib/session-guards";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Host an event · Job Centre Events",
};

export default async function HostPage() {
  const user = await requireUser();
  const [mine, games, hosting] = await Promise.all([
    myHostApplications(user.id),
    hostableGames(),
    eventsHostedBy(user.id),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader />

      <Page>
        <header className="mb-2">
          <Eyebrow className="mb-2">Job Centre · Hosting</Eyebrow>
          <h1 className="text-36">Run an event</h1>
          <p className="mt-3 max-w-2xl text-14 leading-relaxed text-muted">
            Anybody can propose one. An admin reads it, sets up the game and the sign-up
            questions, and then hands the event over — from that point it is yours: the
            format, the schedule, the applicants, the results, publishing it. Everything an
            admin could do to that one event, you can.
          </p>
        </header>

        {hosting.length > 0 && (
          <Section
            first
            icon="trophy"
            title="Yours to run"
            description="You have been handed these. They open in the same editor an admin uses."
          >
            <div className="divide-y divide-hair/60">
              {hosting.map((event) => (
                <Link
                  key={event.id}
                  href={`/admin/events/${event.id}`}
                  className="-mx-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded px-4 py-4 transition-colors hover:bg-overlay-2"
                >
                  <span className="text-16 text-chalk">{event.title}</span>
                  <Badge>{event.status}</Badge>
                  <span className="num text-13 text-dim">/events/{event.slug}</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        <Section
          first={hosting.length === 0}
          icon="clipboard"
          title="Apply"
          description="One at a time, so an admin looking at the queue is looking at decisions rather than drafts."
        >
          <HostApplyForm mine={mine} games={games} />
        </Section>
      </Page>
    </div>
  );
}
