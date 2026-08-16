"use server";

/**
 * The server actions behind `/me/profile`.
 *
 * One action, one section — the brief's "a server action per section", and the
 * reason there is no page-wide submit button. Each call re-establishes who is
 * asking with `requireUser()` rather than believing a user id from the client;
 * a server action is a public endpoint with a nicer calling convention, and
 * treating it as anything else is how "clicks, not typing" turns into "anyone
 * can edit anyone's profile".
 */

import { revalidatePath } from "next/cache";
import { type AnswerPatch, type SaveResult, saveProfileSection } from "@/lib/profile";
import { requireUser } from "@/lib/session-guards";

export async function saveProfileSectionAction(
  gameId: string | null,
  patch: AnswerPatch
): Promise<SaveResult> {
  const user = await requireUser();

  // The section, the field ids and every value are re-checked against the
  // database inside `saveProfileSection`. Nothing from `patch` is trusted.
  const result = await saveProfileSection(user.id, gameId, patch);

  // The page is server-rendered from the same rows, so a reload has to agree
  // with what the section is already showing.
  if (result.ok) revalidatePath("/me/profile");

  return result;
}
