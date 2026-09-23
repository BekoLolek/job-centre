"use server";

/**
 * Applying to host, and taking it back (UC-20).
 *
 * The member's half only. Deciding an application grants a permission over an
 * event, and every export of a `"use server"` module is a POST endpoint whether
 * or not a button for it is ever rendered — so approving and declining live
 * with the admin screen that calls them, behind `requireAdmin()`, in
 * `src/app/admin/host/actions.ts`.
 */

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import {
  type HostApplicationInput,
  applyToHost,
  getHostApplication,
  withdrawHostApplication,
} from "@/lib/hosting";
import { requireUser } from "@/lib/session-guards";

export type HostActionResult<T = undefined> =
  | { ok: true; data: T }
  /** `errors` is keyed by field, so the form can mark them (UC-20 3a). */
  | { ok: false; error: string; errors?: Record<string, string> };

function refresh(): void {
  revalidatePath("/host");
  revalidatePath("/admin/host");
  revalidatePath("/admin");
}

export async function applyToHostAction(
  input: HostApplicationInput
): Promise<HostActionResult<{ id: string }>> {
  const user = await requireUser();
  const result = await applyToHost(user.id, input);
  if (!result.ok) return result;

  await recordAudit({
    action: "host.applied",
    actor: user,
    summary: `Applied to host "${input.title.trim()}".`,
    detail: { applicationId: result.data.id, game: input.gameName },
  });

  refresh();
  return { ok: true, data: result.data };
}

/** Take your own back. Somebody else's is not yours to withdraw. */
export async function withdrawHostApplicationAction(
  id: string
): Promise<HostActionResult> {
  const user = await requireUser();
  const application = await getHostApplication(id);

  if (!application || application.by?.id !== user.id) {
    return { ok: false, error: "That is not yours to withdraw." };
  }
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  await withdrawHostApplication(id);
  refresh();
  return { ok: true, data: undefined };
}
