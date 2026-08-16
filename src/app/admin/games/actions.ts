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
  createField,
  createGame,
  deleteField,
  moveField,
  moveGame,
  previewFieldEdit,
  previewRankLadder,
  renameGame,
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
 * What replacing the ladder would orphan. Read-only — the screen calls this
 * before it offers the button, so "3 answers will be cleared" is on screen
 * before anyone commits to it.
 */
export async function previewRankLadderAction(
  gameId: string,
  ladder: string[]
): Promise<{ removed: string[]; answers: number }> {
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
): Promise<AdminResult<{ clearedAnswers: number }>> {
  await requireAdmin();
  const result = await updateField(fieldId, input);
  if (!result.ok) return result;
  refresh();
  return { ok: true, data: { clearedAnswers: result.data.clearedAnswers } };
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
 * Delete a question and every answer to it.
 *
 * The count is already on the confirm dialog — `loadAdminGames` fetches it with
 * the field — so this is the point of no return rather than the discovery.
 */
export async function deleteFieldAction(
  fieldId: string
): Promise<AdminResult<{ deletedAnswers: number }>> {
  await requireAdmin();
  const result = await deleteField(fieldId);
  if (result.ok) refresh();
  return result;
}
