"use server";

/**
 * Saving a member's general availability.
 *
 * One action, because the answer is one form and one whole-list replace — see
 * `src/lib/availability.ts` for why a diff would be the wrong shape.
 *
 * The user comes from the session, never from the caller. Availability is
 * about a person, and an action that took a user id would be a way to write
 * anybody's, which is not a thing a member screen should be able to do even by
 * accident.
 */

import { revalidatePath } from "next/cache";
import type { AvailabilityAnswer } from "@/lib/availability-resolve";
import { setAvailability } from "@/lib/availability";
import { requireUser } from "@/lib/session-guards";

export type SaveAvailabilityResult = { ok: true } | { ok: false; error: string };

export async function saveAvailabilityAction(
  input: AvailabilityAnswer
): Promise<SaveAvailabilityResult> {
  const user = await requireUser();

  const result = await setAvailability(user.id, input);
  if (!result.ok) return result;

  revalidatePath("/me/profile");
  // The admin grid reads everybody's, so it is stale the moment this lands.
  revalidatePath("/admin/availability");
  return { ok: true };
}
