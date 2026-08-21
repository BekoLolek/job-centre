"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Section,
  Panel,
  Select,
  Tabs,
  plural,
} from "@/components/ui";
import { EventRow, EventRows } from "@/components/events";
import type { ApplicationStatus, EventStatus } from "@/db/schema";
import type { EventSummary } from "@/lib/events";
import { createEventAction } from "@/app/admin/events/actions";

/**
 * `/admin/events`, client side.
 *
 * Two jobs: make an event, and find one. Neither holds any data of its own —
 * the create action revalidates the page and this component refreshes, so what
 * is on screen is the rows as Postgres has them rather than a client copy
 * drifting from them. The only local state is what is half-typed and which
 * filter is showing.
 *
 * The filter is client-side rather than a query string because the whole list
 * is already here: an admin flipping between Drafts and Published should not
 * wait for a round trip to hide four cards.
 */

export type EventListRow = {
  event: EventSummary;
  /** Every application, by status — including the ones that came to nothing. */
  applications: Record<ApplicationStatus, number>;
};

export type TemplateOption = {
  id: string;
  name: string;
  type: string;
  questions: number;
};

type Filter = "all" | EventStatus;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "published", label: "Published" },
  { value: "live", label: "Live" },
  { value: "complete", label: "Complete" },
  { value: "cancelled", label: "Cancelled" },
];

export default function EventsManager({
  rows,
  templates,
}: {
  rows: EventListRow[];
  templates: TemplateOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState("");

  const counts = useMemo(() => {
    const out = new Map<Filter, number>([["all", rows.length]]);
    for (const row of rows) {
      out.set(row.event.status, (out.get(row.event.status) ?? 0) + 1);
    }
    return out;
  }, [rows]);

  const shown = filter === "all" ? rows : rows.filter((row) => row.event.status === filter);

  const create = () => {
    const wanted = title.trim();
    if (!wanted) return;

    setError(null);
    startTransition(async () => {
      const result = await createEventAction({
        title: wanted,
        templateId: templateId || null,
      });
      if (!result.ok) return setError(result.error);
      setTitle("");
      // Straight into the editor: a new event is a title and nothing else, and
      // the next thing anybody wants is the tab where the rest goes.
      router.push(`/admin/events/${result.data.id}`);
    });
  };

  return (
    <div>
      {error && <Alert className="mb-6">{error}</Alert>}

      {/* --- Create ------------------------------------------------- */}
      <Section
        first
        icon="spark"
        title="New event"
        description="Starts as a draft nobody can see. You land in the editor with Basics open."
        className="rise"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Title"
            hint="“Rivals Summer Cup”, “Jackbox Friday”. The slug is made from it."
            value={title}
            maxLength={120}
            wrapperClassName="flex-1 min-w-[16rem]"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                create();
              }
            }}
          />

          <Select
            label="From a template"
            hint={
              templates.length === 0
                ? "No templates yet — everything starts from scratch."
                : "Copies the config and questions. Editing the template later leaves this event alone."
            }
            value={templateId}
            disabled={templates.length === 0}
            wrapperClassName="min-w-[14rem]"
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">Start from scratch</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {plural(template.questions, "question")}
              </option>
            ))}
          </Select>

          <Button variant="gold" disabled={pending || !title.trim()} onClick={create}>
            {pending ? "Creating…" : "Create draft"}
          </Button>
        </div>

      </Section>

      {/* --- The list ----------------------------------------------- */}
      <Section
        icon="calendar"
        title="All events"
        description="Newest first. Drafts included — they are only visible here."
        aside={
          <div className="flex flex-wrap items-center gap-3">
        <Tabs
          items={FILTERS.map((entry) => ({
            value: entry.value,
            label: `${entry.label} (${counts.get(entry.value) ?? 0})`,
          }))}
          value={filter}
          onChange={setFilter}
        />
          </div>
        }
      >
        {shown.length === 0 ? (
        <div className="py-10">
          <EmptyState>
            {rows.length === 0
              ? "No events yet. Make one above — it starts as a draft, so nothing goes public by accident."
              : `Nothing with that status. ${plural(rows.length, "event")} in total.`}
          </EmptyState>
        </div>
      ) : (
        <EventRows>
          {shown.map((row) => (
            <EventRow
              key={row.event.id}
              event={row.event}
              href={`/admin/events/${row.event.id}`}
              meta={<ApplicationTotals counts={row.applications} />}
            />
          ))}
        </EventRows>
        )}
      </Section>
    </div>
  );
}

/**
 * Applications that are not seats: declined and withdrawn.
 *
 * `EventCard` already shows the live counts from `capacityState`. These two are
 * the history behind them, and an admin scanning a list wants to know that the
 * event with four seats free has already turned six people away.
 */
function ApplicationTotals({ counts }: { counts: Record<ApplicationStatus, number> }) {
  const total = counts.accepted + counts.waitlisted + counts.declined + counts.withdrawn;
  if (total === 0) return <Badge>No applications</Badge>;

  return (
    <>
      <Badge tone="signal">{plural(total, "application")}</Badge>
      {counts.declined > 0 && <Badge tone="ember">{counts.declined} declined</Badge>}
      {counts.withdrawn > 0 && <Badge>{counts.withdrawn} withdrew</Badge>}
    </>
  );
}
