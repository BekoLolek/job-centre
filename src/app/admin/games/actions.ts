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
 *
 * The hero actions at the foot of the file are the one group that does a fourth
 * thing: they write an audit line (UC-40 4 asks for it by name). That belongs
 * here and not in `src/lib/heroes.ts` for the reason `src/lib/audit.ts` states
 * in its own module comment — this is the layer that has run `requireAdmin()`,
 * so it is the only one that knows who is acting. They also revalidate a
 * different pair of pages; see `refreshHeroes`.
 */

import { revalidatePath } from "next/cache";
import type { HeroRole } from "@/db";
import {
  createHero,
  renameHero,
  restoreHero,
  retireHero,
  setHeroRoles,
} from "@/lib/heroes";
import { recordAudit } from "@/lib/audit";
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

/* ------------------------------------------------------------------ */
/* Heroes (R-214 / UC-40)                                             */
/* ------------------------------------------------------------------ */

/**
 * This page and the log — not `/me/profile`.
 *
 * A hero is not a profile question, so nothing a member is asked changes when
 * one is added. `/admin/audit` is here because each of these writes a line to
 * it (UC-40 4) and the log page would otherwise serve the cached render that
 * does not have it yet.
 */
function refreshHeroes(): void {
  revalidatePath("/admin/games");
  revalidatePath("/admin/audit");
}

/**
 * The sentence the log carries, built here rather than rebuilt on read.
 *
 * `audit.ts` is explicit that `recordAudit` is called from this layer and
 * nowhere else, because this is the only layer that has run `requireAdmin()`
 * and therefore the only one that knows *who* is acting — `src/lib/heroes.ts`
 * is called by tests and by the seed as well as by these five actions.
 */
function rolesSaid(roles: readonly HeroRole[]): string {
  return roles.join(", ");
}

export async function createHeroAction(
  gameId: string,
  name: string,
  roles: readonly string[]
): Promise<AdminResult<{ id: string }>> {
  const admin = await requireAdmin();

  const result = await createHero(gameId, name, roles);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.added",
    actor: admin,
    subject: result.data.id,
    summary: `Added the hero ${result.data.name} as ${rolesSaid(result.data.roles)}.`,
    detail: { game: gameId, name: result.data.name, roles: [...result.data.roles] },
  });

  refreshHeroes();
  return { ok: true, data: { id: result.data.id } };
}

/**
 * Rename a hero, and record **both** names.
 *
 * The old name is in `detail` because it is nowhere else after this write:
 * `heroes` has no stable key column — Task 73 declined one deliberately, and
 * adding one now would be the migration this task is not allowed to run — so
 * the row that comes back has no memory of what it used to be called. That
 * matters beyond tidiness: a later run of the seed plants the old name again as
 * a second hero, and this line is how somebody reading the list works out which
 * of the two is the duplicate. `heroRenameSeedWarning` says so on screen before
 * the admin commits to it.
 */
export async function renameHeroAction(
  heroId: string,
  name: string
): Promise<AdminResult<{ name: string; previousName: string }>> {
  const admin = await requireAdmin();

  const result = await renameHero(heroId, name);
  if (!result.ok) return result;

  const { hero, previousName } = result.data;
  await recordAudit({
    action: "hero.renamed",
    actor: admin,
    subject: hero.id,
    summary: `Renamed the hero ${previousName} to ${hero.name}.`,
    detail: { game: hero.gameId, from: previousName, to: hero.name },
  });

  refreshHeroes();
  return { ok: true, data: { name: hero.name, previousName } };
}

export async function setHeroRolesAction(
  heroId: string,
  roles: readonly string[]
): Promise<AdminResult<{ roles: HeroRole[] }>> {
  const admin = await requireAdmin();

  const result = await setHeroRoles(heroId, roles);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.roles",
    actor: admin,
    subject: result.data.id,
    summary: `${result.data.name} is now ${rolesSaid(result.data.roles)}.`,
    detail: { game: result.data.gameId, roles: [...result.data.roles] },
  });

  refreshHeroes();
  return { ok: true, data: { roles: result.data.roles } };
}

/**
 * Retire a hero (UC-40 4a). Not a delete, and there is no delete to offer.
 *
 * The summary says what the row keeps, because the log is read by somebody
 * asking "where did this hero go" and "retired" on its own invites the answer
 * that the hands went with it.
 */
export async function retireHeroAction(heroId: string): Promise<AdminResult<{ name: string }>> {
  const admin = await requireAdmin();

  const result = await retireHero(heroId);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.retired",
    actor: admin,
    subject: result.data.id,
    summary: `Retired the hero ${result.data.name}. Hands already dealt still name it.`,
    detail: { game: result.data.gameId, name: result.data.name },
  });

  refreshHeroes();
  return { ok: true, data: { name: result.data.name } };
}

export async function restoreHeroAction(heroId: string): Promise<AdminResult<{ name: string }>> {
  const admin = await requireAdmin();

  const result = await restoreHero(heroId);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.restored",
    actor: admin,
    subject: result.data.id,
    summary: `Brought the hero ${result.data.name} back into the draw.`,
    detail: { game: result.data.gameId, name: result.data.name },
  });

  refreshHeroes();
  return { ok: true, data: { name: result.data.name } };
}
