import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cx } from "./cx";

/** Use for any raised `.panel` surface — cards, rails, sections, the standings shell. */

/** `none` for tables/lists that manage their own padding, otherwise `sm`/`md`/`lg`. */
export type PanelPadding = "none" | "sm" | "md" | "lg";

/*
 * Bigger than it looks like it needs to be, on purpose. With the border gone,
 * the padding is the only thing holding a panel apart from what is next to it.
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
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export default function Panel<T extends ElementType = "div">({
  as,
  padding = "lg",
  className,
  children,
  ...rest
}: PanelProps<T>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cx("panel", PADDING[padding], className)} {...rest}>
      {children}
    </Tag>
  );
}
