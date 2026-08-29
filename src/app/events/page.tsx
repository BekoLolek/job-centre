/**
 * `/events` — what is coming up.
 *
 * Only what is coming up. The archive moved to its own address, because "what
 * can I sign up for" and "what have we run" are two questions and a toggle made
 * the second a hidden state of the first. See `EventListing`.
 *
 * The kind filter is still a link carrying a query string rather than client
 * state, which costs nothing and buys three things: the page stays a server
 * component, a filtered view is a URL somebody can paste into Discord, and it
 * all works before any JavaScript arrives (§2).
 *
 * Drafts are never here. `listEvents` with no status filter is the only read
 * that returns them and it belongs to `/admin/events`; a member seeing a draft
 * would be seeing an event that cannot be applied to and may never happen.
 */

import AppHeader from "@/components/AppHeader";
import { EventListing } from "@/components/events";
import { Eyebrow } from "@/components/ui";
import { listEvents } from "@/lib/events";
import { PUBLIC_STATUSES, firstParam } from "./scope";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Events · Job Centre Events",
  description: "Everything the Job Centre has coming up.",
};

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const type = firstParam(params.type);

  const now = new Date();
  const [upcoming, past] = await Promise.all([
    listEvents({ status: PUBLIC_STATUSES, upcoming: true, now }),
    listEvents({ status: PUBLIC_STATUSES, upcoming: false, now }),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader section="Events" />

      <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 sm:px-6">
        <header>
          <Eyebrow className="mb-2">Job Centre · Events</Eyebrow>
          <h1 className="text-4xl">Coming up</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Everything the community has planned. Anything already run keeps its page for
            the record — that is what the archive is.
          </p>
        </header>

        <EventListing
          scope="upcoming"
          events={upcoming}
          otherCount={past.length}
          type={type}
          nothingAtAll={upcoming.length === 0 && past.length === 0}
        />
      </main>
    </div>
  );
}
