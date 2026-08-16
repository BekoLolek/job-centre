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
  draft: "border-hair bg-transparent text-muted",
  open: "border-gold/40 bg-gold/10 text-gold",
  closed: "border-hair bg-raised text-muted",
  live: "border-ember/50 bg-ember/10 text-ember",
  complete: "border-signal/40 bg-signal/10 text-signal",
  cancelled: "border-ember/30 bg-transparent text-ember/70",
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
        "eyebrow inline-flex items-center gap-1.5 border px-2 py-1",
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
