"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApplyDay } from "@/components/apply/ApplyForm";
import {
  AVAILABILITY_CHOICES,
  CONFIRMATION_CHOICES,
  EventAction,
  EventDateRange,
  EventSeats,
  EventStatusPill,
  applicationStatusLabel,
  applicationStatusTone,
  confirmationSaid,
  confirmationTone,
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
 *
 * ## And so does "I can't make it"
 *
 * UC-13 5a puts "not coming" and withdrawing on the same edge: from a seat,
 * both free it and promote the next in line. This card used to say the opposite
 * — "it keeps your place until they decide what to do about it" — which was a
 * promise the seat cap could not keep. So from a seat the chip asks first,
 * through the same dialog and with the same warning, because it costs the same
 * thing. From the *queue* it is only an answer: there is no seat to give up,
 * the state diagram has no edge for it, and one tap must not cost somebody a
 * place they may still want.
 *
 * ## "Not sure yet" asks nothing, because it costs nothing
 *
 * R-199, UC-13 5b. The third answer saves on the tap like "I'll be there"
 * does: it keeps the seat, promotes nobody and can be changed again until the
 * deadline, so a dialog would be asking permission for a no-op. The only chip
 * that interrupts is the one that gives a seat away.
 *
 * ## After the deadline the section is a statement, not a question
 *
 * R-200, UC-13 7-8. Two days before the start the chips go and the member's
 * last answer stays, read back as theirs. The server refuses a late answer
 * whatever this card renders (`setConfirmation`) — what the card decides is
 * only whether to offer something that would be refused, and offering it would
 * be the worse bug of the two.
 *
 * **Withdraw is untouched by that**, and that is the reason closing the answer
 * is acceptable at all (R-54, UC-13 extensions E3). Somebody taken ill the day
 * before an event cannot tell the organisers "I can't make it" any more, but
 * they can still give the seat up, which is the part that matters to everybody
 * else. The deadline governs the *answer*, never the way out.
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
  /**
   * When the "still coming?" answer closes (R-200), as an ISO instant — null
   * for an event with no start date, which has no deadline at all (UC-13 7a).
   * Never formatted on the server; `EventDateRange` renders it in the reader's
   * own zone.
   */
  confirmationClosesAt: string | null;
  /**
   * Whether that deadline is still ahead, decided on the server against the
   * same clock the write will use. A boolean rather than a comparison done
   * here, because a client clock that is two days out would otherwise offer a
   * member an answer the server is about to refuse.
   */
  confirmationsOpen: boolean;
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
  /** Which departure the dialog is asking about, or null when it is shut. */
  const [asking, setAsking] = useState<"withdraw" | "not_coming" | null>(null);

  const active = row.status === "accepted" || row.status === "waitlisted";
  /**
   * Still going somewhere. An approval event's application (R-27) is neither in
   * nor queued, but it is very much alive: its days can still be answered and
   * it can still be withdrawn (docs/diagrams/application-state.md).
   */
  const live = active || row.status === "pending";
  const editable = live && !row.past;
  const everyDayYes = row.days.length > 0 && row.days.every((day) => availability[day.id] === "yes");

  /** Somebody is queueing, and this seat is what they are queueing for. */
  const freesASeat = row.status === "accepted" && row.seats.waitlisted > 0;

  /** Their own answer, read back to them — the whole section once it closes. */
  const said = confirmationSaid(confirmation);

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
        return;
      }
      setAsking(null);

      // UC-13 5a: "not coming" from a seat *is* a withdrawal, so it leaves the
      // same way one does. Said on the page rather than in here, because the
      // card is about to move into another section and remount — see `withdraw`.
      if (result.data.status === "withdrawn") {
        leave(result.data.promoted > 0);
      }
    } catch {
      setConfirmation(before);
      setProblem("Could not reach the server, so that was not saved.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Off this card and onto the page's own message.
   *
   * Withdrawing moves this card into another section, which remounts it, and a
   * message that cannot survive the thing that triggers it is not a message.
   * The page reads the slug back off the query string and checks it really is
   * one of theirs.
   */
  const leave = (promotedSomebody: boolean) => {
    router.replace(
      `/me/events?withdrew=${encodeURIComponent(row.slug)}${
        promotedSomebody ? "&promoted=1" : ""
      }`
    );
    router.refresh();
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
      setAsking(null);
      leave(result.data.promoted > 0);
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

        <h2 className="font-display text-20 leading-none">
          <Link href={`/events/${row.slug}`} className="hover:text-union">
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
        {row.status === "pending" && (
          <p className="text-12 leading-relaxed text-muted">
            This event is by approval, so the organisers read every application. You are not
            holding a seat or a place in the queue yet — you will hear either way.
          </p>
        )}

        {row.status === "waitlisted" && (
          <p className="text-12 leading-relaxed text-muted">
            {row.waitlistPosition === null
              ? "You are in the queue."
              : `You are #${row.waitlistPosition} in the queue.`}{" "}
            Seats are first come, and you move up on your own when somebody withdraws —
            there is nothing to reapply for.
          </p>
        )}

        {(row.status === "declined" || row.status === "withdrawn") && (
          <div className="space-y-3">
            <p className="text-12 leading-relaxed text-muted">
              {row.status === "declined"
                ? "An admin decided against this application. Nothing here is deleted, so it stays on your list."
                : "You withdrew from this one. Your answers are kept in case you come back to it."}
            </p>
            <EventAction action={row.action} size="sm" />
          </div>
        )}

        {/* --- Availability ---------------------------------------- */}
        {row.days.length > 0 && live && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Eyebrow>Which days you can make</Eyebrow>
              {editable && (
                <Button
                  size="sm"
                  variant={everyDayYes ? "default" : "union"}
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

            <div className="divide-y divide-hair/60 rounded-lg border border-hair">
              {row.days.map((day) => (
                <div
                  key={day.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                >
                  <div className="min-w-40">
                    <div className="text-14">{day.label ?? `Day ${day.dayIndex + 1}`}</div>
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
              {said && <span className={cx("text-12", confirmationTone(confirmation))}>{said}</span>}
            </div>

            {row.confirmationsOpen ? (
              <>
                <ChoiceRow>
                  {CONFIRMATION_CHOICES.map((choice) => (
                    <ChoiceChip
                      key={choice.value}
                      selected={confirmation === choice.value}
                      disabled={busy}
                      onClick={() => {
                        // Only one of the three costs anything: from a seat,
                        // "I can't make it" gives it up (UC-13 5a), so it goes
                        // through the dialog that already explains the cost.
                        // "Not sure yet" (UC-13 5b) and "I'll be there" change
                        // nothing but the answer, so they save on the tap.
                        if (choice.value === "out" && row.status === "accepted") {
                          setAsking("not_coming");
                        } else {
                          void saveConfirmation(choice.value);
                        }
                      }}
                    >
                      {choice.label}
                    </ChoiceChip>
                  ))}
                </ChoiceRow>

                <p className="text-12 leading-relaxed text-muted">
                  {row.status === "accepted"
                    ? freesASeat
                      ? `Saying you cannot make it frees your seat — the first of the ${plural(row.seats.waitlisted, "person", "people")} waiting takes it straight away. "Not sure yet" keeps it.`
                      : `Saying you cannot make it frees your seat. You can apply again while signups are open, and your answers are kept. "Not sure yet" keeps it.`
                    : "This just tells the organisers. You keep your place in the queue whichever you pick."}
                </p>

                {row.confirmationClosesAt && (
                  <p className="text-12 leading-relaxed text-muted">
                    You can change this until{" "}
                    <EventDateRange
                      startsAt={row.confirmationClosesAt}
                      className="inline"
                    />
                    , two days before the start. After that it stands — though you can
                    still withdraw.
                  </p>
                )}
              </>
            ) : (
              <p className="text-12 leading-relaxed text-muted">
                {said
                  ? "Answers closed "
                  : "You did not answer, and answers closed "}
                <EventDateRange startsAt={row.confirmationClosesAt} className="inline" />
                , two days before the start, so the organisers can build the running
                order on answers that will not move.{" "}
                {said
                  ? "If you can no longer make it, withdraw below — that still works."
                  : "Your seat is still yours. If you cannot make it, withdraw below."}
              </p>
            )}
          </section>
        )}

        {/* --- Withdraw -------------------------------------------- */}
        {/*
          `editable` deliberately does not consult the answer deadline. R-54 is
          not an answer, and UC-13 extensions E3 keeps it open after R-200's
          cut-off: the day before an event, giving a seat up is the one thing
          still worth doing with it.
        */}
        {editable && (
          <div className="flex flex-wrap items-center gap-4 border-t border-hair pt-4">
            <Button
              variant="flare"
              size="sm"
              disabled={busy}
              onClick={() => setAsking("withdraw")}
            >
              Withdraw
            </Button>
            <p className="min-w-0 flex-1 text-12 leading-relaxed text-muted">
              {freesASeat
                ? `${plural(row.seats.waitlisted, "person", "people")} waiting — the first of them takes your seat the moment you withdraw.`
                : row.status === "accepted"
                  ? "Nobody is queueing, so this just frees the seat."
                  : row.status === "pending"
                    ? "You would take your application off the organisers' list. You can apply again while signups are open."
                    : "You would leave the queue. Applying again later puts you at the back of it."}
            </p>
          </div>
        )}
      </div>

      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        eyebrow={row.title}
        title={
          asking === "not_coming" ? "Give up your seat?" : "Withdraw from this event?"
        }
        size="sm"
        footer={
          <>
            <Button size="sm" onClick={() => setAsking(null)} disabled={busy}>
              Keep my place
            </Button>
            <Button
              variant="flare"
              size="sm"
              onClick={() =>
                asking === "not_coming" ? void saveConfirmation("out") : void withdraw()
              }
              disabled={busy}
            >
              {busy
                ? "Saving…"
                : asking === "not_coming"
                  ? "Yes, I can't make it"
                  : "Yes, withdraw"}
            </Button>
          </>
        }
      >
        <p className="text-14 leading-relaxed text-muted">
          {freesASeat ? (
            <>
              <span className="text-flare">
                {plural(row.seats.waitlisted, "person", "people")} are waiting for a seat.
              </span>{" "}
              The one at the front takes yours immediately and automatically — so if you
              change your mind afterwards, you would be applying again at the back of the
              queue rather than getting this seat back.
            </>
          ) : row.status === "accepted" ? (
            "Nobody is on the waitlist, so the seat simply becomes free again. You can apply again while signups are still open."
          ) : row.status === "pending" ? (
            "The organisers have not decided yet, so nothing is lost but your place on their list. You can apply again while signups are still open."
          ) : (
            "You will leave the queue. Applying again later puts you at the back of it, which is what first-come means."
          )}
        </p>
      </Modal>
    </Panel>
  );
}
