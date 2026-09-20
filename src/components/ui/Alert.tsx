import type { ReactNode } from "react";
import { cx } from "./cx";

/** Use for the inline tinted message bar that reports a failed save or a warning. */

export type AlertTone = "flare" | "union" | "success";

const TONE: Record<AlertTone, string> = {
  flare: "border-flare/40 bg-flare-tint-10 text-flare",
  union: "border-union/40 bg-union-tint-10 text-union",
  success: "border-success/40 bg-success-tint-10 text-success",
};

export type AlertProps = {
  tone?: AlertTone;
  className?: string;
  children?: ReactNode;
};

export default function Alert({ tone = "flare", className, children }: AlertProps) {
  return <div className={cx("border px-3 py-2 text-14", TONE[tone], className)}>{children}</div>;
}
