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
import { Eyebrow, StatTile } from "@/components/ui";
import { countApplicationsByStatus, listEventTemplates, listEvents } from "@/lib/events";
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
      applications: totals.get(event.id) ?? {
        accepted: 0,
        waitlisted: 0,
        declined: 0,
        withdrawn: 0,
      },
    }));

  const live = rows.filter((row) => row.event.status === "live").length;
  const drafts = rows.filter((row) => row.event.status === "draft").length;
  const applications = rows.reduce(
    (total, row) =>
      total +
      row.applications.accepted +
      row.applications.waitlisted +
      row.applications.declined +
      row.applications.withdrawn,
    0
  );

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Events</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">EVENTS</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everything the community runs, drafts included. An event starts as a draft
              nobody can see; give it days, an application form and a capacity, then publish
              it when it is ready.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Events" value={rows.length} />
            <StatTile
              label="Drafts"
              value={drafts}
              valueClassName={drafts > 0 ? "text-gold" : "text-muted"}
            />
            <StatTile
              label="Live"
              value={live}
              valueClassName={live > 0 ? "text-ember" : "text-muted"}
            />
            <StatTile
              label="Applications"
              value={applications}
              valueClassName={applications > 0 ? "text-signal" : "text-muted"}
            />
          </div>
        </header>

        <EventsManager
          rows={rows}
          templates={templates.map((template) => ({
            id: template.id,
            name: template.name,
            type: template.type,
            questions: template.questions.length,
          }))}
        />

        <p className="pb-4 text-center text-xs text-muted">
          Nothing on this page deletes an event. A mistake is cancelled, not erased — and a
          cancelled event can go back to draft.
        </p>
      </main>
    </div>
  );
}
