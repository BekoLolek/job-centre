"use server";

/**
 * The server actions behind `/admin/games`.
 *
 * Thin on purpose. Each one does three things and nothing else: prove the
 * caller is an admin, hand the arguments to `src/lib/admin-games.ts` — which
 * owns every rule and is tested against a real Postgres — and revalidate the
 * pages whose content just changed.
 *
 * `requireAdmin()` is re-run inside every action rather than trusted from the
 * page that rendered the button. A server action is a public endpoint: the
 * page's guard proves nothing about who is calling this five minutes later.
 *
 * Both `/admin/games` and `/me/profile` are revalidated after a write, because
 * every one of these edits changes what members are asked.
 */

import { revalidatePath } from "next/cache";
import {
  type AdminResult,
  type FieldInput,
  type LadderImpact,
  createField,
  createGame,
  deleteField,
  moveField,
  moveGame,
  previewFieldEdit,
  previewRankLadder,
  renameGame,
  restoreField,
  retireField,
  setGameActive,
  setRankLadder,
  updateField,
} from "@/lib/admin-games";
import { requireAdmin } from "@/lib/session-guards";

/** Everything an edit here can change is visible on both pages. */
function refresh(): void {
  revalidatePath("/admin/games");
  revalidatePath("/me/profile");
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

export async function createGameAction(name: string): Promise<AdminResult<{ id: string }>> {
  await requireAdmin();
  const result = await createGame({ name });
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { id: result.data.id } };
}

export async function renameGameAction(gameId: string, name: string): Promise<AdminResult> {
  await requireAdmin();
  const result = await renameGame(gameId, name);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: null };
}

export async function setGameActiveAction(
  gameId: string,
  isActive: boolean
): Promise<AdminResult> {
  await requireAdmin();
  const result = await setGameActive(gameId, isActive);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: null };
}

export async function moveGameAction(
  gameId: string,
  direction: "up" | "down"
): Promise<AdminResult> {
  await requireAdmin();
  const result = await moveGame(gameId, direction);
  if (result.ok) refresh();
  return result;
}

/* ------------------------------------------------------------------ */
/* Rank ladders                                                       */
/* ------------------------------------------------------------------ */

/**
 * What replacing the ladder would orphan, and which events it would re-aim.
 *
 * Read-only — the screen calls this before it offers the button, so both "3
 * answers will be cleared" and the list of events whose entry rules move
 * (UC-03 3b) are on screen before anyone commits to it.
 */
export async function previewRankLadderAction(
  gameId: string,
  ladder: string[]
): Promise<LadderImpact> {
  await requireAdmin();
  return previewRankLadder(gameId, ladder);
}

export async function setRankLadderAction(
  gameId: string,
  ladder: string[]
): Promise<AdminResult<{ ladder: string[]; clearedAnswers: number }>> {
  await requireAdmin();
  const result = await setRankLadder(gameId, ladder);
  if (result.ok) refresh();
  return result;
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

export async function createFieldAction(
  gameId: string | null,
  input: FieldInput
): Promise<AdminResult<{ id: string }>> {
  await requireAdmin();
  const result = await createField(gameId, input);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { id: result.data.id } };
}

export async function previewFieldEditAction(
  fieldId: string,
  input: FieldInput
): Promise<{ answers: number; invalidated: number }> {
  await requireAdmin();
  return previewFieldEdit(fieldId, input);
}

export async function updateFieldAction(
  fieldId: string,
  input: FieldInput
): Promise<AdminResult<{ strandedAnswers: number }>> {
  await requireAdmin();
  const result = await updateField(fieldId, input);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { strandedAnswers: result.data.strandedAnswers } };
}

/**
 * Stop asking a question, keep every answer (UC-03 5a).
 *
 * The authorisation is on the row this is about to write — `retireField`
 * resolves the field itself and writes that row, and there is no second id
 * beside it for a caller to point somewhere else.
 */
export async function retireFieldAction(
  fieldId: string
): Promise<AdminResult<{ keptAnswers: number }>> {
  await requireAdmin();
  const result = await retireField(fieldId);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { keptAnswers: result.data.keptAnswers } };
}

/** Ask it again. Every answer kept while it was retired comes back with it. */
export async function restoreFieldAction(
  fieldId: string
): Promise<AdminResult<{ restoredAnswers: number }>> {
  await requireAdmin();
  const result = await restoreField(fieldId);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { restoredAnswers: result.data.restoredAnswers } };
}

export async function moveFieldAction(
  fieldId: string,
  direction: "up" | "down"
): Promise<AdminResult> {
  await requireAdmin();
  const result = await moveField(fieldId, direction);
  if (result.ok) refresh();
  return result;
}

/**
 * Delete a question nobody has answered.
 *
 * One that *has* answers is refused by `deleteField` and pointed at retiring
 * (UC-03 5a) — the count is already on the confirm dialog, so the admin is not
 * discovering the number here.
 */
export async function deleteFieldAction(
  fieldId: string
): Promise<AdminResult<{ deletedAnswers: number }>> {
  await requireAdmin();
  const result = await deleteField(fieldId);
  if (result.ok) refresh();
  return result;
}
