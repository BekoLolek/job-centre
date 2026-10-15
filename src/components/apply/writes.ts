import type { ProfileValue } from "@/db/schema";
import { hasAnswer } from "@/lib/profile-fields";

/**
 * What one tap on the apply form writes to the profile — the two halves of it.
 *
 * It lives here rather than inside `ApplyForm` for the reason
 * `src/components/me/todos.ts` does: it is a rule, it is pure, and a rule
 * buried in a component's submit handler is a rule nothing can test. The form
 * reads the answer; it has no opinion of its own.
 *
 * ## Details they changed are saved; details they left alone are stamped
 *
 * UC-12 3a saves an edit to the profile. R-49 is the other half — *my profile
 * details shown back to me when I apply, so that I only confirm they are still
 * right* — and a confirmation nobody stored is one the manager cannot see. So a
 * touched detail goes into `details` and an untouched answered one goes into
 * `confirming`, where `commitDetails` stamps `confirmed_at` on it.
 *
 * ## Nothing is stamped that nobody vouched for
 *
 * **`confirmed` gates the whole of `confirming`.** `profile_values.confirmed_at`
 * is "when the member last said this answer is right", and `schema.ts` says who
 * may write it: "the apply page sets it when the member taps *that is all still
 * right*". So without the tap there is nothing to record, and this returns no
 * ids at all.
 *
 * The gate matters most where it is least visible. Applying is blocked until
 * the member confirms, so on that path `confirmed` is true by the time they can
 * submit — but **editing is not blocked** (R-53 / UC-13 3: they came back to
 * change one answer, and making them re-confirm their whole profile to fix a
 * day chip would be a worse form than the one this replaced). Ungated, "Save
 * changes" after flipping one chip would stamp every answered detail the event
 * asks about as freshly vouched for, on a page the member never looked at
 * twice, and `confirmed_at > updated_at` would then say "re-checked today"
 * about answers nobody re-checked. Touching a detail counts as checking it, so
 * an edit still sets `confirmed` and still stamps the rest — which is the
 * member's own doing rather than the form's.
 *
 * An untouched **blank** is neither saved nor stamped either way: there is no
 * answer to vouch for, and `commitDetails` would have nothing to stamp.
 */

export type DetailRowLike = {
  /** `profile_fields.id`. */
  id: string;
  /** The answer as it was **loaded**, not as it now stands on screen. */
  value: ProfileValue;
};

export type DetailWrites = {
  /** Values to save, keyed by `profile_fields.id`. */
  details: Record<string, unknown>;
  /** Ids the member vouched for without changing (R-49). */
  confirming: string[];
};

export function detailWrites(input: {
  details: readonly DetailRowLike[];
  /** What is on screen now, keyed by detail id. */
  values: Record<string, ProfileValue>;
  /** Details the member actually changed. */
  touched: Record<string, true>;
  /** Have they said the rest is still right — by tapping, or by editing one? */
  confirmed: boolean;
}): DetailWrites {
  const details: Record<string, unknown> = {};
  const confirming: string[] = [];

  for (const detail of input.details) {
    if (input.touched[detail.id]) {
      details[detail.id] = input.values[detail.id] ?? null;
      continue;
    }
    if (input.confirmed && hasAnswer(detail.value)) confirming.push(detail.id);
  }

  return { details, confirming };
}
