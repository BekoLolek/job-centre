import type { ReactNode } from "react";
import { cx } from "./cx";

/** Use for the quiet one-liner that stands in for a list with nothing in it yet. */

export type EmptyStateProps = {
  /** `sm` inside a rail or a dense list, `md` in a full-width section. */
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
};

export default function EmptyState({ size = "md", className, children }: EmptyStateProps) {
  return (
    <p className={cx(size === "sm" ? "text-xs" : "text-sm", "text-muted", className)}>
      {children}
    </p>
  );
}
