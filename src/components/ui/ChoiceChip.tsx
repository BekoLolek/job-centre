"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Use for a tappable answer — the atom of "clicks, not typing" (plan §2).
 *
 * One chip per option, laid out in a wrapping row: a select becomes a row of
 * pills, a multiselect a set of toggles, a rank ladder a tier row and a
 * division row. It is a `<button>`, not a styled label around a hidden input,
 * so keyboard and screen-reader behaviour comes from `aria-pressed` rather than
 * from a checkbox nobody can see.
 */

export type ChoiceChipProps = {
  selected?: boolean;
  /** Renders the chip in gold rather than chalk when selected — for a primary answer. */
  tone?: "default" | "gold";
  /** Fills the available width, for a two-up yes/no row. */
  block?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "type">;

export default function ChoiceChip({
  selected = false,
  tone = "gold",
  block,
  className,
  children,
  ...rest
}: ChoiceChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        // A pill that fills when chosen. The outlined version read as a form
        // control; this reads as a choice, which is what it is.
        "rounded-full px-3.5 py-2 text-sm transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-35",
        block && "flex-1",
        selected
          ? tone === "gold"
            ? "bg-union/20 text-hot"
            : "bg-chalk/15 text-hot"
          : "bg-white/[0.05] text-chalk/70 hover:bg-white/[0.09] hover:text-hot",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The wrapping row chips live in. Keeps the gap consistent everywhere. */
export function ChoiceRow({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return <div className={cx("flex flex-wrap gap-2", className)}>{children}</div>;
}
