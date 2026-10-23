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
import { entryMode } from "@/lib/events-policy";
import {
  MANUAL_REFUSALS,
  type ManualAnnouncementKind,
  alreadyPostedWarning,
  manualPostStep,
  postedNote,
  switchedOffNote,
} from "@/lib/announce-manual";
import type { ManualAnnouncementPanel, ManualAnnouncementRow } from "@/lib/discord";
import { postAnnouncementByHandAction, publishEventAction } from "@/app/admin/events/actions";
import EventStatusControls from "./EventStatusControls";
import { blockers, gaps as gapsIn, readiness } from "./readiness";

/**
 * Publish — the readiness checklist, the button, then telling people (§6.3).
 *
 * ## Three refusals, the rest advice
 *
 * Publishing is refused without a name, at least one day with a start time and
 * a sign-up window (UC-09 2a). Those, and the two states nobody could apply to,
 * are marked as problems and disable the button; the server refuses them too.
 * Everything else is a gap (R-117): the checklist says what it *means* — "no
 * questions, so applying is one click" — so publishing is a decision rather
 * than a hope.
 *
 * Once it is published, the button gives way to the one status control.
 *
 * ## Why the announcements are on this tab (R-221 / UC-43)
 *
 * This is already the "tell people about it" step, and the five buttons are the
 * same job by hand. They are not a tenth top-level tab on purpose: section L is
 * about to make tab visibility conditional, and two changes to the same rail at
 * once is how one of them ends up wrong.
 *
 * Everything the panel *decides* is in `@/lib/announce-manual`, which is pure
 * and has no database in it — this file renders rows the server read and asks
 * that module what a press means. Nothing here re-derives whether a kind may be
 * posted: the action refuses on its own evidence, because a server action is a
 * public endpoint and a disabled button is not a guard.
 */

export default function PublishTab({
  event,
  applicants,
  queue,
  announcements,
}: {
  event: EventDetail;
  applicants: ApplicantView[];
  queue: number;
  /** The five kinds this event can post by hand, as the server read them. */
  announcements: ManualAnnouncementPanel;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** Which kind is in flight, so one press cannot become two posts. */
  const [posting, setPosting] = useState<ManualAnnouncementKind | null>(null);
  /**
   * The kind awaiting confirmation, with the instant it went out
   * (R-222 / UC-43 3a).
   *
   * The instant is carried rather than read back off the row, because the
   * server may be the one that supplied it: a page rendered before somebody
   * else posted has `postedAt` null on the row, and the action answers
   * `confirm` with the real instant.
   */
  const [confirming, setConfirming] = useState<{
    kind: ManualAnnouncementKind;
    postedAt: Date;
  } | null>(null);
  /** What happened to the last press, shown against the row it was about. */
  const [notice, setNotice] = useState<{
    kind: ManualAnnouncementKind;
    tone: "success" | "flare";
    text: string;
  } | null>(null);

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

  /**
   * One press of one kind's button (UC-43 3, 3a, 4a).
   *
   * The branch is {@link manualPostStep}'s, not this handler's. That is the
   * whole of what makes the confirm flow testable: the suite renders to static
   * markup in a node environment with nothing to click, so the decision lives
   * in a pure function that a test can call and this does nothing but obey it.
   */
  const post = async (row: ManualAnnouncementRow, confirmed: boolean) => {
    const step = manualPostStep(row, { webhook: announcements.webhook, confirmed });

    if (step === "refused") {
      setNotice({
        kind: row.kind,
        tone: "flare",
        text: row.refusal ?? MANUAL_REFUSALS.noWebhook,
      });
      return;
    }
    if (step === "confirm") {
      // Non-null by the step: `postedAt` is what made it a confirm.
      setConfirming({ kind: row.kind, postedAt: row.postedAt ?? new Date() });
      setNotice(null);
      return;
    }

    setPosting(row.kind);
    setNotice(null);
    try {
      const result = await postAnnouncementByHandAction(event.id, row.kind, { confirmed });
      if (result.outcome === "posted") {
        setConfirming(null);
        setNotice({ kind: row.kind, tone: "success", text: postedNote(row.kind, result.claimed) });
        // So the row's "last posted" line and its claim catch up.
        router.refresh();
      } else if (result.outcome === "confirm") {
        // This screen did not know it had gone out — somebody else posted it.
        setConfirming({ kind: row.kind, postedAt: result.postedAt });
      } else {
        setNotice({ kind: row.kind, tone: "flare", text: result.error });
      }
    } catch {
      setNotice({
        kind: row.kind,
        tone: "flare",
        text: "Could not reach the server. Nothing was posted.",
      });
    } finally {
      setPosting(null);
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

        <p className="text-14">
          <span className="text-chalk">{eventStatusLabel(event.status)}</span>
          <span className="text-muted"> — {eventStatusMeaning(event.status)}</span>
        </p>

        <EventStatusLine state={event.applicationsState} />

        {applicants.length > 0 && (
          <p className="text-12 text-muted">
            {plural(applicants.length, "application")} so far
            {queue > 0 && `, ${plural(queue, "person", "people")} queueing`}.
          </p>
        )}
      </Panel>

      {/* --- The checklist ------------------------------------------ */}
      <Panel as="section" padding="none">
        <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
          <h2 className="font-display text-20 leading-none">Readiness</h2>
          <Badge tone={blocked.length > 0 ? "flare" : gaps.length > 0 ? "union" : "success"}>
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
                  "num mt-0.5 w-4 shrink-0 text-14",
                  check.level === "ok"
                    ? "text-success"
                    : check.level === "warn"
                      ? "text-union"
                      : "text-flare"
                )}
              >
                {check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✕"}
              </span>
              <span className="min-w-0">
                <span className="block text-14">{check.label}</span>
                <span className="mt-0.5 block text-12 leading-relaxed text-muted">
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

        <p className="text-14 leading-relaxed text-muted">
          Publishing makes the event <span className="text-chalk/80">visible to members</span>{" "}
          and lets the signup window start to mean something. It does not open applications
          by itself: whether anyone can apply is worked out at read time from the status, the
          window, the start date and the seats — which is why there is no
          &ldquo;applications open&rdquo; switch anywhere on this page.
        </p>

        <ul className="space-y-1 text-12 text-muted">
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
            {entryMode(event.config) === "approval" ? (
              <>· Every application waits for a manager&apos;s review before it takes a seat</>
            ) : (
              <>
                · Past {event.capacity ?? "∞"} accepted,{" "}
                {event.config.waitlist === false
                  ? "the event closes rather than queueing anybody"
                  : "applications join the waitlist and are promoted automatically when somebody withdraws"}
              </>
            )}
          </li>
        </ul>

        {done && event.status === "published" && (
          <Alert tone="success">
            Published. It is on the hub now, and /events/{event.slug} answers.
          </Alert>
        )}

        {event.status !== "draft" ? (
          <EventStatusControls eventId={event.id} status={event.status} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="union"
              disabled={busy || blocked.length > 0}
              onClick={() => void publish()}
            >
              {busy ? "Publishing…" : "Publish this event"}
            </Button>
            {blocked.length > 0 && (
              <span className="text-12 text-flare">
                {blocked.map((check) => check.label).join(" · ")}
              </span>
            )}
            {blocked.length === 0 && gaps.length > 0 && (
              <span className="text-12 text-muted">
                {plural(gaps.length, "gap")} above — none of them stop you.
              </span>
            )}
          </div>
        )}
      </Panel>

      {/* --- Telling people, by hand (R-221 to R-223 / UC-43) -------- */}
      <Panel as="section" padding="none" className="space-y-4 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>Announcements</Eyebrow>

        <p className="text-14 leading-relaxed text-muted">
          Each of these posts to Discord <span className="text-chalk/80">now</span>, built from
          the event as it stands. The switches on the Settings screen decide what posts on its
          own; these are for a moment the channel missed.
        </p>

        {event.status === "draft" && (
          <p className="text-12 leading-relaxed text-union">
            This event is still a draft, so anything posted about it links to a page members
            cannot open yet.
          </p>
        )}

        {!announcements.webhook && <Alert standing tone="union">{MANUAL_REFUSALS.noWebhook}</Alert>}

        <ul className="divide-y divide-hair/60 border-y border-hair">
          {announcements.rows.map((row) => (
            <li key={row.kind} className="space-y-2 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-16 leading-none">{row.name}</h3>
                {!row.enabled && <Badge tone="union">Off</Badge>}
                {row.postedAt && <Badge tone="success">Posted</Badge>}
              </div>

              <p className="text-12 leading-relaxed text-muted">{row.detail}</p>

              {/*
                R-223 / UC-43 2a. Said beside the button that will post it
                anyway, which is the whole of why the button is not refused.
              */}
              {!row.enabled && (
                <p className="text-12 leading-relaxed text-union">{switchedOffNote(row.kind)}</p>
              )}

              {row.postedAt && (
                <p suppressHydrationWarning className="text-12 text-muted">
                  Last posted {whenText(row.postedAt)}.
                </p>
              )}

              {notice?.kind === row.kind && <Alert tone={notice.tone}>{notice.text}</Alert>}

              {row.refusal ? (
                /* UC-43 4a. Named, rather than a button that would post a true
                   sentence about nothing. */
                <p className="text-12 leading-relaxed text-flare">{row.refusal}</p>
              ) : confirming?.kind === row.kind ? (
                <div className="space-y-2">
                  <Alert tone="union">
                    <span suppressHydrationWarning>
                      {alreadyPostedWarning(row.kind, whenText(confirming.postedAt) ?? "")}
                    </span>
                  </Alert>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="union"
                      size="sm"
                      disabled={posting !== null}
                      onClick={() => void post(row, true)}
                    >
                      {posting === row.kind ? "Posting…" : "Post it again"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={posting !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  disabled={posting !== null || !announcements.webhook}
                  onClick={() => void post(row, false)}
                >
                  {posting === row.kind ? "Posting…" : row.postedAt ? "Post again" : "Post now"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
