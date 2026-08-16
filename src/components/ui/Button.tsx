"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "./cx";

/** Use for every clickable `.btn` — pass `href` to get the same chrome as a next/link. */

/** `gold` is the primary/commit action, `ember` the destructive one. */
export type ButtonVariant = "default" | "gold" | "ember";
/** `md` keeps the padding baked into `.btn`; `sm` is the compact header/inline size. */
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  default: "",
  gold: "btn-gold",
  ember: "btn-ember",
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
