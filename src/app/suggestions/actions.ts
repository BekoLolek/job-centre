"use server";

/**
 * The suggestion box's writes.
 *
 * Reading is public; every write here needs an account. That asymmetry is the
 * whole security model and it is deliberate: the tally is meant to justify
 * spending a Saturday on something, and a number anybody can inflate justifies
 * nothing.
 *
 * Deleting is the only place ownership matters, and the check is here rather
 * than in the library for the reason `me/events/actions.ts` gives: a suggestion
 * id is a uuid somebody could guess at, and "it came from the page we rendered"
 * is not a security argument.
 */

import { revalidatePath } from "next/cache";
import type { SuggestionStatus } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireAdmin, requireUser } from "@/lib/session-guards";
import {
  type SuggestionVote,
  addSuggestion,
  deleteSuggestion,
  setSuggestionStatus,
  suggestionAuthor,
  voteSuggestion,
} from "@/lib/suggestions";

export type SuggestionActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/suggestions");
  revalidatePath("/admin");
}

export async function addSuggestionAction(input: {
  title: string;
  detail?: string;
  gameName?: string;
}): Promise<SuggestionActionResult<{ id: string }>> {
  const user = await requireUser();
  const result = await addSuggestion(user.id, input);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: result.data };
}

export async function voteSuggestionAction(
  suggestionId: string,
  value: 1 | -1
): Promise<SuggestionActionResult<{ up: number; down: number; yours: SuggestionVote }>> {
  const user = await requireUser();
  const result = await voteSuggestion(suggestionId, user.id, value);
  if (!result.ok) return result;
  // No `revalidatePath` here. A vote returns the new tally and the row updates
  // itself; re-rendering the whole list would also re-sort it under the cursor,
  // which is how a list becomes impossible to vote down twice in a row.
  return { ok: true, data: result.data };
}

/** Your own, or anybody's if you are an admin. */
export async function deleteSuggestionAction(
  suggestionId: string
): Promise<SuggestionActionResult> {
  const user = await requireUser();
  const author = await suggestionAuthor(suggestionId);

  if (!user.isAdmin && author !== user.id) {
    return { ok: false, error: "That is not yours to remove." };
  }

  await deleteSuggestion(suggestionId);
  refresh();
  return { ok: true, data: undefined };
}

export async function setSuggestionStatusAction(
  suggestionId: string,
  status: SuggestionStatus
): Promise<SuggestionActionResult> {
  const admin = await requireAdmin();
  await setSuggestionStatus(suggestionId, status);

  await recordAudit({
    action: "suggestion.status",
    actor: admin,
    summary: `Marked a suggestion ${status}.`,
    detail: { suggestionId, status },
  });

  refresh();
  return { ok: true, data: undefined };
}
