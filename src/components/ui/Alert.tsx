import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Use for the inline tinted message bar that reports a failed save or a warning.
 *
 * ## It announces by default, and silence has to be asked for
 *
 * This component had no `role` and no `aria-*` attribute of any kind, which was
 * measured in a browser: submitting a duplicate template name at
 * `/admin/templates` is refused correctly, writes no row and shows the right
 * sentence — and the element carrying that sentence had `role` null and
 * `aria-live` null, as did its parent. A screen-reader user submitted the form
 * and heard nothing. The docblock line above says what this bar is *for*, and
 * reporting a failed save is exactly the content that has to reach somebody who
 * cannot see it, so the default is the announcing one.
 *
 * `role="alert"` is assertive: it interrupts whatever is being read. That is
 * right for a message that exists *because the user just did something* and
 * wrong for one that is part of the page on arrival — `AnnouncementSettings`'
 * standing "no webhook, so nothing will post" would otherwise interrupt every
 * visit to Settings, and `/dev-login`'s permanent banner every page it sits on.
 *
 * So the two kinds are told apart by `standing`, and the default is the one
 * that is safe for a refusal. A new call site that never thinks about this gets
 * announced, which is noisy at worst; the reverse default would make the next
 * refusal silent, which is the defect this exists to close.
 *
 * ## Which one a call site is
 *
 * The question that decides it is **can this content already be in the markup
 * when the page first renders?**
 *
 * - If yes — the condition is satisfied by server data or props alone, or there
 *   is no condition — it is `standing`. It is ordinary document content, read in
 *   its place in the reading order, and interrupting with it on arrival is the
 *   trap.
 * - If no — it exists only because of something the user did in this session:
 *   state a handler set, a dialog they opened, an unsaved edit they made — it is
 *   announced, because nothing else will tell them it appeared.
 *
 * `aria-live="assertive"` is what `role="alert"` already implies. It is written
 * out because that implication is the thing the browser sweep found null, and
 * because the pair is what assistive technology is most reliably tested
 * against. It adds no behaviour that the role does not already ask for.
 *
 * `id` exists so that an input whose value a refusal is about can point its
 * `aria-describedby` at the refusal. See `TemplatesManager`, the wording editor
 * in `AnnouncementSettings`, and `ApplyForm`.
 */

export type AlertTone = "flare" | "union" | "success";

const TONE: Record<AlertTone, string> = {
  flare: "border-flare/40 bg-flare-tint-10 text-flare",
  union: "border-union/40 bg-union-tint-10 text-union",
  success: "border-success/40 bg-success-tint-10 text-success",
};

export type AlertProps = {
  tone?: AlertTone;
  /**
   * `true` when this Alert can already be on the page as it first renders, so it
   * is read as document content instead of interrupting. Leave it off for
   * anything that appears because of something the user did.
   */
  standing?: boolean;
  /** Target for an input's `aria-describedby` when the refusal is about its value. */
  id?: string;
  className?: string;
  children?: ReactNode;
};

export default function Alert({
  tone = "flare",
  standing = false,
  id,
  className,
  children,
}: AlertProps) {
  return (
    <div
      id={id}
      role={standing ? undefined : "alert"}
      aria-live={standing ? undefined : "assertive"}
      className={cx("border px-3 py-2 text-14", TONE[tone], className)}
    >
      {children}
    </div>
  );
}
