"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, EmptyState, Field, Select, plural } from "@/components/ui";
import type { HostApplication } from "@/lib/hosting";
import {
  approveHostApplicationAction,
  createEventFromApplicationAction,
  declineHostApplicationAction,
} from "@/app/admin/host/actions";

/**
 * The queue of people who want to run something (UC-21).
 *
 * The screen follows the use case's three steps in order, because they are
 * three decisions and not one:
 *
 *  1. **Create the event from this application** (UC-21 2). It arrives named
 *     after the application, with its game attached if the applicant picked one
 *     this site knows, and with one sign-up question per line of what they said
 *     they need to know about each player. That prefill is why the form asks
 *     for those two things at all.
 *  2. **Approve, linking that event** (UC-21 3). The event is chosen, not
 *     assumed — the admin may have built it a week ago, and an approval that
 *     silently created a second empty event would be worse than a select.
 *  3. **Decline** (UC-21 3a), which needs a reason. The button does not send
 *     without one, and the server refuses it as well, because the reason is the
 *     entire content of what the applicant gets back.
 *
 * Refusals are painted where they belong: a field-keyed error goes under its
 * own control, and only a refusal with nowhere to sit becomes a banner. One
 * lump message at the top of a card with three controls makes the admin guess
 * which one it is about.
 */

export type LinkableEvent = { id: string; title: string; status: string };

export default function HostQueue({
  applications,
  events,
}: {
  applications: HostApplication[];
  /** Events nobody hosts yet — what an approval may be linked to (UC-21 3). */
  events: LinkableEvent[];
}) {
  const pending = applications.filter((row) => row.status === "pending");
  const decided = applications.filter((row) => row.status !== "pending");

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        {pending.length === 0 ? (
          <EmptyState>
            Nothing waiting. Applications arrive from <code className="num">/host</code>, which
            any member can reach.
          </EmptyState>
        ) : (
          pending.map((application) => (
            <Card key={application.id} application={application} events={events} />
          ))
        )}
      </div>

      {decided.length > 0 && (
        <div className="space-y-2">
          <span className="eyebrow">Already decided</span>
          <div className="divide-y divide-hair/60">
            {decided.map((application) => (
              <div
                key={application.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3"
              >
                <span className="text-14 text-body">{application.title}</span>
                <Badge tone={application.status === "approved" ? "success" : "flare"}>
                  {application.status}
                </Badge>
                <span className="text-13 text-dim">
                  {application.by?.name ?? "somebody"} · {application.gameName}
                </span>
                {application.eventId && (
                  <Link
                    href={`/admin/events/${application.eventId}`}
                    className="text-13 text-union underline underline-offset-4"
                  >
                    the event
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the admin is told when they try to approve without choosing an event. */
export const NO_EVENT_CHOSEN =
  "Create the event from this application first, then approve it onto that event.";

/** What the Decline button refuses to send without (UC-21 3a). */
export const NO_REASON_GIVEN =
  "A decline needs a reason — one line is enough, and it is all they get.";

function Card({
  application,
  events,
}: {
  application: HostApplication;
  events: LinkableEvent[];
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState<"create" | "approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<string | null>(null);

  /** Both refusal shapes, from one place: a banner, field marks, or both. */
  const refused = (result: { error: string; errors?: Record<string, string> }) => {
    setErrors(result.errors ?? {});
    setError(result.errors ? null : result.error);
  };

  const clear = () => {
    setError(null);
    setErrors({});
  };

  const create = async () => {
    setBusy("create");
    clear();
    try {
      const result = await createEventFromApplicationAction(application.id);
      if (!result.ok) {
        refused(result);
        return;
      }
      // Chosen for them, because it is the event they just built from this.
      setEventId(result.data.eventId);
      setCreated(
        result.data.note ??
          `Created it with ${plural(result.data.questions, "question")} from what they wrote. Set it up, then approve.`
      );
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!eventId) {
      setErrors({ eventId: NO_EVENT_CHOSEN });
      return;
    }
    setBusy("approve");
    clear();
    try {
      const result = await approveHostApplicationAction(application.id, { eventId, note });
      if (!result.ok) {
        refused(result);
        return;
      }
      router.push(`/admin/events/${result.data.eventId}`);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    if (note.trim().length === 0) {
      setErrors({ note: NO_REASON_GIVEN });
      return;
    }
    setBusy("decline");
    clear();
    try {
      const result = await declineHostApplicationAction(application.id, note);
      if (!result.ok) {
        refused(result);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  // The event built from this application is not in `events` until the page
  // reloads, so it is added here — otherwise the select cannot offer the one
  // thing the admin just made.
  const choices: LinkableEvent[] =
    created && !events.some((event) => event.id === eventId)
      ? [{ id: eventId, title: `${application.title} (just created)`, status: "draft" }, ...events]
      : events;

  return (
    <section className="rounded-lg bg-panel px-5 py-4">
      {error && <Alert className="mb-3">{error}</Alert>}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-16 text-chalk">{application.title}</h3>
        <Badge tone="union">{application.gameName}</Badge>
        {application.gameId ? (
          <Badge tone="success">Game already set up</Badge>
        ) : (
          <Badge tone="flare">Game not in the catalogue</Badge>
        )}
      </div>

      <p className="mt-1 text-13 text-dim">
        {application.by?.name ?? "Somebody"}
        {application.expectedPlayers ? ` · ${plural(application.expectedPlayers, "player")}` : ""}
        {application.format ? ` · ${application.format}` : ""}
        {application.proposedWhen ? ` · ${application.proposedWhen}` : ""}
      </p>

      <p className="mt-3 max-w-2xl whitespace-pre-wrap text-13 leading-relaxed text-body">
        {application.summary}
      </p>

      {/* The part the event is built from. */}
      <div className="mt-4 rounded bg-overlay-1 px-4 py-3">
        <span className="eyebrow">What they need from each player</span>
        <p className="mt-1.5 max-w-2xl whitespace-pre-wrap text-13 leading-relaxed text-chalk">
          {application.playerInfoNeeded}
        </p>
        <p className="mt-2 text-13 leading-relaxed text-dim">
          One line of this becomes one sign-up question on the event, ready to edit — and{" "}
          <Link href="/admin/games" className="text-union underline underline-offset-4">
            Games
          </Link>{" "}
          first if the game is not in the catalogue yet.
        </p>
      </div>

      {/* --- 1: the event ------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Button
          variant={eventId ? undefined : "union"}
          disabled={busy !== null}
          onClick={() => void create()}
        >
          {busy === "create" ? "Creating…" : "Create event from this application"}
        </Button>
        <Select
          label="Approve onto"
          value={eventId}
          error={errors.eventId}
          wrapperClassName="min-w-[16rem] flex-1"
          onChange={(input) => setEventId(input.target.value)}
        >
          <option value="">Choose the event…</option>
          {choices.map((event) => (
            <option key={event.id} value={event.id}>
              {event.title} · {event.status}
            </option>
          ))}
        </Select>
      </div>
      {created && <p className="mt-2 text-13 leading-relaxed text-success">{created}</p>}

      {/* --- 2 and 3: the decision ---------------------------------- */}
      <div className="mt-4 space-y-3">
        <Field
          label="Note to them"
          placeholder="Required to decline; optional when approving"
          value={note}
          maxLength={500}
          error={errors.note}
          onChange={(input) => setNote(input.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="union" disabled={busy !== null} onClick={() => void approve()}>
            {busy === "approve" ? "Approving…" : "Approve and hand it over"}
          </Button>
          <Button variant="flare" disabled={busy !== null} onClick={() => void decline()}>
            {busy === "decline" ? "Declining…" : "Decline"}
          </Button>
          <span className="text-13 text-dim">
            Approving gives them that one event and nothing else. It does not publish anything.
          </span>
        </div>
      </div>
    </section>
  );
}
