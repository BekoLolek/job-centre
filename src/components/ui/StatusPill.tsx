import type { ReactNode } from "react";
import { cx } from "./cx";

/** Use to show the state of a thing (event, match, lot) — the colour is fixed per status. */

export type Status =
  | "draft"
  | "open"
  | "closed"
  | "live"
  | "complete"
  | "cancelled";

const TONE: Record<Status, string> = {
  draft: "bg-white/[0.05] text-muted",
  open: "bg-gold/15 text-gold",
  closed: "bg-white/[0.05] text-muted",
  live: "bg-ember/15 text-ember",
  complete: "bg-signal/15 text-signal",
  cancelled: "bg-white/[0.04] text-ember/70",
};

const FALLBACK = TONE.draft;

export type StatusPillProps = {
  /** Any of the known statuses; anything else falls back to the neutral `draft` tone. */
  status: Status | (string & {});
  /** Override the text — defaults to the status with a capital first letter. */
  label?: ReactNode;
  className?: string;
};

export default function StatusPill({ status, label, className }: StatusPillProps) {
  const key = String(status).toLowerCase();
  const tone = (TONE as Record<string, string | undefined>)[key] ?? FALLBACK;
  return (
    <span
      className={cx(
        "eyebrow inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        tone,
        className
      )}
    >
      <span
        className={cx(
          "inline-block h-1.5 w-1.5 rounded-full bg-current",
          key === "live" && "live-dot"
        )}
      />
      {label ?? key.charAt(0).toUpperCase() + key.slice(1)}
    </span>
  );
}
