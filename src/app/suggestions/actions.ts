"use server";

/**
 * The suggestion box's writes.
 *
 * Reading is public; every write here needs an account. That asymmetry is the
 * whole security model and it is deliberate: the tally is meant to justify
 * spending a Saturday on something, and a number anybody can inflate justifies
 * nothing.
 *
 * Ownership is not decided here. `deleteSuggestion` takes the actor and puts
 * the test in the `where` clause of the delete, so the row that is authorised
 * is the row that is written — see the note on it in `src/lib/suggestions.ts`.
 * This layer's job is the session: it is the only one that knows *who* is
 * acting, which is also why the audit write lives here and not in the library.
 */

import { revalidatePath } from "next/cache";
import type { SuggestionStatus } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireAdmin, requireUser } from "@/lib/session-guards";
import {
  type SuggestionInput,
  type SuggestionVote,
  addSuggestion,
  deleteSuggestion,
  setSuggestionStatus,
  voteSuggestion,
} from "@/lib/suggestions";

export type SuggestionActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/suggestions");
  revalidatePath("/admin");
}

export async function addSuggestionAction(
  input: SuggestionInput
): Promise<SuggestionActionResult<{ id: string }>> {
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

/** Your own, or anybody's if you are an admin (UC-22 E3). */
export async function deleteSuggestionAction(
  suggestionId: string
): Promise<SuggestionActionResult> {
  const user = await requireUser();
  const result = await deleteSuggestion(suggestionId, {
    userId: user.id,
    isAdmin: user.isAdmin,
  });
  if (!result.ok) return result;

  refresh();
  return { ok: true, data: undefined };
}

export async function setSuggestionStatusAction(
  suggestionId: string,
  status: SuggestionStatus
): Promise<SuggestionActionResult> {
  const admin = await requireAdmin();
  const result = await setSuggestionStatus(suggestionId, status);
  // Nothing to log when nothing moved: an audit line for a status change that
  // did not happen is a line that makes the log say something untrue.
  if (!result.ok) return result;

  await recordAudit({
    action: "suggestion.status",
    actor: admin,
    summary: `Marked a suggestion ${status}.`,
    detail: { suggestionId, status },
  });

  refresh();
  return { ok: true, data: undefined };
}
