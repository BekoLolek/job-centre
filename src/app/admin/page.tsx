/**
 * `/admin` — what needs attention (docs/platform-plan.md §4).
 *
 * The page you have open on the night. It is one list and a few numbers, and
 * every line ends in a link to the exact screen that resolves it — an admin
 * dashboard that tells you something is wrong and then makes you go and find it
 * is a dashboard you stop opening.
 *
 * Every item comes from `loadDashboard`, which derives all of them; nothing on
 * this page counts anything itself and nothing is stored. See the module
 * comment on `src/lib/admin-dashboard.ts` for why a `needs_attention` column
 * would be a bug rather than an optimisation.
 *
 * **No instant is formatted here.** The event lines go through `EventCard` and
 * `EventDateRange`, both of which re-key on mount in the reader's own zone.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import { EventCard, EventStatusPill } from "@/components/events";
import {
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Section,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { loadDashboard } from "@/lib/admin-dashboard";
import { listAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Job Centre Events",
};

export default async function AdminDashboardPage() {
  const admin = await requireAdmin();

  const [view, recent] = await Promise.all([loadDashboard(), listAudit({ limit: 6 })]);
  const blocked = view.items.filter((item) => item.tone === "ember").length;

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Tonight</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">
              WHAT NEEDS YOU
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everything below is worked out from the database as this page loaded, so a
              line disappears the moment you deal with it. Nothing here is a reminder
              somebody set.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile
              label="Needs you"
              value={view.items.length}
              valueClassName={view.items.length > 0 ? "text-gold" : "text-signal"}
            />
            <StatTile
              label="Blocking"
              value={blocked}
              valueClassName={blocked > 0 ? "text-ember" : "text-muted"}
            />
            <StatTile
              label="Live"
              value={view.live.length}
              valueClassName={view.live.length > 0 ? "text-ember" : "text-muted"}
            />
            <StatTile label="Active events" value={view.totals.events} />
          </div>
        </header>

        <div>
          {/* --- The list -------------------------------------------- */}
          <Section
            first
            icon="flag"
            title="Awaiting you"
            description="Every line ends in the screen that resolves it. A finished event never appears — nothing about it can need doing."
          >
            {view.items.length === 0 ? (
              <div className="py-4">
                <EmptyState>
                  Nothing is waiting on you. Every applicant has a seat or a place in a
                  queue, every series has a winner, and every match has a time.
                </EmptyState>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button href="/admin/events" size="sm">
                    All events
                  </Button>
                  <Button href="/admin/events" size="sm" variant="gold">
                    Create one
                  </Button>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-hair/60">
                {view.items.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-center gap-4 py-5">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin/events/${item.event.id}`}
                          className="text-xs text-muted hover:text-gold"
                        >
                          {item.event.title}
                        </Link>
                        <EventStatusPill status={item.event.status} />
                      </div>
                      <div
                        className={cx(
                          "text-sm",
                          item.tone === "ember" ? "text-ember" : "text-chalk"
                        )}
                      >
                        {item.label}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{item.detail}</p>
                    </div>

                    <Button
                      href={item.href}
                      size="sm"
                      variant={item.tone === "ember" ? "gold" : undefined}
                    >
                      {item.action}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* --- Running now, and next ------------------------------- */}
          {(view.live.length > 0 || view.upcoming.length > 0) && (
            <Section
              icon="clock"
              title={view.live.length > 0 ? "Running now" : "Coming up"}
              description="What is on, admin side. Each one links to the member's view of it as well."
              aside={
                <Link href="/admin/events" className="text-xs text-muted hover:text-gold">
                  All events →
                </Link>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[...view.live, ...view.upcoming].slice(0, 6).map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    href={`/admin/events/${event.id}`}
                    footer={
                      <Button href={`/events/${event.slug}`} size="sm">
                        See it as a member
                      </Button>
                    }
                  />
                ))}
              </div>
            </Section>
          )}

          {/* --- Drafts nobody can see ------------------------------- */}
          {view.drafts.length > 0 && (
            <Section
              icon="calendar"
              title="Drafts"
              description={`${plural(view.drafts.length, "draft")} nobody else can see. They stay invisible until you publish them.`}
            >
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {view.drafts.map((event) => (
                  <Link
                    key={event.id}
                    href={`/admin/events/${event.id}`}
                    className="text-sm text-chalk hover:text-gold"
                  >
                    {event.title}
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {/* --- The last few things that happened ------------------- */}
          <Section
            icon="history"
            title="Last few changes"
            description="The tail of the audit log. Nothing here is ever edited or deleted."
            aside={
              <Link href="/admin/audit" className="text-xs text-muted hover:text-gold">
                Full log →
              </Link>
            }
          >
            {recent.length === 0 ? (
              <div className="py-4">
                <EmptyState size="sm">
                  Nothing has been recorded yet. Every status change, decision, award and
                  result lands here from the moment somebody makes one.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-hair/60">
                {recent.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-3">
                    <Badge tone={row.tone === "ember" ? "ember" : "default"}>{row.label}</Badge>
                    <span className="min-w-0 flex-1 text-sm text-chalk">{row.summary}</span>
                    <span className="eyebrow shrink-0">{row.actor.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <p className="pb-4 text-center text-xs text-muted">
          Signed in as {admin.displayName ?? admin.name ?? "an admin"}. A finished event
          never appears above — it is read-only, so nothing about it can need doing.
        </p>
      </main>
    </div>
  );
}
