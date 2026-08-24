"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, cx } from "@/components/ui";
import type { EventStatus } from "@/db/schema";
import { publishEventAction, setEventStatusAction } from "@/app/admin/events/actions";

/**
 * Move an event between draft, published and complete, from the list.
 *
 * These three live at the bottom of the Publish step, which is the right place
 * to *decide* to publish — it is the screen that tells you what is missing.
 * It is the wrong place to do it for the fourth event in a row, or to mark
 * last night's tournament finished, which is a thing you do while scanning the
 * list and not while reading a checklist about one event.
 *
 * So they are here as well. `publishEventAction` is the same call the Publish
 * step makes, refusals and Discord announcement included — this is a second
 * doorway to one action, not a second implementation of it, which is how the
 * two would otherwise drift until publishing from one place announced and
 * publishing from the other did not.
 *
 * Only ever forward, plus the one step back. Cancelling is not here: it is the
 * decision with the most consequence for the people who applied and it should
 * cost more than a click in a list.
 *
 * What each status offers is not symmetrical, on purpose. A live event can be
 * completed but not hidden, because people are playing in it; a completed one
 * can only be reopened to published, never straight back to live, because
 * "live" is a claim about right now that an admin should have to make again.
 */

export default function EventStatusControls({
  eventId,
  status,
  className,
}: {
  eventId: string;
  status: EventStatus;
  className?: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (go: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      try {
        const result = await go();
        if (!result.ok) {
          setError(result.error ?? "That did not work.");
          return;
        }
        router.refresh();
      } catch {
        setError("Could not reach the server.");
      }
    });
  };

  // `cancelled` has nowhere to go from here, and neither does anything else
  // unexpected. Render nothing rather than a row of dead buttons.
  const buttons =
    status === "draft" ? (
      <Button
        size="sm"
        variant="gold"
        disabled={busy}
        onClick={() => run(() => publishEventAction(eventId))}
      >
        Publish
      </Button>
    ) : status === "published" ? (
      <>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => run(() => setEventStatusAction(eventId, "draft"))}
        >
          Back to draft
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => run(() => setEventStatusAction(eventId, "complete"))}
        >
          Complete
        </Button>
      </>
    ) : status === "live" ? (
      /*
         Running right now, which is the state this is most often used from:
         the tournament finished last night and somebody has to say so. No
         "back to draft" here — an event people are playing in is not a draft,
         and pretending it could be is how a live bracket gets hidden.
      */
      <Button
        size="sm"
        variant="gold"
        disabled={busy}
        onClick={() => run(() => setEventStatusAction(eventId, "complete"))}
      >
        Complete
      </Button>
    ) : status === "complete" ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => run(() => setEventStatusAction(eventId, "published"))}
      >
        Reopen
      </Button>
    ) : null;

  if (!buttons) return null;

  return (
    <span
      className={cx("flex shrink-0 items-center gap-2", className)}
      /*
       * The row is a link to the editor and these sit inside it. Without this
       * every click would navigate as well as act, and the admin would end up
       * on the editor wondering whether the publish went through.
       */
      onClick={(event) => event.stopPropagation()}
    >
      {error && <span className="text-[12px] text-ember">{error}</span>}
      {buttons}
    </span>
  );
}
