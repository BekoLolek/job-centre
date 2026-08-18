/**
 * `/admin/audit` — who did what, and when (Phase 5).
 *
 * Newest first, filterable by event, and that is deliberately the whole of it.
 * The log's job is to answer "what happened to this event last night", which
 * is a question about a short list read top to bottom — not a search interface.
 *
 * Every line was written at the moment it happened by `recordAudit`, so the
 * sentence is what was true then. Nothing on this page rebuilds a summary from
 * the ids it references, because a line that changes meaning when somebody is
 * renamed is not a record of anything.
 *
 * **No instant is formatted here.** Each row's time goes through `LocalTime`,
 * which re-keys on mount and prints in the reader's own zone.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import { LocalTime, ZoneNote } from "@/components/format";
import {
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Panel,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { listAudit } from "@/lib/audit";
import { listEvents } from "@/lib/events";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Audit log · Job Centre Events",
};

/** One screenful. There is a "show more" and no infinite scroll. */
const PAGE = 100;

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const raw = Array.isArray(params.event) ? params.event[0] : params.event;
  const limitRaw = Array.isArray(params.show) ? params.show[0] : params.show;
  const limit = Math.min(Math.max(Number(limitRaw) || PAGE, PAGE), 500);

  const events = await listEvents();
  // A filter naming an event that does not exist shows everything rather than
  // an empty page: a stale bookmark is a much likelier explanation than an
  // event with genuinely no entries, and "nothing happened" is a lie.
  const filter = raw && events.some((event) => event.id === raw) ? raw : null;

  const rows = await listAudit({ eventId: filter, limit });
  const named = filter ? events.find((event) => event.id === filter) : null;
  const more = rows.length === limit;

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Audit</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">AUDIT LOG</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Every status change, application decision, captain and team change, draft
              award and void, result edit and settings change — with the name of whoever
              made it. Nothing here is ever edited or deleted.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Showing" value={rows.length} />
            <StatTile
              label="Scope"
              value={named ? "One event" : "Everything"}
              valueClassName="text-muted"
            />
          </div>
        </header>

        {/* --- Filter ------------------------------------------------- */}
        <Panel as="section" padding="sm">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow className="mr-1">Filter</Eyebrow>
            <Link
              href="/admin/audit"
              className={cx(
                "btn border px-2 py-1 text-xs",
                filter === null ? "border-gold/50 bg-gold/10 text-gold" : "border-hair text-muted"
              )}
            >
              Everything
            </Link>
            {events.slice(0, 12).map((event) => (
              <Link
                key={event.id}
                href={`/admin/audit?event=${event.id}`}
                className={cx(
                  "btn border px-2 py-1 text-xs",
                  filter === event.id
                    ? "border-gold/50 bg-gold/10 text-gold"
                    : "border-hair text-muted"
                )}
              >
                {event.title}
              </Link>
            ))}
          </div>
        </Panel>

        {/* --- The log ------------------------------------------------ */}
        {rows.length === 0 ? (
          <Panel as="section">
            <EmptyState>
              {named
                ? `Nothing has been recorded against “${named.title}” yet.`
                : "Nothing has been recorded yet. The log fills up from the first status change."}
            </EmptyState>
          </Panel>
        ) : (
          <Panel as="section" padding="sm">
            <ul className="divide-y divide-hair/60">
              {rows.map((row) => (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Badge
                      tone={row.tone === "ember" ? "ember" : row.tone === "gold" ? "gold" : "default"}
                    >
                      {row.label}
                    </Badge>

                    <span className="min-w-0 flex-1 text-sm leading-relaxed text-chalk">
                      {row.summary}
                    </span>

                    <span className="eyebrow shrink-0">
                      <LocalTime at={row.at.toISOString()} />
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-muted">
                    <span>
                      {row.actor.handle ? (
                        <Link
                          href={`/players/${row.actor.handle}`}
                          className="hover:text-gold"
                        >
                          {row.actor.name}
                        </Link>
                      ) : (
                        row.actor.name
                      )}
                    </span>
                    {row.event && (
                      <Link
                        href={`/admin/events/${row.event.id}`}
                        className="hover:text-gold"
                      >
                        {row.event.title}
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {more && (
          <div className="text-center">
            <Button
              href={`/admin/audit?${filter ? `event=${filter}&` : ""}show=${limit + PAGE}`}
              size="sm"
            >
              Show {plural(PAGE, "more line")}
            </Button>
          </div>
        )}

        <p className="pb-4 text-center text-xs text-muted">
          <ZoneNote /> The log is append-only: there is no code anywhere that updates or
          deletes a line.
        </p>
      </main>
    </div>
  );
}
