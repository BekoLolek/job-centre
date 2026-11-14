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
import EventStatusControls from "./EventStatusControls";

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
 *
 * ## The two jobs are two powers (R-265 / UC-56 2)
 *
 * Making an event is `events.create`; finding one to work on is
 * `events.manage`. The page admits a holder of either and says which they
 * hold, and each half is drawn only for the reader it would work for:
 * `createEventAction` refuses anybody without the first, and the editor every
 * row links to refuses anybody who does not manage that event. Neither prop
 * is the refusal - the action and the editor's own guard are.
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

/**
 * Where "Create draft" takes whoever pressed it: the new event's editor, or
 * `null` for nowhere - they stay on this list.
 *
 * Making an event does not make its maker a manager of it
 * (`createEventAction`), and the editor is on `requireEventManager`, which
 * sends anybody else to `/me`. A holder of `events.create` alone used to be
 * pushed there by this very button the moment the action succeeded. The guard
 * is right and stays as it is; what was wrong was the push.
 *
 * Exported for the test that walks the flow, like `showsSaveAsTemplate` in
 * `EventEditor`: where a button leaves somebody is a fact about the product.
 */
export function editorAfterCreate(mayManage: boolean, eventId: string): string | null {
  return mayManage ? `/admin/events/${eventId}` : null;
}

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
  mayCreate,
  mayManage,
}: {
  /** Every event, for a reader who manages them; nothing for one who does not. */
  rows: EventListRow[];
  templates: TemplateOption[];
  /** The reader holds `events.create`, or is an admin: the form is theirs. */
  mayCreate: boolean;
  /** The reader holds `events.manage`, or is an admin: every editor opens for them. */
  mayManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
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
    setMade(null);
    startTransition(async () => {
      const result = await createEventAction({
        title: wanted,
        templateId: templateId || null,
      });
      if (!result.ok) return setError(result.error);
      setTitle("");
      // Straight into the editor: a new event is a title and nothing else, and
      // the next thing anybody wants is the tab where the rest goes. Unless
      // the editor is not theirs to open - then they stay, and are told the
      // draft exists and whose move it is.
      const editor = editorAfterCreate(mayManage, result.data.id);
      if (editor) return router.push(editor);
      setMade(wanted);
      router.refresh();
    });
  };

  return (
    <div>
      {error && <Alert className="mb-6">{error}</Alert>}

      {/* --- Create ------------------------------------------------- */}
      {mayCreate && (
      <Section
        first
        icon="spark"
        title="New event"
        description={
          mayManage
            ? "Starts as a draft nobody can see. You land in the editor with Basics open."
            : "Starts as a draft nobody can see. Creating events is yours; setting one up is not, so the draft waits here for somebody who manages events."
        }
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

          <Button variant="union" disabled={pending || !title.trim()} onClick={create}>
            {pending ? "Creating…" : "Create draft"}
          </Button>
        </div>

        {made && (
          <p role="status" className="mt-3 text-13 leading-relaxed text-success">
            Created &ldquo;{made}&rdquo; as a draft. It is waiting for somebody who manages
            events to set it up and publish it.
          </p>
        )}
      </Section>
      )}

      {/* --- The list ----------------------------------------------- */}
      {mayManage && (
      <Section
        first={!mayCreate}
        icon="calendar"
        title="All events"
        description="Newest first. Drafts included — they are only visible here."
      >
        {/*
          The status filter was a `Section` aside, opposite the heading. An
          aside is wrapped in `shrink-0` — it has to be, or a two-word count
          would wrap mid-phrase — and `Tabs` is a scroller, so at 375px the
          seven statuses could neither shrink nor scroll and took the page
          476px wide instead. Here it is ordinary section content, inside the
          `min-w-0` column, and the scroller `Tabs` already has does its job.
        */}
        <div className="mb-6 min-w-0">
          <Tabs
            aria-label="Status"
            rule={false}
            size="sm"
            items={FILTERS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              count: counts.get(entry.value) ?? 0,
            }))}
            value={filter}
            onChange={setFilter}
          />
        </div>

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
              trailing={
                <EventStatusControls eventId={row.event.id} status={row.event.status} />
              }
            />
          ))}
        </EventRows>
        )}
      </Section>
      )}
    </div>
  );
}

/**
 * Applications that are not seats: awaiting review, declined and withdrawn.
 *
 * `EventCard` already shows the live counts from `capacityState`. These are the
 * history behind them, and an admin scanning a list wants to know that the
 * event with four seats free has already turned six people away — or that an
 * approval event (R-27) has three applications nobody has looked at.
 */
function ApplicationTotals({ counts }: { counts: Record<ApplicationStatus, number> }) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return <Badge>No applications</Badge>;

  return (
    <>
      <Badge tone="success">{plural(total, "application")}</Badge>
      {counts.pending > 0 && <Badge tone="union">{counts.pending} awaiting review</Badge>}
      {counts.declined > 0 && <Badge tone="flare">{counts.declined} declined</Badge>}
      {counts.withdrawn > 0 && <Badge>{counts.withdrawn} withdrew</Badge>}
    </>
  );
}
