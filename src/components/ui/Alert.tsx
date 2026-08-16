import type { ReactNode } from "react";
import { cx } from "./cx";

/** Use for the inline tinted message bar that reports a failed save or a warning. */

export type AlertTone = "ember" | "gold" | "signal";

const TONE: Record<AlertTone, string> = {
  ember: "border-ember/40 bg-ember/10 text-ember",
  gold: "border-gold/40 bg-gold/10 text-gold",
  signal: "border-signal/40 bg-signal/10 text-signal",
};

export type AlertProps = {
  tone?: AlertTone;
  className?: string;
  children?: ReactNode;
};

export default function Alert({ tone = "ember", className, children }: AlertProps) {
  return <div className={cx("border px-3 py-2 text-sm", TONE[tone], className)}>{children}</div>;
}
