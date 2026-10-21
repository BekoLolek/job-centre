"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  StatTile,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  Tabs,
  Textarea,
  cx,
  plural,
} from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import {
  AVAILABILITY_CHOICES,
  applicationStatusLabel,
  applicationStatusTone,
  availabilityMark,
  availabilityTone,
  confirmationBadge,
  whenText,
} from "@/components/events";
import type { ApplicationStatus, AvailabilityState, EntryRule } from "@/db/schema";
import type { ApplicantView, EventDetail, EventResult } from "@/lib/events";
import {
  type ApplicationDecision,
  type Eligibility,
  dayName,
  entryMode,
} from "@/lib/events-policy";
import { formatAnswer } from "@/lib/profile-fields";
import {
  decideApplicationAction,
  saveApplicationNoteAction,
  setApplicantAvailabilityAction,
} from "@/app/admin/events/actions";
import {
  type WaiverListResult,
  type WaiverRow,
  listEntryWaiversAction,
  revokeEntryWaiverAction,
  waiveEntryRuleAction,
  waiveEnterRuleByHandleAction,
} from "@/app/admin/events/waiver-actions";

/**
 * Applicants — the table that matters on the night.
 *
 * Everything on it is `getApplicationsForEvent`'s: the order (accepted first in
 * submission order, then the queue in *its* order, then the decided-against),
 * the rank, and the eligibility verdict. None of it is recomputed here, because
 * a second implementation of "does this person clear the bar" is a second
 * implementation that will one day disagree with the one the member saw.
 *
 * ## Two things this screen refuses to do quietly
 *
 * **It says who a freed seat let in.** UC-14 6 is not a choice the manager
 * makes any more: declining or queueing somebody who held a seat promotes the
 * front of the queue, in the same transaction, and tells them both. This screen
 * used to *offer* that promotion instead, which meant an admin who closed the
 * banner left a seat empty with somebody queueing for it. So the promotion has
 * already happened by the time the banner appears, and the banner names who.
 *
 * **It never hides somebody who is below the bar.** §8.3's thresholds are
 * guidance; the row says "below Platinum III" and the Accept button still
 * works, which is the admin override the plan insists must exist.
 *
 * ## The over-cap question is the server's, not this screen's
 *
 * Accepting past the cap (UC-14 3a) is refused the first time, with `confirm`
 * on the refusal, and this screen turns that into the ask. It is written that
 * way round on purpose: `decideApplicationAction` is a public POST endpoint, so
 * a confirmation that only existed here would be one a direct call skips. What
 * is here is the wording; what is enforced is in `src/lib/events.ts`.
 */

type Filter = "all" | ApplicationStatus;

/**
 * The one line the collapsed row gives a manager about eligibility — and
 * whether a **waiver** is what put it there (R-59 / UC-14 3b).
 *
 * `canEnter` and `canCaptain` fold the waiver in, which is right for the gate
 * and wrong for this line: read on their own they say "Eligible" about somebody
 * a manager let past the bar, and `Eligibility.enterWaived`'s docblock in
 * `src/lib/events-policy.ts` says in as many words why that is the one thing
 * this screen may not do — "a waiver rendered as though the member met the bar
 * hides the one fact a manager may later want to revisit". The collapsed row is
 * what a manager scans; opening every applicant to find out who was waived is
 * the same as not being told.
 *
 * `enterWaived` and `captainWaived` are already "a waiver is the *only* reason"
 * — a waiver on a rule the member now clears is reported by neither — so this
 * names what is true today and not what was once granted.
 *
 * Exported for the test beside it, like `showsSaveAsTemplate` in `EventEditor`:
 * the words are the rule, and a rule stated as a string can be asserted
 * without rendering the table around it.
 */
export function eligibilityNote(eligibility: Eligibility): {
  label: string;
  /** An existing tint, not a new one: red for refused, union for a waiver. */
  tone: string;
} {
  if (!eligibility.canEnter) return { label: "Below the bar", tone: "text-flare" };
  if (eligibility.enterWaived) {
    return {
      label: eligibility.canCaptain ? "Can captain · entry waived" : "Entry waived",
      tone: "text-union",
    };
  }
  if (eligibility.captainWaived) {
    return { label: "Can captain · waived", tone: "text-union" };
  }
  return { label: eligibility.canCaptain ? "Can captain" : "Eligible", tone: "text-muted" };
}

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  // UC-14 2: filterable by status, and in an approval event (R-27) the one
  // status that is a to-do list comes first.
  { value: "pending", label: "Awaiting review" },
  { value: "accepted", label: "Accepted" },
  { value: "waitlisted", label: "Queue" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn", label: "Withdrew" },
];

/** An accept the server has refused once, pending the manager's second ask. */
type OverCapAsk = {
  row: ApplicantView;
  name: string;
  capacity: number;
  accepted: number;
};

export default function ApplicantsTab({
  event,
  applicants,
}: {
  event: EventDetail;
  applicants: ApplicantView[];
}) {
  const router = useRouter();

  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<OverCapAsk | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [overCapacity, setOverCapacity] = useState(false);

  /*
   * This event's entry-rule waivers (R-59 / UC-14 3b).
   *
   * Read here rather than handed down with `applicants`, because a waiver can
   * exist for somebody who has *no* application — that is the whole of the
   * Gate-2 amendment, and `applyToEvent` refuses a below-rank member before a
   * row is written, so the only list they could appear on is this one. Null
   * means "not read yet", which the panel says rather than drawing an empty
   * list that looks like an answer.
   */
  const [waivers, setWaivers] = useState<WaiverRow[] | null>(null);
  const [waiverBusy, setWaiverBusy] = useState(false);
  const [waiverError, setWaiverError] = useState<string | null>(null);
  const [waiverNote, setWaiverNote] = useState<string | null>(null);
  const [handle, setHandle] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const result = await listEntryWaiversAction(event.id);
        if (live && result.ok) setWaivers(result.data.waivers);
      } catch {
        // Leave it at "reading…": a panel that cannot load is not a reason to
        // break the table, which is what matters on the night.
      }
    })();
    return () => {
      live = false;
    };
  }, [event.id]);

  /**
   * One waiver write, with its own busy flag so the table stays usable.
   *
   * Returns whether it landed, which is what tells the handle field whether to
   * clear itself: emptying it after a refused handle would take away the one
   * thing the manager needs to correct.
   */
  const runWaiver = async (
    write: () => Promise<EventResult<WaiverListResult>>,
    note: string
  ): Promise<boolean> => {
    setWaiverBusy(true);
    setWaiverError(null);
    setWaiverNote(null);
    try {
      const result = await write();
      if (!result.ok) {
        setWaiverError(result.error);
        return false;
      }
      setWaivers(result.data.waivers);
      setWaiverNote(note);
      // Every row's verdict is server-rendered from the same waivers, so the
      // table is stale the moment one is written or withdrawn.
      router.refresh();
      return true;
    } catch {
      setWaiverError("Could not reach the server. Nothing was changed.");
      return false;
    } finally {
      setWaiverBusy(false);
    }
  };

  const waiveFor = (userId: string, rule: EntryRule, name: string) =>
    void runWaiver(
      () => waiveEntryRuleAction(event.id, userId, rule),
      `${rule === "enter" ? "Entry" : "Captain"} rule waived for ${name}.`
    );

  const revokeFor = (userId: string, rule: EntryRule, name: string) =>
    void runWaiver(
      () => revokeEntryWaiverAction(event.id, userId, rule),
      `${rule === "enter" ? "Entry" : "Captain"} waiver withdrawn for ${name}.`
    );

  const nameOf = (row: ApplicantView) =>
    row.member.displayName ?? row.member.discordId ?? "Unknown member";

  const counts = new Map<Filter, number>([["all", applicants.length]]);
  for (const row of applicants) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  /*
   * Seats whose holder has said they are not sure (R-199, UC-13 extensions E4).
   *
   * Only from `accepted`: a maybe from the queue is not an uncertain seat, it
   * is somebody uncertain about a seat they have not got. Nothing in the site
   * resolves these — that is the decision (UC-13 5b) — so the number on screen
   * is the entire mechanism by which a manager knows there is one to resolve.
   */
  const unsure = applicants.filter(
    (row) => row.status === "accepted" && row.confirmation === "maybe"
  ).length;

  const shown = filter === "all" ? applicants : applicants.filter((row) => row.status === filter);

  /** Who this decision would move up, for the sentence afterwards. */
  const nameOfId = (applicationId: string): string => {
    const row = applicants.find((entry) => entry.id === applicationId);
    return row ? nameOf(row) : "somebody from the queue";
  };

  const decide = async (
    row: ApplicantView,
    status: ApplicationDecision,
    options: { confirmOverCapacity?: boolean } = {}
  ) => {
    setBusyId(row.id);
    setError(null);
    setAsk(null);
    setMoved(null);
    try {
      const result = await decideApplicationAction(row.id, status, {
        confirmOverCapacity: options.confirmOverCapacity,
      });
      if (!result.ok) {
        // UC-14 3a: not a no, a question. Nothing has been written yet.
        if (result.confirm) {
          setAsk({
            row,
            name: nameOf(row),
            capacity: result.confirm.capacity,
            accepted: result.confirm.accepted,
          });
          return;
        }
        setError(result.error);
        return;
      }

      setOverCapacity(result.data.overCapacity);

      // UC-14 6: the seat has already gone to the front of the queue. Report it.
      if (result.data.promoted.length > 0) {
        setMoved(
          result.data.promoted.length === 1
            ? `${nameOfId(result.data.promoted[0].id)} moved off the queue into the free seat.`
            : `${plural(result.data.promoted.length, "person", "people")} moved off the queue into the free seats.`
        );
      }

      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {overCapacity && (
        <Alert tone="union">
          This event is over its capacity of {event.seats.capacity}. That is allowed — an
          override is the point of §8.3 — but nothing will stop you doing it again, so it is
          worth being deliberate.
        </Alert>
      )}

      {/*
        UC-13 extensions E4, made legible. An unresolved "Not sure" keeps its
        seat and the site will never take it back — so if nothing says so here,
        decision and inaction look identical and the seat sits on a maybe until
        the night. No clock is consulted: the sentence is as true a week out as
        it is after the answer has closed, and reading `new Date()` during a
        client render to sharpen the wording would buy a hydration mismatch for
        an adjective.
      */}
      {unsure > 0 && (
        <Alert tone="union">
          <span className="block font-medium">
            {plural(unsure, "seat")} held by somebody who is not sure
          </span>
          <span className="mt-1 block opacity-90">
            They said &quot;not sure yet&quot;, which keeps the seat — nothing here will
            take it off them, by design. Chase them, or decline and let the queue have
            it; either way it is your call, not a rule that fires overnight.
          </span>
        </Alert>
      )}

      {moved && (
        <Alert tone="success">
          <span className="block font-medium">The seat went to the next in line</span>
          <span className="mt-1 block opacity-90">{moved}</span>
        </Alert>
      )}

      {ask && (
        <Alert tone="union">
          <span className="block font-medium">
            That would put this event over its cap of {ask.capacity}
          </span>
          <span className="mt-1 block opacity-90">
            {ask.accepted} already hold a seat. Accepting{" "}
            <span className="text-chalk">{ask.name}</span> makes it {ask.accepted + 1}. The cap
            stays where it is — nothing has been changed yet.
          </span>
          <span className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="union"
              onClick={() => void decide(ask.row, "accepted", { confirmOverCapacity: true })}
            >
              Accept anyway
            </Button>
            <Button size="sm" onClick={() => setAsk(null)}>
              Leave the cap alone
            </Button>
          </span>
        </Alert>
      )}

      {/* --- The three numbers, always on screen -------------------- */}
      <Panel as="section" padding="none" className="border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap gap-8">
          <StatTile
            label="Seats left"
            value={event.seats.seatsLeft === null ? "∞" : event.seats.seatsLeft}
            valueClassName={
              event.seats.seatsLeft === 0 ? "text-union" : "text-body"
            }
          />
          <StatTile
            label="Accepted"
            value={
              event.seats.capacity === null
                ? event.seats.accepted
                : `${event.seats.accepted}/${event.seats.capacity}`
            }
          />
          <StatTile
            label="In the queue"
            value={event.seats.waitlisted}
            valueClassName={event.seats.waitlisted > 0 ? "text-union" : "text-muted"}
          />
          {entryMode(event.config) === "approval" && (
            <StatTile
              label="Awaiting review"
              value={counts.get("pending") ?? 0}
              valueClassName={(counts.get("pending") ?? 0) > 0 ? "text-union" : "text-muted"}
            />
          )}
          <StatTile
            label="Not sure"
            value={unsure}
            valueClassName={unsure > 0 ? "text-union" : "text-muted"}
          />
          <StatTile label="Applications" value={applicants.length} />
          {event.days.length > 0 && (
            <StatTile label="Days" value={event.days.length} valueClassName="text-muted" />
          )}
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          items={FILTERS.map((entry) => ({
            value: entry.value,
            label: entry.label,
            count: counts.get(entry.value) ?? 0,
          }))}
          value={filter}
          onChange={setFilter}
          className="overflow-x-auto overflow-y-hidden"
        />
        <Eyebrow as="span" className="text-dim">
          Accepted first, then the queue in order
        </Eyebrow>
      </div>

      {applicants.length === 0 ? (
        <Panel>
          <EmptyState>
            Nobody has applied yet.{" "}
            {event.status === "draft"
              ? "This event is still a draft, so nobody can."
              : "Applications follow the signup window, set under Setup → Basics."}
          </EmptyState>
        </Panel>
      ) : (
        <Panel padding="none" className="overflow-x-auto overflow-y-hidden">
          <Table className="min-w-[820px]">
            <TableHead>
              <TableHeadCell>Member</TableHeadCell>
              <TableHeadCell>Status</TableHeadCell>
              {/*
                UC-14 2 lists the confirmation, and until now the only place it
                appeared was the expanded row — which means an unresolved "Not
                sure" (UC-13 extensions E4) was invisible unless the manager
                opened every applicant one at a time. A decision nobody can see
                is not a decision they can make.
              */}
              <TableHeadCell>Coming?</TableHeadCell>
              <TableHeadCell>Rank</TableHeadCell>
              <TableHeadCell>Submitted</TableHeadCell>
              {/* The stored `dayIndex`, like the day rows in the expanded
                  applicant below: a header numbering the columns by position
                  while the rows name days by their index would be two answers
                  to "which day is D2?" on one screen. */}
              {event.days.map((day) => (
                <TableHeadCell key={day.id} align="right">
                  D{day.dayIndex + 1}
                </TableHeadCell>
              ))}
              <TableHeadCell align="right">Decide</TableHeadCell>
            </TableHead>

            <TableBody>
              {shown.map((row) => (
                <ApplicantRow
                  key={row.id}
                  row={row}
                  event={event}
                  name={nameOf(row)}
                  open={openId === row.id}
                  busy={busyId === row.id}
                  onToggle={() => setOpenId(openId === row.id ? null : row.id)}
                  onDecide={(status) => void decide(row, status)}
                  onChanged={() => router.refresh()}
                  onError={setError}
                  waiverBusy={waiverBusy}
                  onWaive={(rule) => waiveFor(row.member.id, rule, nameOf(row))}
                  onRevoke={(rule) => revokeFor(row.member.id, rule, nameOf(row))}
                />
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}

      {shown.length === 0 && applicants.length > 0 && (
        <Panel>
          <EmptyState>Nobody with that status.</EmptyState>
        </Panel>
      )}

      {/* --- Who has been let past a rank rule (R-59 / UC-14 3b) ---- */}
      {(event.minRankToEnter || event.minRankToCaptain) && (
        <Panel
          as="section"
          padding="none"
          className="space-y-3 border-t border-hair pt-12 first:border-t-0 first:pt-0"
        >
          <Eyebrow>Entry-rule waivers</Eyebrow>
          <p className="text-14 text-muted">
            A waiver lets one member past one of this event&apos;s rank rules —{" "}
            {event.minRankToEnter ? `${event.minRankToEnter} to enter` : "no rule to enter"},{" "}
            {event.minRankToCaptain
              ? `${event.minRankToCaptain} to captain`
              : "no rule to captain"}
            . It is a decision, not a setting: it is recorded against the manager who gave it
            and it appears in the audit log. The entry one can be given{" "}
            <span className="text-chalk">before</span> somebody applies, which is the only way
            a below-rank member can apply at all.
          </p>

          {waiverError && <Alert>{waiverError}</Alert>}
          {waiverNote && (
            <Eyebrow as="p" className="text-success">
              ✓ {waiverNote}
            </Eyebrow>
          )}

          {waivers === null ? (
            <EmptyState size="sm">Reading this event&apos;s waivers…</EmptyState>
          ) : waivers.length === 0 ? (
            <EmptyState size="sm">
              Nobody has been let past a rank rule on this event.
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {waivers.map((waiver) => (
                <li
                  key={`${waiver.userId}-${waiver.rule}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-hair p-3"
                >
                  <span className="text-14 text-chalk">{waiver.member}</span>
                  <Badge tone="union">
                    {waiver.rule === "enter" ? "May enter" : "May captain"}
                  </Badge>
                  <span className="text-12 text-muted" suppressHydrationWarning>
                    {waiver.grantedBy ? `Given by ${waiver.grantedBy}` : "Given by an admin"} ·{" "}
                    {whenText(waiver.waivedAt) ?? "—"}
                  </span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={waiverBusy}
                    onClick={() => revokeFor(waiver.userId, waiver.rule, waiver.member)}
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {event.minRankToEnter && (
            <div className="space-y-2 border-t border-hair pt-3">
              <Field
                label="Waive the entry rule for somebody who cannot apply yet"
                hint="Their handle — the last part of their player-profile link. They are refused before an application exists, so they are on no list here."
                value={handle}
                maxLength={60}
                onChange={(input) => setHandle(input.target.value)}
              />
              <Button
                size="sm"
                disabled={waiverBusy || handle.trim() === ""}
                onClick={() =>
                  void (async () => {
                    const landed = await runWaiver(
                      () => waiveEnterRuleByHandleAction(event.id, handle),
                      `Entry rule waived for ${handle.trim()}.`
                    );
                    if (landed) setHandle("");
                  })()
                }
              >
                {waiverBusy ? "Saving…" : "Waive the entry rule"}
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One applicant                                                      */
/* ------------------------------------------------------------------ */

function ApplicantRow({
  row,
  event,
  name,
  open,
  busy,
  onToggle,
  onDecide,
  onChanged,
  onError,
  waiverBusy,
  onWaive,
  onRevoke,
}: {
  row: ApplicantView;
  event: EventDetail;
  name: string;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onDecide: (status: ApplicationDecision) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  waiverBusy: boolean;
  onWaive: (rule: EntryRule) => void;
  onRevoke: (rule: EntryRule) => void;
}) {
  const columns = 6 + event.days.length;
  const badge = confirmationBadge(row.confirmation);
  const note = eligibilityNote(row.eligibility);

  return (
    <>
      <TableRow className={cx(busy && "opacity-50")}>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <span className="font-mono text-12 text-muted">{open ? "▾" : "▸"}</span>
            <Avatar name={name} size="sm" />
            <span className="min-w-0">
              <span className="block truncate text-14">{name}</span>
              {row.waitlistPosition !== null && (
                <span className="eyebrow block">Queue #{row.waitlistPosition}</span>
              )}
            </span>
          </button>
        </TableCell>

        <TableCell>
          <StatusPill
            status={applicationStatusTone(row.status)}
            label={applicationStatusLabel(row.status)}
          />
        </TableCell>

        <TableCell>
          {badge ? (
            <Badge tone={badge.tone}>{badge.label}</Badge>
          ) : (
            // Silence, said as silence, and not as a tinted chip: "Not sure"
            // is an answer and gets a badge, this is the absence of one, and
            // telling them apart is the whole of R-199.
            <span className="text-12 text-muted">No answer</span>
          )}
        </TableCell>

        <TableCell>
          <span className="block text-14">{row.rank ?? "—"}</span>
          <span className={cx("eyebrow block", note.tone)}>{note.label}</span>
        </TableCell>

        <TableCell numeric className="text-12 text-muted" suppressHydrationWarning>
          {whenText(row.submittedAt) ?? "—"}
        </TableCell>

        {event.days.map((day) => (
          <TableCell key={day.id} align="right">
            <span className={cx("num", availabilityTone(row.availability[day.id]))}>
              {availabilityMark(row.availability[day.id])}
            </span>
          </TableCell>
        ))}

        <TableCell align="right">
          <span className="inline-flex gap-1">
            <Button
              size="sm"
              disabled={busy || row.status === "accepted"}
              onClick={() => onDecide("accepted")}
            >
              Accept
            </Button>
            <Button
              size="sm"
              disabled={busy || row.status === "waitlisted"}
              onClick={() => onDecide("waitlisted")}
            >
              Queue
            </Button>
            <Button
              size="sm"
              variant="flare"
              disabled={busy || row.status === "declined"}
              onClick={() => onDecide("declined")}
            >
              Decline
            </Button>
          </span>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow>
          <TableCell colSpan={columns} className="bg-ink/40">
            <ApplicantDetail
              row={row}
              event={event}
              name={name}
              onChanged={onChanged}
              onError={onError}
              waiverBusy={waiverBusy}
              onWaive={onWaive}
              onRevoke={onRevoke}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The expanded applicant: their answers, the gate, the waivers and the days.
 *
 * Exported for the tests beside it, the way `EventEditor` exports
 * `SaveAsTemplate`. It is reached by clicking a row, so a static render of the
 * tab never contains it — and the day rows below are a surface that names days
 * (UC-08 E3), which `src/components/__tests__/day-names.test.ts` holds every
 * one of to the same rule. A surface no test can reach is how the `label ?? …`
 * copy survived here after the other three were ported.
 */
export function ApplicantDetail({
  row,
  event,
  name,
  onChanged,
  onError,
  waiverBusy,
  onWaive,
  onRevoke,
}: {
  row: ApplicantView;
  event: EventDetail;
  name: string;
  onChanged: () => void;
  onError: (message: string) => void;
  waiverBusy: boolean;
  onWaive: (rule: EntryRule) => void;
  onRevoke: (rule: EntryRule) => void;
}) {
  const [note, setNote] = useState(row.note ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [busyDay, setBusyDay] = useState<string | null>(null);

  const badge = confirmationBadge(row.confirmation);

  const saveNote = async () => {
    setSavingNote(true);
    setSavedNote(false);
    try {
      const result = await saveApplicationNoteAction(row.id, note.trim() || null);
      if (!result.ok) onError(result.error);
      else {
        setSavedNote(true);
        onChanged();
      }
    } catch {
      onError("Could not reach the server. The note was not saved.");
    } finally {
      setSavingNote(false);
    }
  };

  const setDay = async (dayId: string, state: AvailabilityState | null) => {
    setBusyDay(dayId);
    try {
      const result = await setApplicantAvailabilityAction(row.id, { [dayId]: state }, event.id);
      if (!result.ok) onError(result.error);
      else onChanged();
    } catch {
      onError("Could not reach the server.");
    } finally {
      setBusyDay(null);
    }
  };

  return (
    <div className="grid gap-6 py-3 lg:grid-cols-2">
      {/* --- Answers ------------------------------------------------ */}
      <section className="space-y-3">
        <Eyebrow>What {name} said</Eyebrow>

        {event.questions.length === 0 ? (
          <EmptyState size="sm">This event asks nothing — there is no form.</EmptyState>
        ) : (
          <dl className="space-y-2">
            {event.questions.map((question) => (
              <div key={question.id} className="flex flex-wrap gap-x-3 border-b border-hair/40 pb-2">
                <dt className="eyebrow min-w-[9rem] flex-1 text-chalk/70">
                  {question.label}
                  {question.required && <span className="text-union"> *</span>}
                </dt>
                <dd className="min-w-0 flex-[2] text-14">
                  {formatAnswer(
                    {
                      type: question.type,
                      label: question.label,
                      options: question.options,
                      rankLadder: event.rankLadder,
                    },
                    row.answers[question.id] ?? null
                  )}
                  {/*
                    For a question linked to a profile detail, when the member
                    last said that answer is still right (R-49 / UC-12 3).
                    `confirmed_at > updated_at` is the difference between "they
                    checked this when they applied" and "nobody has looked at
                    this since March", which is what a manager seeding a draft
                    off somebody's rank wants to know. Only linked questions
                    have one — an own answer is given on the application and
                    carries no stamp. `LocalTime` keeps the formatting in the
                    reader's browser.
                  */}
                  {row.answerConfirmedAt[question.id] && (
                    <span className="mt-0.5 block text-12 text-muted">
                      confirmed{" "}
                      <LocalTime at={row.answerConfirmedAt[question.id]} format="day" />
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div className="border-t border-hair pt-3">
          <Eyebrow className="mb-1">Eligibility</Eyebrow>
          <p className={cx("text-12", row.eligibility.canEnter ? "text-muted" : "text-flare")}>
            {row.eligibility.enterReason}
          </p>
          {/*
            Tinted from `meetsCaptainRule`, which is the rule the server
            enforces (`setCaptains`, R-59 / UC-15 3a) — `CaptainsTab` reads the
            same answer. `canCaptain` folds the *entry* rule back in, so it
            would warn about a captain rule that is met and nobody is holding.
          */}
          <p
            className={cx(
              "mt-1 text-12",
              row.eligibility.meetsCaptainRule ? "text-muted" : "text-union"
            )}
          >
            {row.eligibility.captainReason}
          </p>
          {!row.eligibility.canEnter && (
            <p className="mt-2 text-12 text-muted">
              Accept still works. §8.3 is explicit that gates are guidance and an override
              must exist.
            </p>
          )}

          {/*
            The waiver, per rule (R-59 / UC-14 3b).

            Offered on an applicant who does not clear a rule, and withdrawable
            on one who has been let past it — including somebody who has since
            climbed the ladder, which is why `row.waived` and not
            `eligibility.enterWaived` decides whether there is one to withdraw.
            A waiver on a rule they now meet changes nothing, and a manager
            tidying up should be able to see it and take it away.

            The captain rule is normally waived from the Captains tab, where the
            pick is being made; it can be withdrawn here because this is the
            screen that lists what has been granted.
          */}
          {(event.minRankToEnter || event.minRankToCaptain) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-3">
              {row.waived.enter ? (
                <>
                  <Badge tone="union">Entry rule waived</Badge>
                  <Button size="sm" disabled={waiverBusy} onClick={() => onRevoke("enter")}>
                    Withdraw it
                  </Button>
                </>
              ) : (
                event.minRankToEnter &&
                !row.eligibility.enterCheck.ok && (
                  <Button size="sm" disabled={waiverBusy} onClick={() => onWaive("enter")}>
                    Waive the entry rule
                  </Button>
                )
              )}

              {row.waived.captain ? (
                <>
                  <Badge tone="union">Captain rule waived</Badge>
                  <Button size="sm" disabled={waiverBusy} onClick={() => onRevoke("captain")}>
                    Withdraw it
                  </Button>
                </>
              ) : (
                event.minRankToCaptain &&
                !row.eligibility.captainCheck.ok && (
                  <Button size="sm" disabled={waiverBusy} onClick={() => onWaive("captain")}>
                    Waive the captain rule
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      </section>

      {/* --- Availability and note ---------------------------------- */}
      <section className="space-y-4">
        <div>
          <Eyebrow className="mb-2">Availability</Eyebrow>
          {event.days.length === 0 ? (
            <EmptyState size="sm">
              This event has no days, so there was nothing to ask.
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {event.days.map((day) => (
                <div key={day.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[9rem] text-12">
                    {/* `dayName` is the one rule for what a day is called
                        (UC-08 E3), numbered from the stored `dayIndex` rather
                        than this row's position — the two things the `Day
                        {index + 1}` / `label ?? …` pair here got wrong. The
                        date follows it, as it does on every other surface. */}
                    <span className="num text-muted">{dayName(day, day.dayIndex)}</span>{" "}
                    <span suppressHydrationWarning className="text-chalk/70">
                      {whenText(day.startsAt) ?? "No date"}
                    </span>
                  </span>
                  <ChoiceRow>
                    {AVAILABILITY_CHOICES.map((choice) => {
                      const on = row.availability[day.id] === choice.value;
                      return (
                        <ChoiceChip
                          key={choice.value}
                          selected={on}
                          disabled={busyDay === day.id}
                          onClick={() =>
                            void setDay(day.id, on ? null : (choice.value as AvailabilityState))
                          }
                        >
                          {choice.label}
                        </ChoiceChip>
                      );
                    })}
                  </ChoiceRow>
                </div>
              ))}
              <p className="text-12 text-muted">
                Theirs to answer, but yours to correct — “he messaged me, he can make
                Saturday after all”. Tapping the lit chip clears it again.
              </p>
            </div>
          )}
        </div>

        <div className="border-t border-hair pt-3">
          <Textarea
            label="Admin note"
            hint="Only admins see this. Saving it never changes their place in the queue."
            className="h-20"
            value={note}
            maxLength={500}
            onChange={(input) => {
              setNote(input.target.value);
              setSavedNote(false);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <Button size="sm" disabled={savingNote} onClick={() => void saveNote()}>
              {savingNote ? "Saving…" : "Save note"}
            </Button>
            {savedNote && (
              <Eyebrow as="span" className="text-success">
                ✓ Saved
              </Eyebrow>
            )}
            {/*
              Three answers, three tones, and words that say what the member
              said. This used to read `Confirmed {state}` on a success-or-flare
              tone, which produced "Confirmed out" for somebody who had said
              the opposite of confirming — and left no tone for "Not sure",
              which would have been painted as a refusal. See
              `confirmationBadge`.
            */}
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          </div>
        </div>
      </section>
    </div>
  );
}
