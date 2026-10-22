/**
 * `/admin/host` — who wants to run something.
 *
 * A queue before it is a record: undecided applications sit on top, decided
 * ones collapse to one line each underneath.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import HostQueue from "@/components/admin/HostQueue";
import { Page, PageHeader, Section } from "@/components/ui";
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
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `reading`: one column of application cards, each read top to bottom. */}
      <Page width="reading" className="space-y-6">
        <PageHeader
          eyebrow="Admin · Hosts"
          title="Who wants to run something"
          intro="Build the event from the application, fix what needs fixing, then approve onto it. From that point they can do everything to that one event that you can, and nothing at all to any other. They cannot reach the rest of the admin area."
        />

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
