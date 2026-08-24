import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The small quiet label that titles blocks across the site.
 *
 * It carries its own colour rather than letting the `.eyebrow` class set one,
 * because that class loads after Tailwind's utilities and would override any
 * `text-*` passed in. Pass `text-muted` or a tone class to change it.
 */

type EyebrowTag = "div" | "span" | "p" | "h1" | "h2" | "h3" | "h4";

export type EyebrowProps = {
  /** Element to render — `div` by default; use `span` inline, `h2`/`h3` for headings. */
  as?: EyebrowTag;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

export default function Eyebrow({ as: Tag = "div", className, children, ...rest }: EyebrowProps) {
  return (
    <Tag className={cx("eyebrow text-dim", className)} {...rest}>
      {children}
    </Tag>
  );
}
