"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
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
import {
  AVAILABILITY_CHOICES,
  applicationStatusLabel,
  applicationStatusTone,
  availabilityMark,
  availabilityTone,
  whenText,
} from "@/components/events";
import type { ApplicationStatus, AvailabilityState } from "@/db/schema";
import type { ApplicantView, EventDetail } from "@/lib/events";
import { type ApplicationDecision, entryMode } from "@/lib/events-policy";
import { formatAnswer } from "@/lib/profile-fields";
import {
  decideApplicationAction,
  saveApplicationNoteAction,
  setApplicantAvailabilityAction,
} from "@/app/admin/events/actions";

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

  const nameOf = (row: ApplicantView) =>
    row.member.displayName ?? row.member.discordId ?? "Unknown member";

  const counts = new Map<Filter, number>([["all", applicants.length]]);
  for (const row of applicants) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

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
              <TableHeadCell>Rank</TableHeadCell>
              <TableHeadCell>Submitted</TableHeadCell>
              {event.days.map((day, index) => (
                <TableHeadCell key={day.id} align="right">
                  D{index + 1}
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
}) {
  const columns = 5 + event.days.length;

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
          <span className="block text-14">{row.rank ?? "—"}</span>
          <span
            className={cx(
              "eyebrow block",
              row.eligibility.canEnter ? "text-muted" : "text-flare"
            )}
          >
            {row.eligibility.canEnter
              ? row.eligibility.canCaptain
                ? "Can captain"
                : "Eligible"
              : "Below the bar"}
          </span>
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
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ApplicantDetail({
  row,
  event,
  name,
  onChanged,
  onError,
}: {
  row: ApplicantView;
  event: EventDetail;
  name: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState(row.note ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [busyDay, setBusyDay] = useState<string | null>(null);

  const saveNote = async () => {
    setSavingNote(true);
    setSavedNote(false);
    try {
      const result = await saveApplicationNoteAction(row.id, note.trim() || null, event.id);
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
          <p
            className={cx(
              "mt-1 text-12",
              row.eligibility.canCaptain ? "text-muted" : "text-union"
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
              {event.days.map((day, index) => (
                <div key={day.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[9rem] text-12">
                    <span className="num text-muted">Day {index + 1}</span>{" "}
                    <span suppressHydrationWarning className="text-chalk/70">
                      {day.label ?? whenText(day.startsAt) ?? "No date"}
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
            {row.confirmation && (
              <Badge tone={row.confirmation === "in" ? "success" : "flare"}>
                Confirmed {row.confirmation}
              </Badge>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
