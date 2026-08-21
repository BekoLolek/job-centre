import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cx } from "./cx";

/**
 * A region of a page.
 *
 * **Flat by default.** A panel is padding and nothing else: no fill, no border,
 * no corner. The page is one colour, and what separates a region from the one
 * below it is the space between them — the rule being that the gap between two
 * groups has to beat the gaps inside either of them, which is the whole reason
 * borders were needed in the first place.
 *
 * `tone="wash"` lifts a region onto a faint surface. That is for the handful of
 * places where something genuinely floats above the page — a menu, a dialog, a
 * thing you are meant to read as detached — and not for section headings with
 * content underneath, which is what it was doing on every page before.
 */

/** `none` for tables/lists that manage their own padding, otherwise `sm`/`md`/`lg`. */
export type PanelPadding = "none" | "sm" | "md" | "lg";
export type PanelTone = "flat" | "wash";

/*
 * Generous, because with no edge the padding is the only thing holding a region
 * apart from what is next to it.
 */
const PADDING: Record<PanelPadding, string> = {
  none: "",
  sm: "p-5",
  md: "p-6",
  lg: "p-7 sm:p-8",
};

type PanelProps<T extends ElementType> = {
  /** Element to render — `div` by default; `section`, `aside`, `article`, `form`… */
  as?: T;
  padding?: PanelPadding;
  /** `flat` is the page itself. `wash` is for things that float above it. */
  tone?: PanelTone;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export default function Panel<T extends ElementType = "div">({
  as,
  padding = "lg",
  tone = "flat",
  className,
  children,
  ...rest
}: PanelProps<T>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cx(tone === "wash" && "panel", PADDING[padding], className)} {...rest}>
      {children}
    </Tag>
  );
}
