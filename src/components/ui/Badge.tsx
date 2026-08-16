import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Use for a small static chip — roster names, tags, counts. For state, use StatusPill. */

export type BadgeTone = "default" | "gold" | "ember" | "signal";

const TONE: Record<BadgeTone, string> = {
  default: "border-hair bg-ink/60 text-chalk/80",
  gold: "border-gold/50 bg-gold/10 text-gold",
  ember: "border-ember/50 bg-ember/10 text-ember",
  signal: "border-signal/50 bg-signal/10 text-signal",
};

export type BadgeProps = {
  tone?: BadgeTone;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">;

export default function Badge({ tone = "default", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx("inline-block border px-1.5 py-0.5 text-[11px]", TONE[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}
