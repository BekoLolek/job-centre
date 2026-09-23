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
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Page,
  Section,
  Select,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { type AuditView, listAudit, resolveAuditFilter } from "@/lib/audit";
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
  const filter = resolveAuditFilter(raw, events);
  const named = filter.kind === "event" ? filter.event : null;

  /*
   * An id that names no event reads nothing (UC-27 3).
   *
   * The old behaviour was to drop the filter and list the whole log, which is
   * the one outcome a log must not have: every line on the site, under a
   * heading that says "Everything", with no sign that a filter was asked for.
   * Nothing is read here instead, and the page says why — an empty screen with
   * a sentence on it cannot be mistaken for one event's history.
   */
  const rows: AuditView[] =
    filter.kind === "unknown" ? [] : await listAudit({ eventId: named?.id ?? null, limit });
  const more = rows.length === limit;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      <Page className="space-y-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Audit</Eyebrow>
            <h1 className="font-display text-36 leading-none">Audit log</h1>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              Every status change, application decision, captain and team change, draft
              award and void, result edit and settings change — with the name of whoever
              made it. Nothing here is ever edited or deleted.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Showing" value={rows.length} />
            <StatTile
              label="Scope"
              value={
                filter.kind === "event"
                  ? "One event"
                  : filter.kind === "unknown"
                    ? "No such event"
                    : "Everything"
              }
              valueClassName={filter.kind === "unknown" ? "text-flare" : "text-muted"}
            />
          </div>
        </header>

        <Section
          first
          icon="history"
          title="The log"
          description="Newest first. Every line says what was true when it was written, so a rename never changes what happened."
        >
          {/*
            --- Filter -------------------------------------------------
            Every event, not the twelve newest. The chips were a nice row
            until the thirteenth event, after which the log could not be
            filtered to an older one at all from this page — and an audit
            log's whole job is answering questions about things that have
            already finished, which are exactly the events that fall off the
            end of a list ordered by newest (R-110 / UC-27 3).

            A plain GET form, so it works with no JavaScript and leaves the
            filter in the URL where it can be linked to and bookmarked.
          */}
          <div className="flex flex-wrap items-end gap-3 pb-5">
            <Link
              href="/admin/audit"
              className={cx(
                "btn border px-2 py-1 text-12",
                filter.kind === "all"
                  ? "border-union/50 bg-union-tint-10 text-union"
                  : "border-hair text-muted"
              )}
            >
              Everything
            </Link>

            <form method="get" action="/admin/audit" className="flex flex-wrap items-end gap-3">
              <Select
                label="Filter by event"
                name="event"
                defaultValue={named?.id ?? ""}
                wrapperClassName="w-[20rem]"
              >
                <option value="">Everything</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.title}
                  </option>
                ))}
              </Select>
              <Button size="sm" type="submit">
                Show
              </Button>
            </form>
          </div>

          {/* --- The log ---------------------------------------------- */}
          {filter.kind === "unknown" ? (
            <Alert tone="flare" className="my-6">
              <span className="block font-medium">That filter does not name an event</span>
              <span className="mt-1 block opacity-90">
                Nothing was read, because showing the whole log under a filter you asked
                for would be worse than showing nothing. The link or bookmark you followed
                points at an event that no longer exists, or the id in it is not an event
                id. Pick one above, or read{" "}
                <Link href="/admin/audit" className="link">
                  everything
                </Link>
                .
              </span>
            </Alert>
          ) : rows.length === 0 ? (
            <div className="py-6">
              <EmptyState>
                {named
                  ? `Nothing has been recorded against “${named.title}” yet.`
                  : "Nothing has been recorded yet. The log fills up from the first status change."}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-hair/60">
              {rows.map((row) => (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Badge
                      tone={row.tone === "flare" ? "flare" : row.tone === "union" ? "union" : "default"}
                    >
                      {row.label}
                    </Badge>

                    <span className="min-w-0 flex-1 text-14 leading-relaxed text-chalk">
                      {row.summary}
                    </span>

                    <span className="eyebrow shrink-0">
                      <LocalTime at={row.at.toISOString()} />
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-12 text-muted">
                    <span>
                      {row.actor.handle ? (
                        <Link
                          href={`/players/${row.actor.handle}`}
                          className="hover:text-union"
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
                        className="hover:text-union"
                      >
                        {row.event.title}
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {more && (
            <div className="pt-6 text-center">
              <Button
                href={`/admin/audit?${named ? `event=${named.id}&` : ""}show=${limit + PAGE}`}
                size="sm"
              >
                Show {plural(PAGE, "more line")}
              </Button>
            </div>
          )}
        </Section>

        <p className="pb-4 text-center text-12 text-muted">
          <ZoneNote /> The log is append-only: there is no code anywhere that updates or
          deletes a line.
        </p>
      </Page>
    </div>
  );
}
