/**
 * `/admin/templates` — reusable event templates and their form and format
 * defaults (docs/platform-plan.md §4, §7, §8.1).
 *
 * `event_templates` has existed since Phase 2 and `/admin/events`'s create box
 * has read it since — but nothing could ever write one, so the picker offered
 * whatever a seed had put there and nothing else. This is the writing half.
 *
 * The direction that actually earns its place is **from an existing event**.
 * Running a good Rivals tournament and then saying "do that again next month"
 * is the point of a template; retyping its eleven questions is not.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import TemplatesManager from "@/components/admin/TemplatesManager";
import { Page, PageHeader, StatTile } from "@/components/ui";
import { loadAdminTemplates } from "@/lib/admin-templates";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Event templates · Job Centre Events",
};

export default async function AdminTemplatesPage() {
  await requireAdmin();
  const view = await loadAdminTemplates();

  const active = view.templates.filter((template) => template.isActive).length;
  const produced = view.templates.reduce((total, template) => total + template.events, 0);

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: a list of templates, each expanding into its own form. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Templates"
          title="Event templates"
          intro={
            <>
              A starting point for an event: its type, its game, its format settings and its
              whole application form, filled in already. The quickest way to make one is to
              point at an event that went well and say &ldquo;like that&rdquo;.
            </>
          }
          aside={
            <>
              <StatTile label="Templates" value={`${active}/${view.templates.length}`} />
              <StatTile
                label="Events made"
                value={produced}
                valueClassName={produced > 0 ? "text-body" : "text-muted"}
              />
            </>
          }
        />

        <TemplatesManager view={view} />

        <p className="pb-4 text-center text-12 text-muted">
          A template is copied into an event and then forgotten, so editing one never
          touches an event already taking applications — and deleting one leaves every
          event made from it exactly as it is. Deactivating is the gentler move:
          it takes a template out of the create-event picker and keeps it for next season.
        </p>
      </Page>
    </div>
  );
}
