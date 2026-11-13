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
 * Two groups do a fourth thing and write an audit line: the hero actions at
 * the foot of the file (UC-40 4 asks for it by name), and the four that add,
 * edit, retire and delete a profile question (Task 132). That belongs here and
 * not in `src/lib/heroes.ts` or `src/lib/admin-games.ts` for the reason
 * `src/lib/audit.ts` states in its own module comment — this is the layer that
 * has run `requireAdmin()`, so it is the only one that knows who is acting.
 * The hero actions also revalidate a different pair of pages; see
 * `refreshHeroes`.
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
  type AdminFieldView,
  type AdminGamesView,
  type AdminResult,
  type FieldInput,
  type LadderImpact,
  createField,
  createGame,
  deleteField,
  loadAdminGames,
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

/*
 * ## Where the audit line sits in each of the four below (Task 132)
 *
 * The same three steps in the same order, and the order is the point:
 *
 *  1. **Read the catalogue, before the write.** The line has to name the game,
 *     and for a delete it has to name a question that will not exist a moment
 *     later. Reading first means a read that fails does so while nothing has
 *     been changed — the admin gets an error about an action that did not
 *     happen, which is true.
 *  2. **Write, and return a refusal untouched.** Nothing is logged about an
 *     edit the library declined.
 *  3. **Log.** After the write, never inside it, and with nothing that can
 *     throw in between: the summary is built from the catalogue already in
 *     hand and from what the write returned, and `recordAudit` swallows its
 *     own failures. So a line can go missing, but a saved question can never
 *     come back to the admin as an error because of its log line.
 *
 * Restoring and reordering a question, and everything above this section — the
 * games themselves and the rank ladders — still write no line. Task 132 asked
 * for these four.
 */

/** The two pages a question shows on, and the log that now has a line about it. */
function refreshQuestions(): void {
  refresh();
  revalidatePath("/admin/audit");
}

/** Where a question is asked, as the log says it: a game by name, or everyone. */
function sectionSaid(view: AdminGamesView, gameId: string | null): string {
  if (gameId === null) return "the questions asked of everyone";
  return view.games.find((game) => game.id === gameId)?.name ?? "a game";
}

/** One question as the catalogue has it, retired or not. */
function questionIn(view: AdminGamesView, fieldId: string): AdminFieldView | undefined {
  return [
    ...view.globalFields,
    ...view.globalRetired,
    ...view.games.flatMap((game) => [...game.fields, ...game.retired]),
  ].find((field) => field.id === fieldId);
}

export async function createFieldAction(
  gameId: string | null,
  input: FieldInput
): Promise<AdminResult<{ id: string }>> {
  const admin = await requireAdmin();
  const catalogue = await loadAdminGames();

  const result = await createField(gameId, input);
  if (!result.ok) return result;

  const field = result.data;
  await recordAudit({
    action: "field.added",
    actor: admin,
    subject: field.id,
    summary: `Added the question “${field.label}” to ${sectionSaid(catalogue, field.gameId)}.`,
    detail: { game: field.gameId, label: field.label, type: field.type },
  });

  refreshQuestions();
  return { ok: true, data: { id: field.id } };
}

export async function previewFieldEditAction(
  fieldId: string,
  input: FieldInput
): Promise<{ answers: number; invalidated: number }> {
  await requireAdmin();
  return previewFieldEdit(fieldId, input);
}

/**
 * Edit a question, and record what it was called before.
 *
 * The old label leads the sentence and is kept in `detail`, because after the
 * write the row has no memory of it and the person reading the log is looking
 * for the name they remember. The stranded count is on the line for the same
 * reason it is on the confirm dialog: an edit that left answers unreadable is
 * a different event from one that did not.
 */
export async function updateFieldAction(
  fieldId: string,
  input: FieldInput
): Promise<AdminResult<{ strandedAnswers: number }>> {
  const admin = await requireAdmin();
  const catalogue = await loadAdminGames();

  const result = await updateField(fieldId, input);
  if (!result.ok) return result;

  const { field, strandedAnswers } = result.data;
  /*
   * Null when the catalogue read before the write had no such row — a window
   * only a concurrent add can open. `detail` then says the old label is not
   * known, rather than repeating the new one: `previousLabel` equal to `label`
   * is a positive statement that nothing was reworded, and that is not
   * something this action can vouch for without having seen the row.
   */
  const previousLabel = questionIn(catalogue, fieldId)?.label ?? null;
  const called = previousLabel ?? field.label;
  const reworded = called === field.label ? "" : ` It now reads “${field.label}”.`;
  const stranded =
    strandedAnswers === 0
      ? ""
      : ` ${strandedAnswers === 1 ? "1 stored answer no longer fits" : `${strandedAnswers} stored answers no longer fit`} it.`;
  await recordAudit({
    action: "field.updated",
    actor: admin,
    subject: field.id,
    summary: `Changed the question “${called}” in ${sectionSaid(catalogue, field.gameId)}.${reworded}${stranded}`,
    detail: {
      game: field.gameId,
      label: field.label,
      previousLabel,
      type: field.type,
      strandedAnswers,
    },
  });

  refreshQuestions();
  return { ok: true, data: { strandedAnswers } };
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
  const admin = await requireAdmin();
  const catalogue = await loadAdminGames();

  const result = await retireField(fieldId);
  if (!result.ok) return result;

  // The summary says what was kept: "retired" on its own invites the reading
  // that the answers went with the question, and they did not.
  const { field, keptAnswers } = result.data;
  const kept =
    keptAnswers === 0
      ? "It is no longer asked; nobody had answered it."
      : `It is no longer asked, and the ${keptAnswers === 1 ? "1 answer to it is" : `${keptAnswers} answers to it are`} kept.`;
  await recordAudit({
    action: "field.retired",
    actor: admin,
    subject: field.id,
    summary: `Retired the question “${field.label}” in ${sectionSaid(catalogue, field.gameId)}. ${kept}`,
    detail: { game: field.gameId, label: field.label, keptAnswers },
  });

  refreshQuestions();
  return { ok: true, data: { keptAnswers } };
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
 *
 * The one line here that is the **only** record of its subject. The row is
 * gone when `deleteField` returns, so the label and the game are taken from
 * the catalogue read before it; there is nothing to look them up from after.
 * It says how many answers went with the question because that is the first
 * thing somebody finding a deletion in the log wants to know, and
 * `profile_values.field_id` cascading is why they are right to ask.
 *
 * That sentence is built from the count `deleteField` reports, the way
 * `retireFieldAction` builds its own from `keptAnswers`, and not from the rule
 * that makes the count 0 today. A summary is stored and never rebuilt: one
 * that asserted "nobody had answered it" unconditionally would become a
 * permanent false statement the day that rule is relaxed, beside a `detail`
 * that contradicts it.
 */
export async function deleteFieldAction(
  fieldId: string
): Promise<AdminResult<{ deletedAnswers: number }>> {
  const admin = await requireAdmin();
  const catalogue = await loadAdminGames();
  const doomed = questionIn(catalogue, fieldId);

  const result = await deleteField(fieldId);
  if (!result.ok) return result;

  const { deletedAnswers } = result.data;
  const lost =
    deletedAnswers === 0
      ? "Nobody had answered it, so no answers went with it."
      : `The ${deletedAnswers === 1 ? "1 answer" : `${deletedAnswers} answers`} to it went with it.`;
  await recordAudit({
    action: "field.deleted",
    actor: admin,
    subject: fieldId,
    summary: `${doomed ? `Deleted the question “${doomed.label}” from ${sectionSaid(catalogue, doomed.gameId)}.` : "Deleted a question."} ${lost}`,
    detail: {
      game: doomed?.gameId ?? null,
      label: doomed?.label ?? null,
      deletedAnswers,
    },
  });

  refreshQuestions();
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
