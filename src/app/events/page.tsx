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
import { Page, PageHeader } from "@/components/ui";
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
      <AppHeader />

      {/* `standard`: `EventListing` lays its cards out two to a row. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Job Centre · Events"
          title="Coming up"
          intro="Everything the community has planned. Anything already run keeps its page for the record — that is what the archive is."
        />

        <EventListing
          scope="upcoming"
          events={upcoming}
          otherCount={past.length}
          type={type}
          nothingAtAll={upcoming.length === 0 && past.length === 0}
        />
      </Page>
    </div>
  );
}
