"use server";

/**
 * Poll writes.
 *
 * Posting, editing and closing are admin-only; voting needs any account.
 * Reading is public and has no action at all — see the page.
 *
 * Every closed-poll check is repeated here even though the library makes it
 * too. That is not belt and braces for its own sake: the library refusal is
 * what actually protects the data, and these exist so the screen gets a
 * sentence rather than a thrown error.
 */

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import {
  type PollInput,
  closePoll,
  createPoll,
  deletePoll,
  previewPollEdit,
  updatePoll,
  votePoll,
} from "@/lib/polls";
import { requireAdmin, requireUser } from "@/lib/session-guards";

export type PollActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** What the browser sends: dates as ISO strings, since actions take plain JSON. */
export type PollDraft = {
  question: string;
  detail?: string;
  multiple: boolean;
  /** ISO instant, or null for a poll that stays open. */
  closesAt: string | null;
  options: Array<{ id?: string; label: string }>;
};

function toInput(draft: PollDraft): PollInput {
  return {
    question: draft.question,
    detail: draft.detail ?? null,
    multiple: draft.multiple,
    closesAt: draft.closesAt ? new Date(draft.closesAt) : null,
    options: draft.options,
  };
}

function refresh(): void {
  revalidatePath("/polls");
  revalidatePath("/");
}

export async function createPollAction(
  draft: PollDraft
): Promise<PollActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const result = await createPoll(admin.id, toInput(draft));
  if (!result.ok) return result;

  await recordAudit({
    action: "poll.created",
    actor: admin,
    summary: `Posted a poll: "${draft.question.trim()}".`,
    detail: { pollId: result.data.id, options: draft.options.length, multiple: draft.multiple },
  });

  refresh();
  return { ok: true, data: result.data };
}

/**
 * What this edit would cost. Read-only, and asked before the confirm.
 *
 * Admin-gated despite reading nothing secret: it names the options about to be
 * dropped, and there is no reason for that to be a public endpoint.
 */
export async function previewPollEditAction(
  pollId: string,
  draft: PollDraft
): Promise<PollActionResult<{ lostVotes: number; droppedOptions: string[]; closed: boolean }>> {
  await requireAdmin();
  const preview = await previewPollEdit(pollId, toInput(draft));
  return { ok: true, data: preview };
}

export async function updatePollAction(
  pollId: string,
  draft: PollDraft
): Promise<PollActionResult<{ lostVotes: number }>> {
  const admin = await requireAdmin();
  const result = await updatePoll(pollId, toInput(draft));
  if (!result.ok) return result;

  await recordAudit({
    action: "poll.updated",
    actor: admin,
    summary:
      result.data.lostVotes > 0
        ? `Changed a poll, discarding ${result.data.lostVotes} votes.`
        : "Changed a poll.",
    detail: { pollId, lostVotes: result.data.lostVotes },
  });

  refresh();
  return { ok: true, data: result.data };
}

export async function closePollAction(pollId: string): Promise<PollActionResult> {
  const admin = await requireAdmin();
  await closePoll(pollId);

  await recordAudit({
    action: "poll.closed",
    actor: admin,
    summary: "Closed a poll.",
    detail: { pollId },
  });

  refresh();
  return { ok: true, data: undefined };
}

export async function deletePollAction(pollId: string): Promise<PollActionResult> {
  const admin = await requireAdmin();
  await deletePoll(pollId);

  await recordAudit({
    action: "poll.closed",
    actor: admin,
    summary: "Deleted a poll.",
    detail: { pollId, deleted: true },
  });

  refresh();
  return { ok: true, data: undefined };
}

export async function votePollAction(
  pollId: string,
  optionId: string
): Promise<PollActionResult<{ yours: string[] }>> {
  const user = await requireUser();
  const result = await votePoll(pollId, user.id, optionId);
  if (!result.ok) return result;

  // The names beside each option have to change for everybody, so unlike the
  // suggestion box this one does re-read. Polls do not re-sort under the
  // cursor — the order is by closed-then-created — so there is nothing to lose.
  refresh();
  return { ok: true, data: result.data };
}
