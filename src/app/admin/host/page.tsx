/**
 * `/admin/host` — who wants to run something.
 *
 * A queue before it is a record: undecided applications sit on top, decided
 * ones collapse to one line each underneath.
 */

import AppHeader from "@/components/AppHeader";
import HostQueue from "@/components/admin/HostQueue";
import { Eyebrow, Section } from "@/components/ui";
import { listHostApplications } from "@/lib/hosting";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Host applications · Admin",
};

export default async function AdminHostPage() {
  await requireAdmin();
  const applications = await listHostApplications();
  const waiting = applications.filter((row) => row.status === "pending").length;

  return (
    <div className="min-h-screen">
      <AppHeader section="Admin" />

      <main className="mx-auto max-w-[1000px] px-4 py-8 sm:px-6">
        <header className="mb-2">
          <Eyebrow className="mb-2">Admin · Hosting</Eyebrow>
          <h1 className="text-4xl">Who wants to run something</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Approving one creates a draft event and hands it to them: from that point they can
            do everything to that one event that you can, and nothing at all to any other.
            They cannot reach the rest of the admin area.
          </p>
        </header>

        <Section
          first
          icon="clipboard"
          title={waiting > 0 ? `${waiting} waiting` : "Applications"}
          description="What they need from each player is the part to read — it becomes the sign-up questions, and you write those before handing it over."
        >
          <HostQueue applications={applications} />
        </Section>
      </main>
    </div>
  );
}
