import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Use for a small static chip — roster names, tags, counts. For state, use StatusPill. */

export type BadgeTone = "default" | "union" | "flare" | "success";

/* Tint only. An outline around something this small is all edge and no chip. */
const TONE: Record<BadgeTone, string> = {
  default: "bg-overlay-2 text-chalk/80",
  union: "bg-union-tint-15 text-union",
  flare: "bg-flare-tint-15 text-flare",
  success: "bg-success-tint-15 text-success",
};

export type BadgeProps = {
  tone?: BadgeTone;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">;

export default function Badge({ tone = "default", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx("inline-block rounded-full px-2.5 py-0.5 text-11", TONE[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}
