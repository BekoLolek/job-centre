"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Eyebrow, Panel, cx, plural } from "@/components/ui";
import {
  EventStatusLine,
  EventStatusPill,
  eventStatusLabel,
  eventStatusMeaning,
  whenText,
} from "@/components/events";
import type { ApplicantView, EventDetail } from "@/lib/events";
import { publishEventAction } from "@/app/admin/events/actions";
import EventStatusControls from "./EventStatusControls";
import { blockers, gaps as gapsIn, readiness } from "./readiness";

/**
 * Publish — the readiness checklist, then the button (§6.3).
 *
 * ## Advisory, not a gate
 *
 * Almost nothing here blocks. `publishEvent` requires a title and a legal
 * transition and that is all, because an event with no questions is a
 * perfectly good "just turn up" event and an event with no days is a one-night
 * thing. A checklist that refused to let those through would be inventing rules
 * the rest of the system does not have.
 *
 * What it does instead is say what each gap *means* — "no signup window, so
 * applications open the moment you publish" — so publishing is a decision
 * rather than a hope. The two items that genuinely stop the write are marked as
 * such and disable the button.
 */

export default function PublishTab({
  event,
  applicants,
  queue,
}: {
  event: EventDetail;
  applicants: ApplicantView[];
  queue: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const checks = readiness(event);
  const blocked = blockers(checks);
  const gaps = gapsIn(checks);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await publishEventAction(event.id);
      if (!result.ok) setError(result.error);
      else {
        setDone(true);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server. Nothing was published.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Where it stands ---------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-4 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow>Right now</Eyebrow>
          <EventStatusPill status={event.status} />
        </div>

        <p className="text-sm">
          <span className="text-chalk">{eventStatusLabel(event.status)}</span>
          <span className="text-muted"> — {eventStatusMeaning(event.status)}</span>
        </p>

        <EventStatusLine state={event.applicationsState} />

        {applicants.length > 0 && (
          <p className="text-xs text-muted">
            {plural(applicants.length, "application")} so far
            {queue > 0 && `, ${plural(queue, "person", "people")} queueing`}.
          </p>
        )}
      </Panel>

      {/* --- The checklist ------------------------------------------ */}
      <Panel as="section" padding="none">
        <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
          <h2 className="font-display text-xl leading-none">Readiness</h2>
          <Badge tone={blocked.length > 0 ? "ember" : gaps.length > 0 ? "gold" : "signal"}>
            {blocked.length > 0
              ? `${plural(blocked.length, "problem")}`
              : gaps.length > 0
                ? `${plural(gaps.length, "gap")}`
                : "All clear"}
          </Badge>
        </div>

        <ul className="divide-y divide-hair/60">
          {checks.map((check) => (
            <li key={check.key} className="flex items-start gap-3 px-5 py-3">
              <span
                aria-hidden
                className={cx(
                  "num mt-0.5 w-4 shrink-0 text-sm",
                  check.level === "ok"
                    ? "text-signal"
                    : check.level === "warn"
                      ? "text-gold"
                      : "text-ember"
                )}
              >
                {check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✕"}
              </span>
              <span className="min-w-0">
                <span className="block text-sm">{check.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                  {check.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      {/* --- The button --------------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-4 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>Publishing</Eyebrow>

        <p className="text-sm leading-relaxed text-muted">
          Publishing makes the event <span className="text-chalk/80">visible to members</span>{" "}
          and lets the signup window start to mean something. It does not open applications
          by itself: whether anyone can apply is worked out at read time from the status, the
          window, the start date and the seats — which is why there is no
          &ldquo;applications open&rdquo; switch anywhere on this page.
        </p>

        <ul className="space-y-1 text-xs text-muted">
          <li>
            · Signups open{" "}
            <span suppressHydrationWarning className="text-chalk/70">
              {whenText(event.signupOpensAt) ?? "immediately"}
            </span>
          </li>
          <li>
            · and close{" "}
            <span suppressHydrationWarning className="text-chalk/70">
              {whenText(event.signupClosesAt) ?? "when the event starts"}
            </span>
          </li>
          <li>
            · Past {event.capacity ?? "∞"} accepted,{" "}
            {event.config.waitlist === false
              ? "the event closes rather than queueing anybody"
              : "applications join the waitlist and are promoted automatically when somebody withdraws"}
          </li>
        </ul>

        {done && event.status === "published" && (
          <Alert tone="signal">
            Published. It is on the hub now, and /events/{event.slug} answers.
          </Alert>
        )}

        {event.status === "published" || event.status === "complete" ? (
          <div className="space-y-3">
            <p className="text-sm text-signal">
              {event.status === "published"
                ? "Already published. Hide it again or mark it finished below — either way the applications stay."
                : "Finished. Reopening puts it back on the hub with everything it recorded intact."}
            </p>
            {/*
              The same two controls as the events list. Pointing at another
              screen for "undo the thing you just did here" is the sort of
              instruction nobody follows and everybody has to hunt for.
            */}
            <EventStatusControls eventId={event.id} status={event.status} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="gold"
              disabled={busy || blocked.length > 0}
              onClick={() => void publish()}
            >
              {busy ? "Publishing…" : "Publish this event"}
            </Button>
            {blocked.length > 0 && (
              <span className="text-xs text-ember">
                {blocked.map((check) => check.label).join(" · ")}
              </span>
            )}
            {blocked.length === 0 && gaps.length > 0 && (
              <span className="text-xs text-muted">
                {plural(gaps.length, "gap")} above — none of them stop you.
              </span>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
