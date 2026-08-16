import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Use for the small mono uppercase label that titles nearly every block on the site. */

type EyebrowTag = "div" | "span" | "p" | "h1" | "h2" | "h3" | "h4";

export type EyebrowProps = {
  /** Element to render — `div` by default; use `span` inline, `h2`/`h3` for headings. */
  as?: EyebrowTag;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

export default function Eyebrow({ as: Tag = "div", className, children, ...rest }: EyebrowProps) {
  return (
    <Tag className={cx("eyebrow", className)} {...rest}>
      {children}
    </Tag>
  );
}
