/**
 * `/admin/events` — every event, including the drafts nobody else can see.
 *
 * The list half of plan §4's `/admin/events   list + create`. Drafts are the
 * point: `listEvents` with no status filter is the only read in the codebase
 * that returns them, because members must never see one and an admin has
 * nothing to work on until they can.
 *
 * ## Two powers open it, and each is shown its own half (R-265 / UC-56 2)
 *
 * The page is `list + create`, and those are two powers: `events.manage` finds
 * an event and `events.create` makes one. So it admits a holder of either, or
 * an admin, and sends anybody else who is signed in to `/signin` with
 * `?error=admin-only` rather than to a 403 — they are not being asked to
 * authenticate again, they are being told the page is not theirs.
 *
 * The guard is `requireAnyPermission`, naming both, on the first line - where
 * the sweep can read it. `admin/__tests__/holder-pages.test.ts` holds it to
 * exactly those two.
 *
 * `EventsManager` is then told which half the reader holds. That is what it
 * offers, never what stops anything: `createEventAction` asks for
 * `events.create` itself, and the editor each row links to is on the event's
 * own guard.
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
import { holderFor } from "@/lib/permissions";
import { holds } from "@/lib/permissions-policy";
import { requireAnyPermission } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Events · Job Centre Events",
};

export default async function AdminEventsPage() {
  const user = await requireAnyPermission(["events.create", "events.manage"]);
  const holder = await holderFor(user);
  const mayManage = holds(holder, "events.manage");

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
          mayCreate={holds(holder, "events.create")}
          mayManage={mayManage}
          /*
           * A row is a link to that event's editor and a status control, and
           * neither works for a reader who manages no event - so they are
           * handed none, rather than a list of drafts they can only look at.
           */
          rows={mayManage ? rows : []}
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
