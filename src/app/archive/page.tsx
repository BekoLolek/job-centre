/**
 * `/archive` — everything the community has already run.
 *
 * Its own address rather than `?when=past` on `/events`. The archive is a
 * different question from "what can I sign up for": it is what people look at
 * to settle an argument about who won, to find the bracket from March, or to
 * see whether a thing was worth running twice. A query parameter made that a
 * hidden state of the events page, reachable only by noticing a toggle and
 * impossible to link to without explaining the toggle first.
 *
 * Nothing is ever deleted, which is what makes this worth having at all — a
 * finished event keeps its page, its bracket and its results for good.
 */

import AppHeader from "@/components/AppHeader";
import { EventListing } from "@/components/events";
import { Eyebrow } from "@/components/ui";
import { listEvents } from "@/lib/events";
import { PUBLIC_STATUSES, firstParam } from "../events/scope";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Archive · Job Centre Events",
  description: "Every event the Job Centre has run.",
};

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const type = firstParam(params.type);

  const now = new Date();
  const [past, upcoming] = await Promise.all([
    listEvents({ status: PUBLIC_STATUSES, upcoming: false, now }),
    listEvents({ status: PUBLIC_STATUSES, upcoming: true, now }),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader section="Archive" />

      <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 sm:px-6">
        <header>
          <Eyebrow className="mb-2">Job Centre · Archive</Eyebrow>
          <h1 className="text-4xl">What we have run</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Every event that has already happened, most recent first. Nothing is ever
            deleted — each one keeps its page, its bracket and its results.
          </p>
        </header>

        <EventListing
          scope="past"
          events={past}
          otherCount={upcoming.length}
          type={type}
          nothingAtAll={upcoming.length === 0 && past.length === 0}
        />
      </main>
    </div>
  );
}
