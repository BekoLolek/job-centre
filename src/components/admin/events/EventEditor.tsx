"use client";

import { useState } from "react";
import { Badge, Button, Eyebrow, Panel, Tabs, plural } from "@/components/ui";
import { EventDateRange, EventSeats, EventStatusPill, eventTypeLabel } from "@/components/events";
import type { ApplicantView, EventDetail } from "@/lib/events";
import ApplicantsTab from "./ApplicantsTab";
import BasicsTab from "./BasicsTab";
import CaptainsTab from "./CaptainsTab";
import DaysTab from "./DaysTab";
import DraftTab from "./DraftTab";
import EntryRulesTab from "./EntryRulesTab";
import PublishTab from "./PublishTab";
import QuestionsTab from "./QuestionsTab";
import TeamsTab from "./TeamsTab";
import type { DraftTabData, GameOption, LinkableField } from "./types";

/**
 * The event editor shell — plan §6.3.
 *
 * Nine tabs, each saving itself. The shell owns which tab is showing and
 * absolutely nothing else: no draft state is lifted up here, because a tab that
 * cannot be understood without reading its parent is a tab nobody will edit
 * with confidence.
 *
 * The header above the tabs is the part that has to be true on every one of
 * them — status, seats, queue length — because a decision made on the
 * Applicants tab changes what the Publish tab should say, and an admin should
 * not have to click to find that out.
 *
 * The three draft tabs share one `draft` bundle rather than fetching their own,
 * because they are three views of the same thing: the captain the middle tab
 * chooses is the roster row the last one prices. Tabs holding separate reads
 * could show a captain who is not yet on the roster the balance came from.
 */

type TabKey =
  | "basics"
  | "days"
  | "questions"
  | "rules"
  | "applicants"
  | "teams"
  | "captains"
  | "draft"
  | "publish";

export default function EventEditor({
  event,
  applicants,
  games,
  linkableFields,
  draft,
  maxDays,
  maxQuestions,
}: {
  event: EventDetail;
  applicants: ApplicantView[];
  games: GameOption[];
  linkableFields: LinkableField[];
  /** Teams, captains, rules and the pool — one read, three tabs. */
  draft: DraftTabData;
  /**
   * `MAX_EVENT_DAYS` / `MAX_EVENT_QUESTIONS`, handed down from the server page.
   * They live in `src/lib/events.ts`, which reaches the database — importing it
   * from a client component would drag Drizzle and PGlite into the browser
   * bundle for the sake of two integers.
   */
  maxDays: number;
  maxQuestions: number;
}) {
  const [tab, setTab] = useState<TabKey>("basics");

  const queue = applicants.filter((row) => row.status === "waitlisted").length;
  const undecided = applicants.filter(
    (row) => row.status === "waitlisted" && row.decidedAt === null
  ).length;
  const captains = draft.teams.filter((team) => team.captainUserId !== null).length;

  return (
    <div className="space-y-6">
      {/* --- Header ------------------------------------------------- */}
      <Panel as="header" className="rise">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <EventStatusPill status={event.status} />
              <Badge>{eventTypeLabel(event.type)}</Badge>
              {event.game && <Badge tone="gold">{event.game.name}</Badge>}
              {event.rankLadder.length > 0 && (
                <Badge>{plural(event.rankLadder.length, "rank")}</Badge>
              )}
            </div>

            <h1 className="font-display text-3xl leading-none tracking-wide">{event.title}</h1>
            <Eyebrow className="mt-2">/events/{event.slug}</Eyebrow>

            <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} />
              <EventSeats seats={event.seats} />
              <span className="num text-xs text-muted">
                {plural(event.days.length, "day")} · {plural(event.questions.length, "question")}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <Button href="/admin/events" size="sm">
              ← All events
            </Button>
            {event.status !== "draft" && (
              <Eyebrow as="span" className="text-muted/70">
                Visible to members
              </Eyebrow>
            )}
          </div>
        </div>
      </Panel>

      {/* --- Tabs --------------------------------------------------- */}
      <Tabs
        items={[
          { value: "basics", label: "Basics" },
          { value: "days", label: `Days (${event.days.length})` },
          { value: "questions", label: `Questions (${event.questions.length})` },
          { value: "rules", label: "Entry rules" },
          {
            value: "applicants",
            label: `Applicants (${applicants.length})${undecided > 0 ? " •" : ""}`,
          },
          { value: "teams", label: `Teams (${draft.teams.length})` },
          {
            value: "captains",
            label: `Captains (${captains}/${draft.teams.length})${
              draft.teams.length > 0 && captains < draft.teams.length ? " •" : ""
            }`,
          },
          { value: "draft", label: `Draft (${draft.pool.main.length})` },
          { value: "publish", label: "Publish" },
        ]}
        value={tab}
        onChange={setTab}
        className="overflow-x-auto"
      />

      {tab === "basics" && <BasicsTab event={event} games={games} />}
      {tab === "days" && <DaysTab event={event} maxDays={maxDays} />}
      {tab === "questions" && (
        <QuestionsTab
          event={event}
          applicants={applicants}
          linkableFields={linkableFields}
          maxQuestions={maxQuestions}
        />
      )}
      {tab === "rules" && <EntryRulesTab event={event} />}
      {tab === "applicants" && <ApplicantsTab event={event} applicants={applicants} />}
      {tab === "teams" && <TeamsTab eventId={event.id} data={draft} />}
      {tab === "captains" && (
        <CaptainsTab
          eventId={event.id}
          event={event}
          applicants={applicants}
          data={draft}
        />
      )}
      {tab === "draft" && (
        <DraftTab eventId={event.id} applicants={applicants} data={draft} />
      )}
      {tab === "publish" && (
        <PublishTab event={event} applicants={applicants} queue={queue} />
      )}
    </div>
  );
}
