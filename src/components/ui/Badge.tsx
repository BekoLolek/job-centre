import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Use for a small static chip — roster names, tags, counts. For state, use StatusPill. */

export type BadgeTone = "default" | "gold" | "ember" | "signal";

/* Tint only. An outline around something this small is all edge and no chip. */
const TONE: Record<BadgeTone, string> = {
  default: "bg-white/[0.06] text-chalk/80",
  gold: "bg-gold/15 text-gold",
  ember: "bg-ember/15 text-ember",
  signal: "bg-signal/15 text-signal",
};

export type BadgeProps = {
  tone?: BadgeTone;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">;

export default function Badge({ tone = "default", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx("inline-block rounded-full px-2.5 py-0.5 text-[11px]", TONE[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}
