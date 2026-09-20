"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, cx } from "@/components/ui";
import type { EventStatus } from "@/db/schema";
import { publishEventAction, setEventStatusAction } from "@/app/admin/events/actions";

/**
 * The one status control (UC-09): every move an event can make, and no other.
 *
 * It sits on the events list and at the bottom of the Publish step. Publishing
 * goes through `publishEventAction`, the same call the Publish step's own button
 * makes, refusals and Discord announcement included; every other move goes
 * through `setEventStatusAction`. Both are second doorways to one action, not
 * second implementations of it.
 *
 * The buttons are `EVENT_STATUS_FLOW` made clickable
 * (docs/diagrams/event-state.md):
 *
 *  - Unpublished: publish.
 *  - Published: back to unpublished, mark running, or cancel.
 *  - Running: mark complete, or cancel. No way back to published — people are
 *    playing in it.
 *  - Complete: reopen, which returns it to running and is audited by name.
 *  - Cancelled: nothing. It is terminal, so there are no buttons to offer.
 *
 * Cancelling asks first. It notifies every applicant and cannot be undone.
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

  const move = (to: EventStatus) => run(() => setEventStatusAction(eventId, status, to));

  const cancel = () => {
    if (confirm("Cancel this event? Applicants are told, and it cannot be undone.")) {
      move("cancelled");
    }
  };

  const cancelButton = (
    <Button size="sm" variant="flare" disabled={busy} onClick={cancel}>
      Cancel
    </Button>
  );

  // `cancelled` is terminal. Render nothing rather than a row of dead buttons.
  const buttons =
    status === "draft" ? (
      <Button
        size="sm"
        variant="union"
        disabled={busy}
        onClick={() => run(() => publishEventAction(eventId))}
      >
        Publish
      </Button>
    ) : status === "published" ? (
      <>
        <Button size="sm" disabled={busy} onClick={() => move("draft")}>
          Unpublish
        </Button>
        <Button size="sm" variant="union" disabled={busy} onClick={() => move("live")}>
          Mark running
        </Button>
        {cancelButton}
      </>
    ) : status === "live" ? (
      <>
        <Button size="sm" variant="union" disabled={busy} onClick={() => move("complete")}>
          Mark complete
        </Button>
        {cancelButton}
      </>
    ) : status === "complete" ? (
      <Button size="sm" disabled={busy} onClick={() => move("live")}>
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
      {error && <span className="text-12 text-flare">{error}</span>}
      {buttons}
    </span>
  );
}
