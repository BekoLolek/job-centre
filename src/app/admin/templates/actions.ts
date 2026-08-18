"use server";

/**
 * The server actions behind `/admin/templates`.
 *
 * Thin on purpose, exactly like `/admin/games`'s: prove the caller is an admin,
 * hand the arguments to `src/lib/admin-templates.ts` — which owns every rule
 * and is tested against real Postgres — and revalidate the pages whose content
 * just changed.
 *
 * `/admin/events` is revalidated as well as this page, because its create box
 * reads `listEventTemplates()`: a template made or deactivated here changes
 * what that picker offers, and a picker showing yesterday's list is the sort of
 * thing that reads as a bug.
 */

import { revalidatePath } from "next/cache";
import {
  type FromEventInput,
  type TemplateInput,
  type TemplatePatch,
  type TemplateResult,
  createTemplate,
  createTemplateFromEvent,
  duplicateTemplate,
  setTemplateActive,
  updateTemplate,
} from "@/lib/admin-templates";
import { recordAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";

/** This page, the create-event picker that reads the same rows, and the log. */
function refresh(): void {
  revalidatePath("/admin/templates");
  revalidatePath("/admin/events");
  revalidatePath("/admin/audit");
}

export async function createTemplateAction(
  input: TemplateInput
): Promise<TemplateResult<{ id: string }>> {
  const admin = await requireAdmin();

  const result = await createTemplate(input);
  if (!result.ok) return result;

  await recordAudit({
    action: "template.created",
    actor: admin,
    subject: result.data.id,
    summary: `Created the template "${result.data.name}".`,
    detail: { type: result.data.type, questions: result.data.questions.length },
  });

  refresh();
  return { ok: true, data: { id: result.data.id } };
}

export async function updateTemplateAction(
  templateId: string,
  patch: TemplatePatch
): Promise<TemplateResult<{ id: string }>> {
  const admin = await requireAdmin();

  const result = await updateTemplate(templateId, patch);
  if (!result.ok) return result;

  await recordAudit({
    action: "template.updated",
    actor: admin,
    subject: templateId,
    summary: `Changed the template "${result.data.name}".`,
    detail: { type: result.data.type, questions: result.data.questions.length },
  });

  refresh();
  return { ok: true, data: { id: result.data.id } };
}

export async function duplicateTemplateAction(
  templateId: string,
  name?: string
): Promise<TemplateResult<{ id: string }>> {
  const admin = await requireAdmin();

  const result = await duplicateTemplate(templateId, name);
  if (!result.ok) return result;

  await recordAudit({
    action: "template.duplicated",
    actor: admin,
    subject: result.data.id,
    summary: `Duplicated a template as "${result.data.name}".`,
    detail: { from: templateId },
  });

  refresh();
  return { ok: true, data: { id: result.data.id } };
}

/**
 * Show or hide a template.
 *
 * Deactivating drops it out of the create-event picker and changes nothing
 * about the events already made from it. There is deliberately no delete —
 * checklist.md's standing rule.
 */
export async function setTemplateActiveAction(
  templateId: string,
  isActive: boolean
): Promise<TemplateResult<{ id: string }>> {
  const admin = await requireAdmin();

  const result = await setTemplateActive(templateId, isActive);
  if (!result.ok) return result;

  await recordAudit({
    action: isActive ? "template.activated" : "template.deactivated",
    actor: admin,
    subject: templateId,
    summary: `${isActive ? "Activated" : "Deactivated"} the template "${result.data.name}".`,
  });

  refresh();
  return { ok: true, data: { id: result.data.id } };
}

/**
 * Make a template out of an event that already exists — the useful direction.
 *
 * The audit line records which event it came from, so "where did these eleven
 * questions come from" has an answer six months later.
 */
export async function createTemplateFromEventAction(
  eventId: string,
  input: FromEventInput = {}
): Promise<TemplateResult<{ id: string; name: string }>> {
  const admin = await requireAdmin();

  const result = await createTemplateFromEvent(eventId, input);
  if (!result.ok) return result;

  await recordAudit({
    action: "template.from_event",
    actor: admin,
    eventId,
    subject: result.data.id,
    summary: `Made the template "${result.data.name}" from an event.`,
    detail: { questions: result.data.questions.length, type: result.data.type },
  });

  refresh();
  return { ok: true, data: { id: result.data.id, name: result.data.name } };
}
