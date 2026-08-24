"use client";

import { useState } from "react";
import { Badge, Button, Eyebrow, Icon, Panel, Tabs, cx, plural } from "@/components/ui";
import { EventDateRange, EventSeats, EventStatusPill, eventTypeLabel } from "@/components/events";
import type { ApplicantView, EventDetail } from "@/lib/events";
import ApplicantsTab from "./ApplicantsTab";
import BasicsTab from "./BasicsTab";
import CaptainsTab from "./CaptainsTab";
import DaysTab from "./DaysTab";
import DraftTab from "./DraftTab";
import EntryRulesTab from "./EntryRulesTab";
import FormatTab from "./FormatTab";
import PublishTab from "./PublishTab";
import QuestionsTab from "./QuestionsTab";
import ResultsTab from "./ResultsTab";
import ScheduleTab from "./ScheduleTab";
import TeamsTab from "./TeamsTab";
import UnsavedChangesProvider, { useNavigationLock } from "./UnsavedChanges";
import type { SetupKey, TabKey } from "./tabs";
import type { DraftTabData, FormatTabData, GameOption, LinkableField } from "./types";

/**
 * The event editor shell — plan §6.3.
 *
 * Each panel saves itself. The shell owns which one is showing and absolutely
 * nothing else: no draft state is lifted up here, because a panel that cannot
 * be understood without reading its parent is one nobody will edit with
 * confidence.
 *
 * The header above the rail is the part that has to be true everywhere —
 * status, seats, queue length — because a decision made on Applicants changes
 * what Publish should say, and an admin should not have to click to find out.
 *
 * The three draft panels share one `draft` bundle rather than fetching their
 * own, because they are three views of the same thing: the captain one chooses
 * is the roster row another prices. Separate reads could show a captain who is
 * not yet on the roster the balance came from. The format panels share one
 * `format` bundle for the same reason, and it is a stronger case — the shape
 * Format generates *is* the block plan Schedule lays out and *is* the cards
 * Results records against.
 *
 * ## The rail
 *
 * Twelve tabs in one row asked the admin to hold the whole event in their head
 * and pick. It is really a short sequence — set up, draft, format, schedule,
 * results, publish — with three reference screens that you open again and again
 * throughout and that belong to no step at all. The rail says that: numbered
 * steps on the left, people on the right, a hairline between them.
 *
 * ## Leaving
 *
 * Everything is wrapped in {@link UnsavedChangesProvider}, so a step with
 * unsaved edits cannot be left until it is saved or discarded. Discarding is a
 * remount — `resetKey` changes, React throws the subtree away, and every panel
 * seeds itself from props again. That resets fields nobody thought to list,
 * which a hand-written undo would not.
 */

export default function EventEditor(props: EventEditorProps) {
  // Bumping this rebuilds the panel from its props, which *is* the discard.
  const [resetKey, setResetKey] = useState(0);

  return (
    <UnsavedChangesProvider onDiscard={() => setResetKey((n) => n + 1)}>
      <EditorBody {...props} resetKey={resetKey} />
    </UnsavedChangesProvider>
  );
}

type EventEditorProps = {
  event: EventDetail;
  /** Which step to open on, from `?tab=` — see {@link tabFrom}. */
  initialTab?: TabKey;
  /** Which Setup panel to open on — see {@link setupFrom}. */
  initialSetup?: SetupKey;
  applicants: ApplicantView[];
  games: GameOption[];
  linkableFields: LinkableField[];
  /** Teams, captains, rules and the pool — one read, three panels. */
  draft: DraftTabData;
  /** Stages, matches, blocks and the schedule settings — one read, three panels. */
  format: FormatTabData;
  /**
   * `MAX_EVENT_DAYS` / `MAX_EVENT_QUESTIONS`, handed down from the server page.
   * They live in `src/lib/events.ts`, which reaches the database — importing it
   * from a client component would drag Drizzle and PGlite into the browser
   * bundle for the sake of two integers.
   */
  maxDays: number;
  maxQuestions: number;
  /** `MAX_STAGES`, for the same reason — `src/lib/format.ts` reaches Postgres. */
  maxStages: number;
};

function EditorBody({
  event,
  initialTab = "setup",
  initialSetup = "basics",
  applicants,
  games,
  linkableFields,
  draft,
  format,
  maxDays,
  maxQuestions,
  maxStages,
  resetKey,
}: EventEditorProps & { resetKey: number }) {
  // Seeded from the URL, then owned here. Deep-linking is what makes an admin
  // dashboard line actionable; keeping the URL in step afterwards is not worth
  // a router push per click on a page that is already `force-dynamic`.
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [setup, setSetup] = useState<SetupKey>(initialSetup);
  const guard = useNavigationLock();

  const queue = applicants.filter((row) => row.status === "waitlisted").length;
  const undecided = applicants.filter(
    (row) => row.status === "waitlisted" && row.decidedAt === null
  ).length;
  const captains = draft.teams.filter((team) => team.captainUserId !== null).length;

  // Rows, not resolved slots: `formatFor` resolves a stage's matches from its
  // generated spec whether or not it has been generated, so counting those
  // would put "0/6 played" on a step with nothing in the database.
  const allMatches = format.view.stages
    .flatMap((stage) => stage.matches)
    .filter((match) => format.matchIds[match.slot]);
  const playedMatches = allMatches.filter((match) => match.status === "done").length;
  const needsDecision = allMatches.filter((match) => match.needsDecision).length;

  const go = (next: TabKey) => guard(() => setTab(next));

  return (
    <div className="space-y-6">
      {/* --- Header ------------------------------------------------- */}
      <Panel as="header" padding="none" className="rise">
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

            <h1 className="text-3xl">{event.title}</h1>
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
              <Eyebrow as="span" className="text-dim">
                Visible to members
              </Eyebrow>
            )}
          </div>
        </div>
      </Panel>

      {/* --- The rail ----------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-1 border-b border-hair">
        <StepRail current={tab} onGo={go} />

        {/*
          The people screens. Same rail, same underline, but past a divider and
          without numbers, because they are not a step you complete — they are
          three lists you keep coming back to while you work through the steps.
        */}
        <div className="flex items-end gap-6 sm:border-l sm:border-hair sm:pl-8">
          <RailLink
            label="Applicants"
            count={applicants.length}
            dot={undecided > 0}
            current={tab === "applicants"}
            onClick={() => go("applicants")}
          />
          <RailLink
            label="Teams"
            count={draft.teams.length}
            current={tab === "teams"}
            onClick={() => go("teams")}
          />
          <RailLink
            label="Captains"
            count={captains}
            dot={draft.teams.length > 0 && captains < draft.teams.length}
            current={tab === "captains"}
            onClick={() => go("captains")}
          />
        </div>
      </div>

      {/*
        `resetKey` is in the key, so discarding rebuilds whichever panel is
        showing from its props. `tab` is in it too — a panel that stays mounted
        across a switch would carry one step's scroll and focus into the next.
      */}
      <div key={`${tab}-${resetKey}`}>
        {tab === "setup" && (
          <Setup
            current={setup}
            onGo={(next) => guard(() => setSetup(next))}
            event={event}
            counts={{ days: event.days.length, questions: event.questions.length }}
          >
            {setup === "basics" && <BasicsTab event={event} games={games} />}
            {setup === "days" && <DaysTab event={event} maxDays={maxDays} />}
            {setup === "questions" && (
              <QuestionsTab
                event={event}
                applicants={applicants}
                linkableFields={linkableFields}
                maxQuestions={maxQuestions}
              />
            )}
            {setup === "rules" && <EntryRulesTab event={event} />}
          </Setup>
        )}

        {tab === "draft" && (
          <DraftTab eventId={event.id} applicants={applicants} data={draft} />
        )}
        {tab === "format" && (
          <FormatTab
            eventId={event.id}
            format={format.view}
            matchIds={format.matchIds}
            maxStages={maxStages}
          />
        )}
        {tab === "schedule" && (
          <ScheduleTab
            eventId={event.id}
            event={event}
            format={format.view}
            settings={format.settings}
            matchIds={format.matchIds}
          />
        )}
        {tab === "results" && (
          <ResultsTab eventId={event.id} format={format.view} matchIds={format.matchIds} />
        )}
        {tab === "publish" && (
          <PublishTab event={event} applicants={applicants} queue={queue} />
        )}

        {tab === "applicants" && <ApplicantsTab event={event} applicants={applicants} />}
        {tab === "teams" && <TeamsTab eventId={event.id} data={draft} />}
        {tab === "captains" && (
          <CaptainsTab eventId={event.id} event={event} applicants={applicants} data={draft} />
        )}
      </div>
    </div>
  );

  /** The numbered sequence, in the order an event actually happens. */
  function StepRail({ current, onGo }: { current: TabKey; onGo: (next: TabKey) => void }) {
    const steps: Array<{ key: TabKey; label: string; count?: number; dot?: boolean }> = [
      { key: "setup", label: "Setup" },
      { key: "draft", label: "Draft", count: draft.pool.main.length },
      { key: "format", label: "Format", count: format.view.stages.length },
      { key: "schedule", label: "Schedule", count: format.view.days },
      {
        key: "results",
        label: "Results",
        count: playedMatches,
        dot: needsDecision > 0,
      },
      { key: "publish", label: "Publish" },
    ];

    return (
      <div className="flex items-end gap-6">
        {steps.map((step, index) => (
          <RailLink
            key={step.key}
            index={index + 1}
            label={step.label}
            count={step.count}
            dot={step.dot}
            current={current === step.key}
            onClick={() => onGo(step.key)}
          />
        ))}
      </div>
    );
  }
}

/**
 * One item on the rail.
 *
 * Hand-rolled rather than `<Tabs>` because the rail is two groups sharing one
 * rule, and a component that draws its own rule cannot do that. The look is
 * the same on purpose — see `TabNav.tsx` for why it is an underline and not a
 * button.
 */
function RailLink({
  index,
  label,
  count,
  dot,
  current,
  onClick,
}: {
  /** The step number, when this is a step. */
  index?: number;
  label: string;
  count?: number;
  dot?: boolean;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current}
      onClick={onClick}
      className={cx(
        "relative -mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2",
        "pb-3 pt-1 text-[13.5px] font-medium transition-colors",
        current
          ? "border-union text-chalk"
          : "border-transparent text-muted hover:border-hair hover:text-chalk"
      )}
    >
      {index !== undefined && (
        <span
          className={cx(
            "num text-[11px] tabular-nums transition-colors",
            current ? "text-union" : "text-dim"
          )}
        >
          {index}
        </span>
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={cx(
            "num text-[12px] tabular-nums transition-colors",
            current ? "text-muted" : "text-dim"
          )}
        >
          {count}
        </span>
      )}
      {dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-flare" />}
    </button>
  );
}

/**
 * Setup: the four screens that were all answering "what is this event".
 *
 * They are one decision described four ways — what it is, when it runs, what
 * you have to tell us, who is allowed in — so they are one step with a
 * secondary rail, rather than four steps that each look as significant as
 * running the draft.
 */
function Setup({
  current,
  onGo,
  counts,
  children,
}: {
  current: SetupKey;
  onGo: (next: SetupKey) => void;
  event: EventDetail;
  counts: { days: number; questions: number };
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Icon name="clipboard" className="text-dim" />
        <Tabs
          aria-label="Setup"
          size="sm"
          rule={false}
          value={current}
          onChange={onGo}
          items={[
            { value: "basics", label: "Basics" },
            { value: "days", label: "Days", count: counts.days },
            { value: "questions", label: "Questions", count: counts.questions },
            { value: "rules", label: "Entry rules" },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
