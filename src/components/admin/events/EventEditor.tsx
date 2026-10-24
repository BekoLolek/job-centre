"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  Eyebrow,
  Field,
  Icon,
  PageHeader,
  Tabs,
  cx,
  plural,
} from "@/components/ui";
import { EventDateRange, EventSeats, EventStatusPill, eventTypeLabel } from "@/components/events";
import type { ApplicantView, EventDetail } from "@/lib/events";
import type { ManualAnnouncementPanel } from "@/lib/discord";
import ApplicantsTab from "./ApplicantsTab";
import BasicsTab from "./BasicsTab";
import CaptainsTab from "./CaptainsTab";
import ChampionshipTab from "./ChampionshipTab";
import DaysTab from "./DaysTab";
import DraftTab from "./DraftTab";
import EntryRulesTab from "./EntryRulesTab";
import FormatTab from "./FormatTab";
import PublishTab from "./PublishTab";
import QuestionsTab from "./QuestionsTab";
import ResultsTab from "./ResultsTab";
import ScheduleTab from "./ScheduleTab";
import ScoringTab from "./ScoringTab";
import ShapeTab from "./ShapeTab";
import TeamsTab from "./TeamsTab";
import UnsavedChangesProvider, { useIsDirty, useNavigationLock } from "./UnsavedChanges";
import {
  PEOPLE_KEYS,
  SETUP_LABELS,
  STEP_KEYS,
  type SetupKey,
  TAB_LABELS,
  type TabKey,
  type TabVisibility,
  standingOn,
  standingOnPanel,
  visibleSetup,
  visibleTabs,
} from "./tabs";
import { eventShapeFrom, roundScoringFrom } from "@/lib/events-policy";
import type { RoundScoreRow } from "@/lib/round-scoring";
// The pure half of the templates library, deliberately: `@/lib/admin-templates`
// builds every Drizzle table at import time and a client bundle has no use for
// any of it.
import { TEMPLATE_OMITS } from "@/lib/admin-templates-policy";
import { createTemplateFromEventAction } from "@/app/admin/templates/actions";
import type {
  ChampionshipTabData,
  DraftTabData,
  FormatTabData,
  GameOption,
  LinkableField,
} from "./types";

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
 * throughout and that belong to no step at all. The rail says that: the steps
 * on the left, with the underline filling in as far as you have got, and the
 * people screens on the right past a divider, where nothing fills in.
 *
 * ## Leaving
 *
 * Everything is wrapped in {@link UnsavedChangesProvider}, so a step with
 * unsaved edits cannot be left until it is saved or discarded. Discarding is a
 * remount — `resetKey` changes, React throws the subtree away, and every panel
 * seeds itself from props again. That resets fields nobody thought to list,
 * which a hand-written undo would not.
 *
 * ## Saving the setup as a template
 *
 * UC-08 10a, and **admins only** — see {@link SaveAsTemplate}. The header is
 * where it goes rather than one of the Setup panels, because what it captures
 * is the event as a whole and not the panel you happen to be looking at.
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
  /**
   * Why the editor did not open on the tab the URL asked for (UC-42 5a).
   *
   * The sentence is `landOn`'s, computed on the server because `?tab=` is read
   * there — see `tabs.ts`. It is shown once, standing, and cleared the moment
   * the admin picks a tab for themselves: it explains a redirect that has
   * already happened, so it must not keep explaining it.
   */
  tabNotice?: string | null;
  applicants: ApplicantView[];
  games: GameOption[];
  linkableFields: LinkableField[];
  /** Teams, captains, rules and the pool — one read, three panels. */
  draft: DraftTabData;
  /** Stages, matches, blocks and the schedule settings — one read, three panels. */
  format: FormatTabData;
  /** Which season this event counts towards, and which it could (UC-32). */
  championship: ChampionshipTabData;
  /**
   * Every recorded round score, from `listRoundScores` (UC-44 2b, 3a, 4d).
   *
   * The Scoring panel counts these before it refuses — how many scores a lower
   * round count discards, how many awards a deleted bonus takes back. Read on
   * the server because `src/lib/round-scores.ts` reaches Postgres.
   */
  roundScores: RoundScoreRow[];
  /**
   * The five announcements this event can post by hand, as the server read
   * them (R-221 / UC-43) — the switches, the claims and the refusals.
   *
   * Handed down rather than read by the Publish tab, for the reason `maxDays`
   * is: `manualAnnouncementPanel` lives in `src/lib/discord.ts`, which reaches
   * Postgres, and a client component importing it would drag Drizzle and PGlite
   * into the browser bundle.
   */
  announcements: ManualAnnouncementPanel;
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
  /**
   * Whether the reader is an admin, rather than a host who was given this one
   * event (R-22 / UC-08 10a).
   *
   * Only "Save as template" reads it, and only to decide whether to offer
   * itself: the refusal that matters is the server's, in
   * `createTemplateFromEventAction`. Optional and **false when absent**, so a
   * caller that has not thought about it hides an admin control rather than
   * showing one — see {@link showsSaveAsTemplate}.
   */
  isAdmin?: boolean;
};

function EditorBody({
  event,
  initialTab = "setup",
  initialSetup = "basics",
  tabNotice = null,
  applicants,
  games,
  linkableFields,
  draft,
  format,
  championship,
  roundScores,
  announcements,
  maxDays,
  maxQuestions,
  maxStages,
  isAdmin,
  resetKey,
}: EventEditorProps & { resetKey: number }) {
  // Seeded from the URL, then owned here. Deep-linking is what makes an admin
  // dashboard line actionable; keeping the URL in step afterwards is not worth
  // a router push per click on a page that is already `force-dynamic`.
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [setup, setSetup] = useState<SetupKey>(initialSetup);
  const [redirected, setRedirected] = useState<string | null>(tabNotice);
  const guard = useNavigationLock();

  const queue = applicants.filter((row) => row.status === "waitlisted").length;
  const accepted = applicants.filter((row) => row.status === "accepted").length;
  const undecided = applicants.filter(
    (row) => row.status === "waitlisted" && row.decidedAt === null
  ).length;
  const captains = draft.teams.filter((team) => team.captainUserId !== null).length;

  /*
   * R-219. Derived from the event's own stored config rather than taken as a
   * prop, because there is then no prop for a page to forget to pass: the
   * editor and the Format panel read one function over one key, and the server
   * page reads the same one to decide where a `?tab=` lands.
   */
  const shape = eventShapeFrom(event.config);
  const shown = visibleTabs(shape);

  /*
   * A tab can stop applying while the admin is standing on it — turn teams off
   * from Setup and the Teams tab goes — so the body never trusts `tab` alone.
   * The decision is `standingOn`'s, not this component's, because reaching that
   * state needs a click and this suite has nothing to click: as two lines here
   * it was a guard no test could kill. See that function's docblock.
   */
  const stood = standingOn(tab, shape, redirected);
  const here = stood.here;
  /*
   * The same, one level down: the Scoring panel goes when teams are turned on
   * from the Format panel beside it (UC-44 6b). `standingOnPanel` decides, for
   * the reason `standingOn` does.
   */
  const panel = standingOnPanel(setup, shape, stood.notice);
  const notice = panel.notice;

  // Rows, not resolved slots: `formatFor` resolves a stage's matches from its
  // generated spec whether or not it has been generated, so counting those
  // would put "0/6 played" on a step with nothing in the database.
  const allMatches = format.view.stages
    .flatMap((stage) => stage.matches)
    .filter((match) => format.matchIds[match.slot]);
  const playedMatches = allMatches.filter((match) => match.status === "done").length;
  const needsDecision = allMatches.filter((match) => match.needsDecision).length;

  const go = (next: TabKey) =>
    guard(() => {
      setRedirected(null);
      setTab(next);
    });

  return (
    <div className="space-y-6">
      {/*
        --- Header -------------------------------------------------
        `/admin/events/[id]` hands its page header here, the way the
        championship routes hand theirs to `Season`: the title, the state and
        the counts are all derived from the editor's own `event`, and a copy of
        them in the route file would be a second place for them to disagree.
        The eyebrow is `Admin · Events`, the same label `ADMIN_SECTIONS` gives
        the link in the bar; the public address moved down into the intro, which
        is where the rest of what-is-true-about-this-event already was.
      */}
      <div>
        <PageHeader
          eyebrow="Admin · Events"
          title={event.title}
          intro={
            <>
              <span className="flex flex-wrap items-center gap-2">
                <EventStatusPill status={event.status} />
                <Badge>{eventTypeLabel(event.type)}</Badge>
                {event.game && <Badge tone="union">{event.game.name}</Badge>}
                {event.rankLadder.length > 0 && (
                  <Badge>{plural(event.rankLadder.length, "rank")}</Badge>
                )}
              </span>
              <span className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="num text-12 text-muted">/events/{event.slug}</span>
                <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} />
                <EventSeats seats={event.seats} />
                <span className="num text-12 text-muted">
                  {plural(event.days.length, "day")} ·{" "}
                  {plural(event.questions.length, "question")}
                </span>
              </span>
            </>
          }
          aside={
            <div className="flex flex-col items-end gap-2">
              <Button href="/admin/events" size="sm">
                ← All events
              </Button>
              {event.status !== "draft" && (
                <Eyebrow as="span" className="text-dim">
                  Visible to members
                </Eyebrow>
              )}
            </div>
          }
        />

        <SaveAsTemplate eventId={event.id} title={event.title} isAdmin={isAdmin} />
      </div>

      {/* --- The rail ----------------------------------------------- */}
      <div className="flex flex-wrap items-stretch gap-x-8 gap-y-1 overflow-x-auto overflow-y-hidden shadow-rail">
        <StepRail current={here} onGo={go} />

        {/*
          The people screens. Same rail, same underline, but past a divider —
          they are not steps you complete, they are three lists you keep coming
          back to while you work through the steps, so nothing about them fills
          in as you go.

          Drawn from `visibleTabs` rather than written out, so a solo event
          loses Teams and Captains from here without this block knowing the rule
          (R-219). Applicants is in every configuration — there is no event
          whose applicants do not matter.
        */}
        <div className="flex items-stretch gap-6 sm:border-l sm:border-hair sm:pl-8">
          {PEOPLE_KEYS.filter((key) => shown.includes(key)).map((key) => (
            <RailLink
              key={key}
              label={TAB_LABELS[key]}
              count={
                key === "applicants"
                  ? applicants.length
                  : key === "teams"
                    ? draft.teams.length
                    : captains
              }
              dot={
                key === "applicants"
                  ? undecided > 0
                  : key === "captains"
                    ? draft.teams.length > 0 && captains < draft.teams.length
                    : false
              }
              current={here === key}
              onClick={() => go(key)}
            />
          ))}
        </div>
      </div>

      {/*
        UC-42 5a. The one thing hiding a tab must not do is strand somebody on
        it: a bookmark or an `/admin` action line naming a tab this event no
        longer has lands here, on a real screen, with the reason.
      */}
      {notice && (
        <Alert tone="union" standing>
          {notice}
        </Alert>
      )}

      {/*
        `resetKey` is in the key, so discarding rebuilds whichever panel is
        showing from its props. `tab` is in it too — a panel that stays mounted
        across a switch would carry one step's scroll and focus into the next.
      */}
      <div key={`${here}-${resetKey}`}>
        {here === "setup" && (
          <Setup
            current={panel.here}
            onGo={(next) => guard(() => setSetup(next))}
            event={event}
            shape={shape}
            counts={{ days: event.days.length, questions: event.questions.length }}
          >
            {panel.here === "basics" && <BasicsTab event={event} games={games} />}
            {panel.here === "days" && <DaysTab event={event} maxDays={maxDays} />}
            {panel.here === "questions" && (
              <QuestionsTab
                event={event}
                applicants={applicants}
                linkableFields={linkableFields}
                maxQuestions={maxQuestions}
              />
            )}
            {panel.here === "rules" && <EntryRulesTab event={event} />}
            {panel.here === "championship" && (
              <ChampionshipTab eventId={event.id} data={championship} />
            )}
            {panel.here === "shape" && (
              <ShapeTab
                eventId={event.id}
                shape={shape}
                accepted={accepted}
                existingTeams={draft.teams.length}
                draftStarted={draft.started}
              />
            )}
            {panel.here === "scoring" && (
              <ScoringTab
                eventId={event.id}
                scoring={roundScoringFrom(event.config)}
                rows={roundScores}
                players={draft.players}
              />
            )}
          </Setup>
        )}

        {here === "draft" && (
          <DraftTab eventId={event.id} applicants={applicants} data={draft} />
        )}
        {here === "format" && (
          <FormatTab
            eventId={event.id}
            format={format.view}
            matchIds={format.matchIds}
            maxStages={maxStages}
            shape={shape}
            accepted={accepted}
            capacity={event.seats.capacity}
          />
        )}
        {here === "schedule" && (
          <ScheduleTab
            eventId={event.id}
            event={event}
            format={format.view}
            settings={format.settings}
            matchIds={format.matchIds}
          />
        )}
        {here === "results" && (
          <ResultsTab
            format={format.view}
            matchIds={format.matchIds}
            /*
             * UC-45. Everything the round sheet reads is already here — the
             * setup off `event.config`, the rows the page read, the names
             * the draft bundle carries, the accepted applicants and the
             * status — so the tab is handed one bundle and reads nothing of
             * its own. See `RoundScoresData`.
             */
            rounds={{
              scoring: roundScoringFrom(event.config),
              rows: roundScores,
              players: draft.players,
              seated: applicants
                .filter((row) => row.status === "accepted")
                .map((row) => row.member.id),
              status: event.status,
            }}
          />
        )}
        {here === "publish" && (
          <PublishTab
            event={event}
            applicants={applicants}
            queue={queue}
            announcements={announcements}
          />
        )}

        {here === "applicants" && <ApplicantsTab event={event} applicants={applicants} />}
        {here === "teams" && (
          <TeamsTab eventId={event.id} applicants={applicants} data={draft} shape={shape} />
        )}
        {here === "captains" && (
          <CaptainsTab eventId={event.id} event={event} applicants={applicants} data={draft} />
        )}
      </div>
    </div>
  );

  /**
   * The sequence, in the order an event actually happens.
   *
   * The underline fills in rather than jumping: on Format, Setup and Draft are
   * underlined too. That is the one thing a step rail can say that a tab row
   * cannot — how far along you are — and it says it without a number beside
   * every word. The steps sit flush against each other so the underlines meet
   * and read as one bar growing to the right, which is the whole point; a gap
   * between them would make it six marks instead of one measure.
   *
   * Reached-but-not-current is a dimmer blue, so "where am I" and "how far have
   * I got" are two different readings of the same bar.
   *
   * ## The sequence is shorter on some events (R-219)
   *
   * `STEP_KEYS` filtered by `visibleTabs`, rather than six entries written out
   * here. A solo event's sequence really is Setup → Schedule → Results →
   * Publish, and the bar still fills in across it because the positions are
   * read off the list that is drawn and not off a fixed six. **Nothing in this
   * function knows which tabs are conditional** — that is `tabs.ts`'s to say,
   * so a seventh step cannot arrive and be forgotten here.
   *
   * The labels come off `TAB_LABELS` for the same reason, which is also how the
   * bracket step reads **"Bracket"**: the word "Format" now belongs to the
   * Setup panel, and `tabs.ts` is where that trade is recorded.
   */
  function StepRail({ current, onGo }: { current: TabKey; onGo: (next: TabKey) => void }) {
    const counts: Partial<Record<TabKey, number>> = {
      draft: draft.pool.main.length,
      format: format.view.stages.length,
      schedule: format.view.days,
      results: playedMatches,
    };

    const steps = STEP_KEYS.filter((key) => shown.includes(key));

    // -1 when a people screen is showing, which leaves the bar empty — right,
    // because Applicants is not a point along this sequence.
    const at = steps.indexOf(current);

    return (
      <div className="flex items-stretch">
        {steps.map((key, index) => (
          <RailLink
            key={key}
            label={TAB_LABELS[key]}
            count={counts[key]}
            dot={key === "results" ? needsDecision > 0 : undefined}
            current={current === key}
            reached={at >= 0 && index < at}
            joined
            onClick={() => onGo(key)}
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
  label,
  count,
  dot,
  current,
  reached = false,
  joined = false,
  onClick,
}: {
  label: string;
  count?: number;
  dot?: boolean;
  current: boolean;
  /** A step before the current one — underlined, but not where you are. */
  reached?: boolean;
  /** Sits flush against its neighbours so the underlines meet. */
  joined?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current}
      onClick={onClick}
      className={cx(
        // No negative margin: the rail's rule is an inset shadow, so an
        // underline covers it from inside. See `TabNav.tsx`.
        "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2",
        "pb-2.5 pt-1 text-13 font-medium transition-colors",
        joined ? "px-3 first:pl-0" : "",
        current
          ? "border-union text-chalk"
          : reached
            ? "border-union/45 text-muted hover:text-chalk"
            : "border-transparent text-muted hover:border-hair hover:text-chalk"
      )}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={cx(
            "num text-12 tabular-nums transition-colors",
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

/* ------------------------------------------------------------------ */
/* Save as template (UC-08 10a)                                       */
/* ------------------------------------------------------------------ */

/**
 * Whether to offer "Save as template" at all (R-22 / UC-08 10a).
 *
 * `=== true` rather than a truthiness check, so an absent prop — a caller that
 * has not been told who is reading — hides the control instead of offering an
 * admin's button to a host. Exported because which readers are offered an
 * admin-only control is a fact about the product rather than about rendering,
 * and it is the half of this that a Node test can hold on to.
 *
 * This is **not** the authorisation. `createTemplateFromEventAction` is, and it
 * is `requireAdmin()`: a host who finds the action some other way is refused by
 * the server, which is the only refusal that counts. Hiding the control is so a
 * host is not shown a button that would bounce them to the sign-in page.
 */
export function showsSaveAsTemplate(isAdmin: boolean | undefined): boolean {
  return isAdmin === true;
}

/**
 * Turn this event's setup into a template, from the editor (UC-08 10a, UC-28 3a).
 *
 * ## Why it is admin-only, and where that is decided
 *
 * A host is given one event. Minting a template changes what *every* future
 * event starts from, which is an admin's decision about the site and not a
 * manager's decision about their evening — so R-22 says admin, and UC-08 10a
 * says so again in brackets.
 *
 * The server action is where that is enforced, and it is worth saying why it is
 * sound rather than assuming it: the row being written is a new
 * `event_templates` row, which belongs to nobody in particular, so the question
 * is simply "is this reader an admin" and `requireAdmin()` answers it. The
 * `eventId` travelling alongside is only *read*. If this ever wrote to the
 * event as well, `requireAdmin` would not be enough on its own and the event
 * would have to be authorised from its own row — `src/lib/event-scope.ts` is
 * the standing note on that, and the rule it states is **authorise on the row
 * you are about to write, never on an id beside it**.
 *
 * ## Why a dirty editor is refused
 *
 * The template is built from the event *as stored* — `createTemplateFromEvent`
 * reads it back out of Postgres. Minting one while a panel has unsaved edits
 * would quietly capture the old setup and nothing on screen would say so, so
 * the attempt goes through the same lock as a tab switch and flashes the
 * unsaved-changes bar instead.
 *
 * ## What it carries
 *
 * Exactly what `createTemplateFromEvent` carries, and the omissions are named
 * on screen from `TEMPLATE_OMITS` — the same list `/admin/templates` prints —
 * rather than described again here, so the two screens cannot drift apart. A
 * template is a *setup*: no applicants, no teams, no results.
 *
 * Exported for its own test. It renders nothing at all for a host, which is the
 * assertion worth having: the gate and the markup are tested together, because
 * a gate nothing consults is not a gate.
 */
export function SaveAsTemplate({
  eventId,
  title,
  isAdmin,
}: {
  eventId: string;
  title: string;
  isAdmin: boolean | undefined;
}) {
  const guard = useNavigationLock();
  const dirty = useIsDirty();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const save = () => {
    setError(null);
    setMade(null);
    startTransition(async () => {
      const result = await createTemplateFromEventAction(eventId, {
        name: name.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMade(result.data.name);
      setName("");
      setOpen(false);
    });
  };

  // After the hooks, never before them: the same component must run the same
  // hooks on every render of the same mount.
  if (!showsSaveAsTemplate(isAdmin)) return null;

  return (
    <div className="mt-4 border-t border-hair pt-4">
      {!open && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => guard(() => setOpen(true))}>
            Save as template
          </Button>
          {made ? (
            <p className="text-12 text-muted">
              Saved as “{made}”. It is in the create-event picker now.
            </p>
          ) : (
            <p className="text-12 text-muted">
              {dirty
                ? "Save or discard your changes first — a template is made from the event as stored."
                : "Starts the next event of this shape from this one's setup, dates aside."}
            </p>
          )}
        </div>
      )}

      {open && (
        <div>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Template name"
              hint="Defaults to this event's title. Rename it on the templates page later."
              value={name}
              maxLength={80}
              placeholder={title}
              wrapperClassName="flex-1 min-w-[14rem]"
              onChange={(field) => setName(field.target.value)}
            />
            <Button variant="union" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Make template"}
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>

          <p className="mt-3 text-12 leading-relaxed text-muted">
            Carried over: the kind, the game, the whole question set, the format and
            sign-up settings, the seat cap, both rank rules and the day names. Not carried
            over: {TEMPLATE_OMITS.join(", ")} — nor the applicants, the teams or the
            results, which belong to this event and not to a shape you reuse.
          </p>

          {error && <Alert className="mt-3">{error}</Alert>}
        </div>
      )}
    </div>
  );
}

/**
 * Setup: the screens that are all answering "what is this event".
 *
 * They are one decision described six ways — what it is, when it runs, what
 * you have to tell us, who is allowed in, what it counts towards, and what
 * shape it is — so they are one step with a secondary rail, rather than six
 * steps that each look as significant as running the draft.
 *
 * Format is near the end although it decides the most, and that is
 * deliberate: it is the answer you give once and change rarely, and putting it
 * first would make every admin walk past it to reach Basics. Scoring follows
 * it because it only exists for one of Format's answers.
 *
 * ## The rail is read off `tabs.ts`, not written out here (UC-44 6b)
 *
 * `visibleSetup` filtered by the shape, the way the step rail reads
 * `visibleTabs`: a team event has no Scoring panel, and nothing in this
 * function knows which panel is conditional — that is `setupHiddenBecause`'s
 * to say, so an eighth panel cannot arrive and be forgotten here. The two
 * counts are the only per-panel knowledge left, and they are the rail's own.
 */
function Setup({
  current,
  onGo,
  shape,
  counts,
  children,
}: {
  current: SetupKey;
  onGo: (next: SetupKey) => void;
  event: EventDetail;
  shape: TabVisibility;
  counts: { days: number; questions: number };
  children: React.ReactNode;
}) {
  const count: Partial<Record<SetupKey, number>> = {
    days: counts.days,
    questions: counts.questions,
  };
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 items-center gap-3">
        <Icon name="clipboard" className="shrink-0 text-dim" />
        <Tabs
          className="min-w-0 flex-1"
          aria-label="Setup"
          size="sm"
          rule={false}
          value={current}
          onChange={onGo}
          items={visibleSetup(shape).map((key) => ({
            value: key,
            label: SETUP_LABELS[key],
            count: count[key],
          }))}
        />
      </div>
      {children}
    </div>
  );
}
