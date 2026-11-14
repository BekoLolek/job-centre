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
 *
 * `suggestions.moderate` is the one power here (R-261 / UC-56): a suggestion's
 * status, and deleting anybody's. An admin has both without holding it.
 */

import { revalidatePath } from "next/cache";
import type { SuggestionStatus } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { powersOf } from "@/lib/permissions";
import { holds } from "@/lib/permissions-policy";
import { requirePermission, requireUser } from "@/lib/session-guards";
import {
  type Suggestion,
  type SuggestionInput,
  type SuggestionVote,
  addSuggestion,
  deleteSuggestion,
  listSuggestions,
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

/**
 * Your own, or anybody's if you are an admin or hold `suggestions.moderate`
 * (UC-22 E3).
 *
 * `requireUser` and not `requirePermission`, because a member with no power at
 * all still removes their own. The power only widens *which* rows, and `holds`
 * answers it as it answers the guard: the flag first, then the grant. Read on
 * this request, so a power revoked a moment ago removes nothing of anybody
 * else's.
 *
 * ## The line it leaves (Task 139)
 *
 * The order is the one `src/app/admin/games/actions.ts` sets out. **Read**
 * first: the row is gone when `deleteSuggestion` returns, so the title and the
 * author are taken from the list read before it, while a failed read still
 * means nothing was changed. **Write**, and return a refusal untouched — the
 * refusal is the delete's own zero-row result (decision 004, shape 3), so
 * nothing was removed and nothing is logged. **Log** last, with nothing that
 * can throw in between.
 *
 * Whose it was comes from the row's author and not from `mayRemoveAny`: a
 * moderator may remove anybody's, and that includes their own.
 */
export async function deleteSuggestionAction(
  suggestionId: string
): Promise<SuggestionActionResult> {
  const user = await requireUser();
  const mayRemoveAny = holds(
    { isAdmin: user.isAdmin, powers: await powersOf(user.id) },
    "suggestions.moderate"
  );
  const doomed = (await listSuggestions(null)).find((row) => row.id === suggestionId);

  const result = await deleteSuggestion(suggestionId, { userId: user.id, mayRemoveAny });
  if (!result.ok) return result;

  /*
   * Whose row it was, and nothing else. The power is deliberately not asked:
   * without it the delete's own `where` clause matched on the author, so a
   * success already proves the row was theirs — the power would add nothing
   * here, and would read as though holding it decided the answer.
   */
  const own = doomed?.by?.id === user.id;
  await recordAudit({
    action: own ? "suggestion.withdrawn" : "suggestion.deleted",
    actor: user,
    subject: suggestionId,
    summary: removalSaid(doomed, own),
    detail: {
      title: doomed?.title ?? null,
      authorUserId: doomed?.by?.id ?? null,
      authorName: doomed?.by?.name ?? null,
      own,
    },
  });

  refresh();
  revalidatePath("/admin/audit");
  return { ok: true, data: undefined };
}

/**
 * The sentence for a removal, from what the suggestion was before it went.
 *
 * `doomed` is optional because `.find` types it so, not because a removal can
 * get here without one: an id exists only once its insert has committed, the
 * list is read unfiltered before the delete, and the delete succeeded. The
 * first line is what the type asks for, and names nothing.
 */
function removalSaid(doomed: Suggestion | undefined, own: boolean): string {
  if (!doomed) return "Removed a suggestion.";
  if (own) return `Removed their own suggestion “${doomed.title}”.`;
  if (!doomed.by) {
    return `Removed the suggestion “${doomed.title}”. Nobody is on record as its author.`;
  }
  return `Removed “${doomed.title}”, a suggestion from ${doomed.by.name}.`;
}

export async function setSuggestionStatusAction(
  suggestionId: string,
  status: SuggestionStatus
): Promise<SuggestionActionResult> {
  const actor = await requirePermission("suggestions.moderate");
  const result = await setSuggestionStatus(suggestionId, status);
  // Nothing to log when nothing moved: an audit line for a status change that
  // did not happen is a line that makes the log say something untrue.
  if (!result.ok) return result;

  await recordAudit({
    action: "suggestion.status",
    actor,
    summary: `Marked a suggestion ${status}.`,
    detail: { suggestionId, status },
  });

  refresh();
  return { ok: true, data: undefined };
}
