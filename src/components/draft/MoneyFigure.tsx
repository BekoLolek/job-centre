import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { formatMoney } from "./money";

/**
 * A money figure — tabular numerals, gold by default, one component.
 *
 * Gold is the plan's money colour (§5) and every balance on the current board
 * is already `num text-gold`; this is that pairing given a name so the room and
 * the setup screens cannot drift apart on it. `tone` exists because a *spent*
 * figure and a *remaining* figure both want the mono numerals and only one of
 * them wants to look like money you still have.
 */

export type MoneyTone = "gold" | "chalk" | "muted" | "ember" | "signal";
export type MoneySize = "sm" | "md" | "lg" | "xl";

const TONE: Record<MoneyTone, string> = {
  gold: "text-gold",
  chalk: "text-chalk",
  muted: "text-muted",
  ember: "text-ember",
  signal: "text-signal",
};

const SIZE: Record<MoneySize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
  xl: "font-display text-2xl leading-none",
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
  tone = "gold",
  size = "md",
  prefix,
  suffix,
  className,
}: MoneyProps) {
  return (
    <span className={cx("num whitespace-nowrap", SIZE[size], TONE[tone], className)}>
      {prefix}
      {formatMoney(value)}
      {suffix && <span className="ml-1 text-[10px] text-muted">{suffix}</span>}
    </span>
  );
}
