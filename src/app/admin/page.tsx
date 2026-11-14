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
 *
 * ## A holder of any area power, shown what their powers reach (R-265 / UC-56 1, 2)
 *
 * This is where a holder lands, so it admits an admin and any member with an
 * area power on their list, and refuses a member with none exactly as it
 * always did (UC-56 2a). No single power is the page's own, so the guard is
 * `requireAnyPermission(AREA_POWERS)`. `destructive` is not an area power: it
 * is required in addition to one, and a member holding it alone is turned
 * away here as everywhere.
 *
 * ## There is no `layout.tsx` beside this page, and one must not be added
 *
 * A layout that asked for "any power" looks like the obvious place for the
 * line above, and it would lock out an event's **host**. A host holds no
 * power at all - their authority is one row in `event_hosts` - and
 * `/admin/events/[id]` is under this folder and is theirs to open
 * (`requireEventManager`). A layout cannot tell that page from the others.
 * One that only asked for a signed-in member would add nothing, and neither
 * would re-run on a client-side navigation. So each page refuses for itself,
 * on its own first line, and the sweep reads every one.
 *
 * What is drawn is then cut down to what the reader could act on. A line
 * appears when they hold the power its screen is on ({@link RESOLVED_BY});
 * the event cards and the drafts are `events.manage`'s, because every one is a
 * link into an editor; the tail of the log is `audit.read`'s, and is not read
 * at all for anybody else. A holder whose powers are for other screens - the
 * catalogue, the polls - is let in and told nothing is waiting, which is true.
 *
 * **None of that is protection.** Every screen a line links to refuses for
 * itself, and `admin/__tests__/holder-pages.test.ts` asks each of them.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import { AREA_POWERS } from "@/components/admin/sections";
import { EventCard, EventStatusPill } from "@/components/events";
import {
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Page,
  PageHeader,
  Section,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { type AttentionKind, loadDashboard } from "@/lib/admin-dashboard";
import { listAudit } from "@/lib/audit";
import { holderFor } from "@/lib/permissions";
import { type Power, holds } from "@/lib/permissions-policy";
import { requireAnyPermission } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Job Centre Events",
};

/**
 * The power each kind of line is resolved with: the one its screen is on.
 *
 * Every kind is named, so a new one does not compile until somebody has said
 * whose it is. A failed announcement is `audit.read`'s because the line links
 * to the log, which is where the reason is.
 */
const RESOLVED_BY: Record<AttentionKind, Power> = {
  applications: "events.manage",
  pending_applications: "events.manage",
  host_applications: "hosts.approve",
  publish: "events.manage",
  captains: "events.manage",
  lot_open: "events.manage",
  needs_winner: "events.manage",
  unscheduled: "events.manage",
  announcements: "audit.read",
  championship_result: "events.manage",
};

export default async function AdminDashboardPage() {
  const user = await requireAnyPermission(AREA_POWERS);
  const holder = await holderFor(user);

  const mayManageEvents = holds(holder, "events.manage");
  const mayCreateEvents = holds(holder, "events.create");
  const mayReadAudit = holds(holder, "audit.read");

  const [view, recent] = await Promise.all([
    loadDashboard(),
    mayReadAudit ? listAudit({ limit: 6 }) : [],
  ]);
  const items = view.items.filter((item) => holds(holder, RESOLVED_BY[item.kind]));
  const blocked = items.filter((item) => item.urgency === "blocked").length;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: a to-do list and a few event cards. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Tonight"
          title="What needs you"
          intro="Everything below is worked out from the database as this page loaded, so a line disappears the moment you deal with it. Nothing here is a reminder somebody set."
          aside={
            <>
              <StatTile
                label="Needs you"
                value={items.length}
                valueClassName={items.length > 0 ? "text-union" : "text-body"}
              />
              <StatTile
                label="Blocking"
                value={blocked}
                valueClassName={blocked > 0 ? "text-flare" : "text-muted"}
              />
              {mayManageEvents && (
                <>
                  <StatTile
                    label="Live"
                    value={view.live.length}
                    valueClassName={view.live.length > 0 ? "text-flare" : "text-muted"}
                  />
                  <StatTile label="Active events" value={view.totals.events} />
                </>
              )}
            </>
          }
        />

        <div>
          {/* --- The list -------------------------------------------- */}
          <Section
            first
            icon="flag"
            title="Awaiting you"
            description="Every line ends in the screen that resolves it. A finished event never appears — nothing about it can need doing."
          >
            {items.length === 0 ? (
              <div className="py-4">
                <EmptyState>
                  {mayManageEvents
                    ? "Nothing is waiting on you. Every applicant has a seat or a place in a queue, every series has a winner, and every match has a time."
                    : "Nothing is waiting on you. What your powers reach is in the menu."}
                </EmptyState>
                <div className="mt-4 flex flex-wrap gap-2">
                  {mayManageEvents && (
                    <Button href="/admin/events" size="sm">
                      All events
                    </Button>
                  )}
                  {mayCreateEvents && (
                    <Button href="/admin/events" size="sm" variant="union">
                      Create one
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-hair/60">
                {items.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-center gap-4 py-5">
                    <div className="min-w-0 flex-1">
                      {/* A failed announcement with no event has no event to name. */}
                      {item.event && (
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {/* Named for everybody; a way in only for a reader the editor opens for. */}
                          {mayManageEvents ? (
                            <Link
                              href={`/admin/events/${item.event.id}`}
                              className="text-12 text-muted hover:text-union"
                            >
                              {item.event.title}
                            </Link>
                          ) : (
                            <span className="text-12 text-muted">{item.event.title}</span>
                          )}
                          <EventStatusPill status={item.event.status} />
                        </div>
                      )}
                      <div
                        className={cx(
                          "text-14",
                          item.urgency === "blocked" ? "text-flare" : "text-chalk"
                        )}
                      >
                        {item.label}
                      </div>
                      <p className="mt-1 text-12 leading-relaxed text-muted">{item.detail}</p>
                    </div>

                    <Button
                      href={item.href}
                      size="sm"
                      variant={item.urgency === "blocked" ? "union" : undefined}
                    >
                      {item.action}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* --- Running now, and next ------------------------------- */}
          {mayManageEvents && (view.live.length > 0 || view.upcoming.length > 0) && (
            <Section
              icon="clock"
              title={view.live.length > 0 ? "Running now" : "Coming up"}
              description="What is on, admin side. Each one links to the member's view of it as well."
              aside={
                <Link href="/admin/events" className="text-12 text-muted hover:text-union">
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
          {mayManageEvents && view.drafts.length > 0 && (
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
                    className="text-14 text-chalk hover:text-union"
                  >
                    {event.title}
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {/* --- The last few things that happened ------------------- */}
          {mayReadAudit && (
          <Section
            icon="history"
            title="Last few changes"
            description="The tail of the audit log. Nothing here is ever edited or deleted."
            aside={
              <Link href="/admin/audit" className="text-12 text-muted hover:text-union">
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
                    <Badge tone={row.tone === "flare" ? "flare" : "default"}>{row.label}</Badge>
                    <span className="min-w-0 flex-1 text-14 text-chalk">{row.summary}</span>
                    <Eyebrow as="span" className="shrink-0 text-inherit">{row.actor.name}</Eyebrow>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          )}
        </div>

        <p className="pb-4 text-center text-12 text-muted">
          Signed in as {user.displayName ?? user.name ?? "an admin"}. A finished event
          never appears above — it is read-only, so nothing about it can need doing.
        </p>
      </Page>
    </div>
  );
}
