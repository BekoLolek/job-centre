"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApplyDay } from "@/components/apply/ApplyForm";
import {
  AVAILABILITY_CHOICES,
  EventAction,
  EventDateRange,
  EventSeats,
  EventStatusPill,
  applicationStatusLabel,
  applicationStatusTone,
  eventTypeLabel,
  type ViewerAction,
} from "@/components/events";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  Eyebrow,
  Modal,
  Panel,
  StatusPill,
  cx,
  plural,
} from "@/components/ui";
import type {
  ApplicationStatus,
  AvailabilityState,
  ConfirmationState,
  EventStatus,
} from "@/db/schema";
import type { CapacityState } from "@/lib/events-policy";
import {
  setMyAvailabilityAction,
  setMyConfirmationAction,
  withdrawFromEventAction,
} from "@/app/me/events/actions";

/**
 * One of my applications, and the three things I can still do to it.
 *
 * Availability and the "still coming?" answer save on the tap, like the profile
 * does — there is no submit button on this page either, because a member who
 * opens it to change one day should not have to find a button afterwards. Each
 * tap is optimistic and reverts if the write is refused, which is the only
 * honest way to be optimistic.
 *
 * ## Withdrawing says what it costs
 *
 * A seat given up is a seat somebody else takes: `withdrawApplication` promotes
 * the front of the queue in the same transaction, automatically, because §14
 * says nobody should have to approve that. So the confirm dialog names it —
 * "one person is waiting and will take your seat immediately" — rather than
 * asking "are you sure?" about an outcome it has not mentioned. Withdrawing
 * from the *queue* costs nobody anything, and says that instead.
 */

export type MyEventRow = {
  applicationId: string;
  eventId: string;
  slug: string;
  title: string;
  type: string;
  eventStatus: EventStatus;
  /** ISO instants — a client component's props, so not `Date`s. */
  startsAt: string | null;
  endsAt: string | null;
  status: ApplicationStatus;
  waitlistPosition: number | null;
  seats: CapacityState;
  days: ApplyDay[];
  availability: Record<string, AvailabilityState>;
  confirmation: ConfirmationState | null;
  /** True once the event has been and gone; nothing left to change. */
  past: boolean;
  /** What this member's next move is, computed on the server. */
  action: ViewerAction;
};

export default function MyEventCard({ row }: { row: MyEventRow }) {
  const router = useRouter();

  const [availability, setAvailability] = useState(row.availability);
  const [confirmation, setConfirmation] = useState(row.confirmation);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const active = row.status === "accepted" || row.status === "waitlisted";
  const editable = active && !row.past;
  const everyDayYes = row.days.length > 0 && row.days.every((day) => availability[day.id] === "yes");

  /** Somebody is queueing, and this seat is what they are queueing for. */
  const freesASeat = row.status === "accepted" && row.seats.waitlisted > 0;

  const saveAvailability = async (next: Record<string, AvailabilityState>) => {
    const before = availability;
    setAvailability(next);
    setBusy(true);
    setProblem(null);

    // Send every day, with the ones they cleared as explicit nulls — otherwise
    // an unset day is indistinguishable from one the caller did not mention.
    const patch: Record<string, AvailabilityState | null> = {};
    for (const day of row.days) patch[day.id] = next[day.id] ?? null;

    try {
      const result = await setMyAvailabilityAction(row.applicationId, patch);
      if (!result.ok) {
        setAvailability(before);
        setProblem(result.error);
        return;
      }
      setAvailability(result.data);
    } catch {
      setAvailability(before);
      setProblem("Could not reach the server, so that was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const saveConfirmation = async (state: ConfirmationState) => {
    const before = confirmation;
    setConfirmation(state);
    setBusy(true);
    setProblem(null);
    try {
      const result = await setMyConfirmationAction(row.applicationId, state);
      if (!result.ok) {
        setConfirmation(before);
        setProblem(result.error);
      }
    } catch {
      setConfirmation(before);
      setProblem("Could not reach the server, so that was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await withdrawFromEventAction(row.eventId, row.slug);
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setAsking(false);
      // Said on the page rather than in here: withdrawing moves this card into
      // another section, which remounts it, and a message that cannot survive
      // the thing that triggers it is not a message. The page reads the slug
      // back off the query string and checks it really is one of theirs.
      router.replace(
        `/me/events?withdrew=${encodeURIComponent(row.slug)}${
          result.data.promoted > 0 ? "&promoted=1" : ""
        }`
      );
      router.refresh();
    } catch {
      setProblem("Could not reach the server, so nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel as="article" padding="none" className="overflow-hidden">
      {/* --- Which event, and where I stand ------------------------- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
        <StatusPill
          status={applicationStatusTone(row.status)}
          label={
            row.status === "waitlisted" && row.waitlistPosition !== null
              ? `Queue #${row.waitlistPosition}`
              : applicationStatusLabel(row.status)
          }
        />
        <EventStatusPill status={row.eventStatus} />
        <Badge>{eventTypeLabel(row.type)}</Badge>

        <h2 className="font-display text-xl leading-none tracking-wide">
          <Link href={`/events/${row.slug}`} className="hover:text-gold">
            {row.title}
          </Link>
        </h2>

        <div className="ml-auto flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <EventDateRange startsAt={row.startsAt} endsAt={row.endsAt} />
          <EventSeats seats={row.seats} />
        </div>
      </div>

      {problem && (
        <div className="px-5 pt-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      <div className="space-y-5 p-5">
        {/* --- What happens next ----------------------------------- */}
        {row.status === "waitlisted" && (
          <p className="text-xs leading-relaxed text-muted">
            {row.waitlistPosition === null
              ? "You are in the queue."
              : `You are #${row.waitlistPosition} in the queue.`}{" "}
            Seats are first come, and you move up on your own when somebody withdraws —
            there is nothing to reapply for.
          </p>
        )}

        {(row.status === "declined" || row.status === "withdrawn") && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              {row.status === "declined"
                ? "An admin decided against this application. Nothing here is deleted, so it stays on your list."
                : "You withdrew from this one. Your answers are kept in case you come back to it."}
            </p>
            <EventAction action={row.action} size="sm" />
          </div>
        )}

        {/* --- Availability ---------------------------------------- */}
        {row.days.length > 0 && active && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Eyebrow>Which days you can make</Eyebrow>
              {editable && (
                <Button
                  size="sm"
                  variant={everyDayYes ? "default" : "gold"}
                  className="ml-auto"
                  disabled={busy || everyDayYes}
                  onClick={() =>
                    void saveAvailability(
                      Object.fromEntries(
                        row.days.map((day) => [day.id, "yes" as AvailabilityState])
                      )
                    )
                  }
                >
                  {everyDayYes ? "✓ Every day" : "Every day"}
                </Button>
              )}
            </div>

            <div className="divide-y divide-hair/60 rounded-xl border border-hair">
              {row.days.map((day) => (
                <div
                  key={day.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                >
                  <div className="min-w-40">
                    <div className="text-sm">{day.label ?? `Day ${day.dayIndex + 1}`}</div>
                    <EventDateRange
                      startsAt={day.startsAt}
                      fallback="Time to be confirmed"
                      className="mt-1 block"
                    />
                  </div>

                  <ChoiceRow className="ml-auto">
                    {AVAILABILITY_CHOICES.map((choice) => (
                      <ChoiceChip
                        key={choice.value}
                        selected={availability[day.id] === choice.value}
                        disabled={!editable || busy}
                        onClick={() => {
                          const next = { ...availability };
                          if (next[day.id] === choice.value) delete next[day.id];
                          else next[day.id] = choice.value;
                          void saveAvailability(next);
                        }}
                      >
                        {choice.label}
                      </ChoiceChip>
                    ))}
                  </ChoiceRow>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* --- Attendance ------------------------------------------ */}
        {active && !row.past && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <Eyebrow>
                {row.status === "accepted" ? "Are you still coming?" : "Still want a seat?"}
              </Eyebrow>
              {confirmation && (
                <span
                  className={cx(
                    "text-xs",
                    confirmation === "in" ? "text-signal" : "text-ember"
                  )}
                >
                  {confirmation === "in" ? "✓ Confirmed" : "✕ You said you cannot make it"}
                </span>
              )}
            </div>

            <ChoiceRow>
              <ChoiceChip
                selected={confirmation === "in"}
                disabled={busy}
                onClick={() => void saveConfirmation("in")}
              >
                I&apos;ll be there
              </ChoiceChip>
              <ChoiceChip
                selected={confirmation === "out"}
                disabled={busy}
                onClick={() => void saveConfirmation("out")}
              >
                I can&apos;t make it
              </ChoiceChip>
            </ChoiceRow>

            <p className="text-xs leading-relaxed text-muted">
              Saying you cannot make it is not the same as withdrawing — it tells the admin,
              and keeps your place until they decide what to do about it.
            </p>
          </section>
        )}

        {/* --- Withdraw -------------------------------------------- */}
        {editable && (
          <div className="flex flex-wrap items-center gap-4 border-t border-hair pt-4">
            <Button variant="ember" size="sm" disabled={busy} onClick={() => setAsking(true)}>
              Withdraw
            </Button>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
              {freesASeat
                ? `${plural(row.seats.waitlisted, "person", "people")} waiting — the first of them takes your seat the moment you withdraw.`
                : row.status === "accepted"
                  ? "Nobody is queueing, so this just frees the seat."
                  : "You would leave the queue. Applying again later puts you at the back of it."}
            </p>
          </div>
        )}
      </div>

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        eyebrow={row.title}
        title="Withdraw from this event?"
        size="sm"
        footer={
          <>
            <Button size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Keep my place
            </Button>
            <Button variant="ember" size="sm" onClick={() => void withdraw()} disabled={busy}>
              {busy ? "Withdrawing…" : "Yes, withdraw"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          {freesASeat ? (
            <>
              <span className="text-ember">
                {plural(row.seats.waitlisted, "person", "people")} are waiting for a seat.
              </span>{" "}
              The one at the front takes yours immediately and automatically — so if you
              change your mind afterwards, you would be applying again at the back of the
              queue rather than getting this seat back.
            </>
          ) : row.status === "accepted" ? (
            "Nobody is on the waitlist, so the seat simply becomes free again. You can apply again while signups are still open."
          ) : (
            "You will leave the queue. Applying again later puts you at the back of it, which is what first-come means."
          )}
        </p>
      </Modal>
    </Panel>
  );
}
