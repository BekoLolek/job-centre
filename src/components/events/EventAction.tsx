import { Button, cx } from "@/components/ui";
import type { ViewerAction } from "./viewer";

/**
 * The call to action for one viewer, as computed by {@link viewerAction}.
 *
 * Renders a button when there is something to press and a plain line when there
 * is not — an "Applications closed" state is news, not a disabled control, and
 * a greyed-out button that says Apply is the single most annoying thing a
 * signup page can show you.
 *
 * The sentence underneath is never optional. Every closed state carries the
 * reason it is closed, and every blocked one carries the rank you would need.
 */

export type EventActionProps = {
  action: ViewerAction;
  /** `md` on an event page header, `sm` on a card. */
  size?: "sm" | "md";
  className?: string;
};

const TONE: Record<ViewerAction["tone"], string> = {
  gold: "text-gold",
  signal: "text-signal",
  muted: "text-muted",
  ember: "text-ember",
};

export default function EventAction({ action, size = "md", className }: EventActionProps) {
  return (
    <div className={cx("space-y-2", className)}>
      {action.href ? (
        <Button
          href={action.href}
          size={size === "sm" ? "sm" : "md"}
          variant={action.primary ? "gold" : "default"}
        >
          {action.label}
        </Button>
      ) : (
        <p
          className={cx(
            "font-display tracking-wide",
            size === "sm" ? "text-lg" : "text-2xl",
            TONE[action.tone]
          )}
        >
          {action.label}
        </p>
      )}

      <p className={cx("text-xs leading-relaxed", action.href ? "text-muted" : TONE[action.tone])}>
        {action.detail}
      </p>
    </div>
  );
}
