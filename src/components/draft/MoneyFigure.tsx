import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { formatMoney } from "./money";

/**
 * A money figure — tabular numerals, union blue by default, one component.
 *
 * Union blue is the plan's money colour (§5) and every balance on the current board
 * is already `num text-union`; this is that pairing given a name so the room and
 * the setup screens cannot drift apart on it. `tone` exists because a *spent*
 * figure and a *remaining* figure both want the mono numerals and only one of
 * them wants to look like money you still have.
 */

export type MoneyTone = "union" | "chalk" | "muted" | "flare" | "success";
export type MoneySize = "sm" | "md" | "lg" | "xl";

const TONE: Record<MoneyTone, string> = {
  union: "text-union",
  chalk: "text-chalk",
  muted: "text-muted",
  flare: "text-flare",
  success: "text-success",
};

const SIZE: Record<MoneySize, string> = {
  sm: "text-12",
  md: "text-14",
  lg: "text-16",
  xl: "font-display text-24 leading-none",
};

export type MoneyProps = {
  value: number;
  tone?: MoneyTone;
  size?: MoneySize;
  /** Rendered before the figure in the same tone — a label, an arrow. */
  prefix?: ReactNode;
  /** Rendered after it, smaller and muted — "left", "of 1,000". */
  suffix?: ReactNode;
  className?: string;
};

export default function Money({
  value,
  tone = "union",
  size = "md",
  prefix,
  suffix,
  className,
}: MoneyProps) {
  return (
    <span className={cx("num whitespace-nowrap", SIZE[size], TONE[tone], className)}>
      {prefix}
      {formatMoney(value)}
      {suffix && <span className="ml-1 text-11 text-muted">{suffix}</span>}
    </span>
  );
}
