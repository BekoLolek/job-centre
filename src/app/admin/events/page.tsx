/**
 * `/admin/events` — every event, including the drafts nobody else can see.
 *
 * The list half of plan §4's `/admin/events   list + create`. Drafts are the
 * point: `listEvents` with no status filter is the only read in the codebase
 * that returns them, because members must never see one and an admin has
 * nothing to work on until they can.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403 — they are not being asked to
 * authenticate again, they are being told the page is not theirs.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import EventsManager, { type EventListRow } from "@/components/admin/events/EventsManager";
import { Page, PageHeader, StatTile } from "@/components/ui";
import {
  countApplicationsByStatus,
  emptyApplicationCounts,
  listEventTemplates,
  listEvents,
} from "@/lib/events";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Events · Job Centre Events",
};

export default async function AdminEventsPage() {
  await requireAdmin();

  const [summaries, templates] = await Promise.all([listEvents(), listEventTemplates()]);
  const totals = await countApplicationsByStatus(summaries.map((event) => event.id));

  // `listEvents` orders by start date for the public lists. An admin list reads
  // newest first: the thing you just made is the thing you are working on.
  const rows: EventListRow[] = [...summaries]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((event) => ({
      event,
      applications: totals.get(event.id) ?? emptyApplicationCounts(),
    }));

  const live = rows.filter((row) => row.event.status === "live").length;
  const drafts = rows.filter((row) => row.event.status === "draft").length;
  // Every application, whatever became of it — the ones still awaiting review
  // in an approval event (R-27) included.
  const applications = rows.reduce(
    (total, row) => total + Object.values(row.applications).reduce((sum, n) => sum + n, 0),
    0
  );

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: a list of events as wrapping rows, not a table. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Events"
          title="Events"
          intro="Everything the community runs, drafts included. An event starts as a draft nobody can see; give it days, an application form and a capacity, then publish it when it is ready."
          aside={
            <>
              <StatTile label="Events" value={rows.length} />
              <StatTile
                label="Drafts"
                value={drafts}
                valueClassName={drafts > 0 ? "text-union" : "text-muted"}
              />
              <StatTile
                label="Live"
                value={live}
                valueClassName={live > 0 ? "text-flare" : "text-muted"}
              />
              <StatTile
                label="Applications"
                value={applications}
                valueClassName={applications > 0 ? "text-body" : "text-muted"}
              />
            </>
          }
        />

        <EventsManager
          rows={rows}
          templates={templates.map((template) => ({
            id: template.id,
            name: template.name,
            type: template.type,
            questions: template.questions.length,
          }))}
        />

        <p className="pb-4 text-center text-12 text-muted">
          Nothing on this page deletes an event. A cancelled event stays in the archive with
          its applications.
        </p>
      </Page>
    </div>
  );
}
