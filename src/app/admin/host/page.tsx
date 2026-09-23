/**
 * `/admin/host` — who wants to run something.
 *
 * A queue before it is a record: undecided applications sit on top, decided
 * ones collapse to one line each underneath.
 */

import AppHeader from "@/components/AppHeader";
import HostQueue from "@/components/admin/HostQueue";
import { Eyebrow, Page, Section } from "@/components/ui";
import { linkableEvents, listHostApplications } from "@/lib/hosting";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Host applications · Admin",
};

export default async function AdminHostPage() {
  await requireAdmin();
  // The events an approval may be linked to (UC-21 3): everything nobody hosts
  // yet, including the one the admin is about to create from an application.
  const [applications, events] = await Promise.all([
    listHostApplications(),
    linkableEvents(),
  ]);
  const waiting = applications.filter((row) => row.status === "pending").length;

  return (
    <div className="min-h-screen">
      <AppHeader admin />

      <Page>
        <header className="mb-2">
          <Eyebrow className="mb-2">Admin · Hosting</Eyebrow>
          <h1 className="text-36">Who wants to run something</h1>
          <p className="mt-3 max-w-2xl text-14 leading-relaxed text-muted">
            Build the event from the application, fix what needs fixing, then approve onto it.
            From that point they can do everything to that one event that you can, and nothing
            at all to any other. They cannot reach the rest of the admin area.
          </p>
        </header>

        <Section
          first
          icon="clipboard"
          title={waiting > 0 ? `${waiting} waiting` : "Applications"}
          description="What they need from each player is the part to read — it becomes the sign-up questions, and the event is built from it before you hand it over."
        >
          <HostQueue applications={applications} events={events} />
        </Section>
      </Page>
    </div>
  );
}
