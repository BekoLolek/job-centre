"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "./cx";

/** Use for every clickable `.btn` — pass `href` to get the same chrome as a next/link. */

/** `union` is the primary/commit action, `flare` the destructive one. */
export type ButtonVariant = "default" | "union" | "flare";
/**
 * `md` keeps the padding baked into `.btn`; `sm` is the compact header/inline size.
 *
 * Compact means narrower, not shorter: 1.6px a side, `px-3` (12px) against
 * `.btn`'s `0.85rem` (13.6px). Both sizes stand on `.btn`'s 44px
 * `min-height`, which `sm` writes nothing against — so its `py-1.5` only shows
 * on a button whose content is taller than the floor. Do not add a `min-h-*`
 * to `sm` to get the height back: 27px is what it was before the floor, and
 * `field-ordering.test.ts` refuses it.
 */
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  default: "",
  union: "btn-union",
  flare: "btn-flare",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5",
  md: "",
};

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
};

type AsButton = Common & {
  href?: undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

type AsLink = Common & {
  /** Renders a next/link styled as a button. `disabled` does not apply to links. */
  href: string;
} & Omit<ComponentPropsWithoutRef<typeof Link>, "className" | "children" | "href">;

export default function Button({
  variant = "default",
  size = "md",
  className,
  children,
  ...rest
}: AsButton | AsLink) {
  const classes = cx("btn", VARIANT[variant], SIZE[size], className);

  if (rest.href !== undefined) {
    const { href, ...linkRest } = rest;
    return (
      <Link href={href} className={classes} {...linkRest}>
        {children}
      </Link>
    );
  }

  const { href: _href, ...buttonRest } = rest;
  // No default `type`: several call sites rely on the native submit behaviour inside a form.
  return (
    <button className={classes} {...buttonRest}>
      {children}
    </button>
  );
}
