"use server";

/**
 * The server actions behind `/admin/games`.
 *
 * Thin on purpose. Each one does four things and nothing else: prove the
 * caller holds `games.manage` or is an admin, hand the arguments to
 * `src/lib/admin-games.ts` — which
 * owns every rule and is tested against a real Postgres — write the audit line
 * for what that did, and revalidate the pages whose content just changed.
 *
 * `requirePermission("games.manage")` is re-run inside every action rather than
 * trusted from the page that rendered the button. A server action is a public endpoint: the
 * page's guard proves nothing about who is calling this five minutes later.
 *
 * ## The audit line
 *
 * Every action here that changes something writes one (UC-40 4 for the heroes,
 * Task 132 for adding, editing, retiring and deleting a question, Task 137 for
 * the rest). The two previews write none: they read. It belongs here and not in
 * `src/lib/heroes.ts` or `src/lib/admin-games.ts` for the reason
 * `src/lib/audit.ts` states in its own module comment — this is the layer that
 * has run `requirePermission`, so it is the only one that knows who is acting.
 *
 * The same three steps in the same order in each, and the order is the point:
 *
 *  1. **Write, and return a refusal untouched.** Nothing is logged about a
 *     change the library declined.
 *  2. **Log, from what the write returned.** The names in the sentence — the
 *     game, the question, what either used to be called — are the ones the
 *     library read as part of the write, and handed back. This layer reads
 *     nothing of its own, before or after, so there is no second view of the
 *     row for the sentence to disagree with, and nothing between the write and
 *     the line that can throw: `recordAudit` swallows its own failures. A line
 *     can go missing, but a saved change can never come back to the admin as
 *     an error because of its log line.
 *  3. **Revalidate.**
 *
 * A summary is stored once and read for ever, so each one is built from what
 * happened and not from the rule that makes it so today: the counts are the
 * library's, and a move that moved nothing writes no line at all.
 *
 * `/admin/games` and `/me/profile` are revalidated because every one of these
 * edits changes what members are asked, and `/admin/audit` because it now has
 * a line about it. The hero actions revalidate a different pair; see
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
import { requirePermission } from "@/lib/session-guards";

/** The two pages an edit here shows on, and the log that now has a line about it. */
function refresh(): void {
  revalidatePath("/admin/games");
  revalidatePath("/me/profile");
  revalidatePath("/admin/audit");
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

export async function createGameAction(name: string): Promise<AdminResult<{ id: string }>> {
  const actor = await requirePermission("games.manage");

  const result = await createGame({ name });
  if (!result.ok) return result;

  const game = result.data;
  await recordAudit({
    action: "game.added",
    actor,
    subject: game.id,
    summary: `Added the game ${game.name}.`,
    detail: { name: game.name, key: game.key },
  });

  refresh();
  return { ok: true, data: { id: game.id } };
}

/**
 * Rename a game, and record **both** names.
 *
 * The old one is on the line because it is nowhere else after the write, and
 * it is the name whoever reads the log is looking for.
 */
export async function renameGameAction(gameId: string, name: string): Promise<AdminResult> {
  const actor = await requirePermission("games.manage");

  const result = await renameGame(gameId, name);
  if (!result.ok) return result;

  const { game, previousName } = result.data;
  await recordAudit({
    action: "game.renamed",
    actor,
    subject: game.id,
    summary: `Renamed the game ${previousName} to ${game.name}.`,
    detail: { from: previousName, to: game.name },
  });

  refresh();
  return { ok: true, data: null };
}

/**
 * Show or hide a game.
 *
 * Two actions for one switch, so "who hid this game" is a heading and not a
 * flag inside a detail. The deactivated line says the answers are kept,
 * because this is the nearest thing to deleting a game the page offers and
 * "deactivated" on its own invites the reading that they went with it.
 */
export async function setGameActiveAction(
  gameId: string,
  isActive: boolean
): Promise<AdminResult> {
  const actor = await requirePermission("games.manage");

  const result = await setGameActive(gameId, isActive);
  if (!result.ok) return result;

  const game = result.data;
  await recordAudit({
    action: game.isActive ? "game.activated" : "game.deactivated",
    actor,
    subject: game.id,
    summary: game.isActive
      ? `Activated the game ${game.name}.`
      : `Deactivated the game ${game.name}. Every stored answer is kept.`,
    detail: { name: game.name },
  });

  refresh();
  return { ok: true, data: null };
}

/**
 * Move a game up or down the list.
 *
 * A press on the first game's "up" is answered ok and moves nothing, so it
 * writes nothing: the line says a game moved, and it did not.
 */
export async function moveGameAction(
  gameId: string,
  direction: "up" | "down"
): Promise<AdminResult> {
  const actor = await requirePermission("games.manage");

  const result = await moveGame(gameId, direction);
  if (!result.ok) return result;

  const { game, moved } = result.data;
  if (moved) {
    await recordAudit({
      action: "game.moved",
      actor,
      subject: game.id,
      summary: `Moved the game ${game.name} ${direction} the list.`,
      detail: { name: game.name, direction },
    });
  }

  refresh();
  return { ok: true, data: null };
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
  await requirePermission("games.manage");
  return previewRankLadder(gameId, ladder);
}

/**
 * Replace a game's rank ladder, and record what it cleared.
 *
 * The one action on this page that deletes what members stored, which is why
 * its action is in `audit.ts`'s destructive set. The count on the line is the
 * number of rows the library reports it deleted, not the number the preview
 * forecast. The two can differ, and a stored sentence has to be about what
 * happened.
 *
 * It says "stored answers" and not "ranks" for the same reason: which answers
 * a ladder change clears is the library's rule, and the line should still be
 * true if that rule is redrawn. Both ladders are in `detail`, because after
 * the write nothing else remembers the old one.
 */
export async function setRankLadderAction(
  gameId: string,
  ladder: string[]
): Promise<AdminResult<{ ladder: string[]; clearedAnswers: number }>> {
  const actor = await requirePermission("games.manage");

  const result = await setRankLadder(gameId, ladder);
  if (!result.ok) return result;

  const { game, ladder: saved, clearedAnswers } = result.data;
  const cleared =
    clearedAnswers === 0
      ? "No stored answers were cleared."
      : clearedAnswers === 1
        ? "1 stored answer was cleared."
        : `${clearedAnswers} stored answers were cleared.`;
  await recordAudit({
    action: "game.ladder",
    actor,
    subject: game.id,
    summary: `Set the rank ladder of ${game.name}. ${cleared}`,
    detail: { game: game.id, from: game.rankLadder, to: saved, clearedAnswers },
  });

  refresh();
  return { ok: true, data: { ladder: saved, clearedAnswers } };
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

/** Where a question is asked, as the log says it: a game by name, or everyone. */
function sectionSaid(gameName: string | null): string {
  return gameName ?? "the questions asked of everyone";
}

export async function createFieldAction(
  gameId: string | null,
  input: FieldInput
): Promise<AdminResult<{ id: string }>> {
  const actor = await requirePermission("games.manage");

  const result = await createField(gameId, input);
  if (!result.ok) return result;

  const field = result.data;
  await recordAudit({
    action: "field.added",
    actor,
    subject: field.id,
    summary: `Added the question “${field.label}” to ${sectionSaid(field.gameName)}.`,
    detail: { game: field.gameId, label: field.label, type: field.type },
  });

  refresh();
  return { ok: true, data: { id: field.id } };
}

export async function previewFieldEditAction(
  fieldId: string,
  input: FieldInput
): Promise<{ answers: number; invalidated: number }> {
  await requirePermission("games.manage");
  return previewFieldEdit(fieldId, input);
}

/**
 * Edit a question, and record what it was called before.
 *
 * The old label leads the sentence and is kept in `detail`, because after the
 * write the row has no memory of it and the person reading the log is looking
 * for the name they remember. It is the label on the row `updateField` read
 * and then wrote over, so it is the one this edit replaced. The stranded count
 * is on the line for the same reason it is on the confirm dialog: an edit that
 * left answers unreadable is a different event from one that did not.
 */
export async function updateFieldAction(
  fieldId: string,
  input: FieldInput
): Promise<AdminResult<{ strandedAnswers: number }>> {
  const actor = await requirePermission("games.manage");

  const result = await updateField(fieldId, input);
  if (!result.ok) return result;

  const { field, gameName, previousLabel, strandedAnswers } = result.data;
  const reworded = previousLabel === field.label ? "" : ` It now reads “${field.label}”.`;
  const stranded =
    strandedAnswers === 0
      ? ""
      : ` ${strandedAnswers === 1 ? "1 stored answer no longer fits" : `${strandedAnswers} stored answers no longer fit`} it.`;
  await recordAudit({
    action: "field.updated",
    actor,
    subject: field.id,
    summary: `Changed the question “${previousLabel}” in ${sectionSaid(gameName)}.${reworded}${stranded}`,
    detail: {
      game: field.gameId,
      label: field.label,
      previousLabel,
      type: field.type,
      strandedAnswers,
    },
  });

  refresh();
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
  const actor = await requirePermission("games.manage");

  const result = await retireField(fieldId);
  if (!result.ok) return result;

  // The summary says what was kept: "retired" on its own invites the reading
  // that the answers went with the question, and they did not.
  const { field, gameName, keptAnswers } = result.data;
  const kept =
    keptAnswers === 0
      ? "It is no longer asked; nobody had answered it."
      : `It is no longer asked, and the ${keptAnswers === 1 ? "1 answer to it is" : `${keptAnswers} answers to it are`} kept.`;
  await recordAudit({
    action: "field.retired",
    actor,
    subject: field.id,
    summary: `Retired the question “${field.label}” in ${sectionSaid(gameName)}. ${kept}`,
    detail: { game: field.gameId, label: field.label, keptAnswers },
  });

  refresh();
  return { ok: true, data: { keptAnswers } };
}

/**
 * Ask it again. Every answer kept while it was retired comes back with it.
 *
 * The line is `retireFieldAction`'s read backwards, and says what came back
 * for the reason that one says what was kept.
 */
export async function restoreFieldAction(
  fieldId: string
): Promise<AdminResult<{ restoredAnswers: number }>> {
  const actor = await requirePermission("games.manage");

  const result = await restoreField(fieldId);
  if (!result.ok) return result;

  const { field, gameName, restoredAnswers } = result.data;
  const back =
    restoredAnswers === 0
      ? "It is asked again; nobody had answered it."
      : `It is asked again, and the ${restoredAnswers === 1 ? "1 answer to it is" : `${restoredAnswers} answers to it are`} back with it.`;
  await recordAudit({
    action: "field.restored",
    actor,
    subject: field.id,
    summary: `Brought back the question “${field.label}” in ${sectionSaid(gameName)}. ${back}`,
    detail: { game: field.gameId, label: field.label, restoredAnswers },
  });

  refresh();
  return { ok: true, data: { restoredAnswers } };
}

/**
 * Move a question up or down its section.
 *
 * Worth a line because order is not only cosmetic here: of two questions
 * marked as holding a game's roles, the first in this order is the one that is
 * read (`rolesFieldFor`). As with a game, a press that moved nothing writes
 * nothing.
 */
export async function moveFieldAction(
  fieldId: string,
  direction: "up" | "down"
): Promise<AdminResult> {
  const actor = await requirePermission("games.manage");

  const result = await moveField(fieldId, direction);
  if (!result.ok) return result;

  const { field, gameName, moved } = result.data;
  if (moved) {
    await recordAudit({
      action: "field.moved",
      actor,
      subject: field.id,
      summary: `Moved the question “${field.label}” ${direction} in ${sectionSaid(gameName)}.`,
      detail: { game: field.gameId, label: field.label, direction },
    });
  }

  refresh();
  return { ok: true, data: null };
}

/**
 * Delete a question nobody has answered.
 *
 * One that *has* answers is refused by `deleteField` and pointed at retiring
 * (UC-03 5a) — the count is already on the confirm dialog, so the admin is not
 * discovering the number here.
 *
 * The one line here that is the **only** record of its subject. The row is
 * gone when `deleteField` returns, so the label and the game are the ones it
 * read from that row, under lock, before deleting it; there is nothing to look
 * them up from after. It says how many answers went with the question because
 * that is the first thing somebody finding a deletion in the log wants to
 * know, and `profile_values.field_id` cascading is why they are right to ask.
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
  const actor = await requirePermission("games.manage");

  const result = await deleteField(fieldId);
  if (!result.ok) return result;

  const { label, gameId, gameName, deletedAnswers } = result.data;
  const lost =
    deletedAnswers === 0
      ? "Nobody had answered it, so no answers went with it."
      : `The ${deletedAnswers === 1 ? "1 answer" : `${deletedAnswers} answers`} to it went with it.`;
  await recordAudit({
    action: "field.deleted",
    actor,
    subject: fieldId,
    summary: `Deleted the question “${label}” from ${sectionSaid(gameName)}. ${lost}`,
    detail: { game: gameId, label, deletedAnswers },
  });

  refresh();
  return { ok: true, data: { deletedAnswers } };
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
 * nowhere else, because this is the only layer that has run `requirePermission`
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
  const actor = await requirePermission("games.manage");

  const result = await createHero(gameId, name, roles);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.added",
    actor,
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
  const actor = await requirePermission("games.manage");

  const result = await renameHero(heroId, name);
  if (!result.ok) return result;

  const { hero, previousName } = result.data;
  await recordAudit({
    action: "hero.renamed",
    actor,
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
  const actor = await requirePermission("games.manage");

  const result = await setHeroRoles(heroId, roles);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.roles",
    actor,
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
  const actor = await requirePermission("games.manage");

  const result = await retireHero(heroId);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.retired",
    actor,
    subject: result.data.id,
    summary: `Retired the hero ${result.data.name}. Hands already dealt still name it.`,
    detail: { game: result.data.gameId, name: result.data.name },
  });

  refreshHeroes();
  return { ok: true, data: { name: result.data.name } };
}

export async function restoreHeroAction(heroId: string): Promise<AdminResult<{ name: string }>> {
  const actor = await requirePermission("games.manage");

  const result = await restoreHero(heroId);
  if (!result.ok) return result;

  await recordAudit({
    action: "hero.restored",
    actor,
    subject: result.data.id,
    summary: `Brought the hero ${result.data.name} back into the draw.`,
    detail: { game: result.data.gameId, name: result.data.name },
  });

  refreshHeroes();
  return { ok: true, data: { name: result.data.name } };
}
