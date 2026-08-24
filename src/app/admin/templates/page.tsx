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
import { Eyebrow, StatTile } from "@/components/ui";
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
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1100px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Templates</Eyebrow>
            <h1 className="font-display text-4xl leading-none">
              Event templates
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              A starting point for an event: its type, its game, its format settings and
              its whole application form, filled in already. The quickest way to make one
              is to point at an event that went well and say &ldquo;like that&rdquo;.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Templates" value={`${active}/${view.templates.length}`} />
            <StatTile
              label="Events made"
              value={produced}
              valueClassName={produced > 0 ? "text-signal" : "text-muted"}
            />
          </div>
        </header>

        <TemplatesManager view={view} />

        <p className="pb-4 text-center text-xs text-muted">
          A template is copied into an event and then forgotten, so editing one never
          touches an event already taking applications. Nothing here deletes a template —
          deactivating takes it out of the create-event picker and leaves everything else.
        </p>
      </main>
    </div>
  );
}
