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
export type MoneySize = "sm" | "md" | "lg" | "xl" | "2xl";

const TONE: Record<MoneyTone, string> = {
  union: "text-union",
  chalk: "text-chalk",
  muted: "text-muted",
  flare: "text-flare",
  success: "text-success",
};

/*
 * The step has to come from here and not from a `text-*` on the call site.
 *
 * `.num` is in `@layer components` since Task 65, so a `text-*` passed through
 * `className` does beat it — but it does *not* beat the step this table already
 * wrote. Both are utilities at 0-1-0 in the same layer, so the winner is
 * whichever Tailwind emitted later, which is its `fontSize` key order and not
 * the author's intent. `cx` putting `className` last changes nothing: class
 * attribute order has never decided a cascade.
 *
 * `BidBox` wanted 48px and wrote `size="xl" className="text-48"`, i.e. 24px and
 * 48px at once. It happened to render 48 because `text-48` is emitted after
 * `text-24`; it would have silently flipped if the scale were reordered. `2xl`
 * is that call site's size, named, so there is one font-size in the list.
 */
const SIZE: Record<MoneySize, string> = {
  sm: "text-12",
  md: "text-14",
  lg: "text-16",
  xl: "font-display text-24 leading-none",
  "2xl": "font-display text-48 leading-none",
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
