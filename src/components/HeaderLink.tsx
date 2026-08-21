"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A top-bar destination.
 *
 * Text on the ground, with the current one lit and carrying a short underline.
 * No border, no fill, no box — a row of bordered buttons reads as a single
 * object, and the point of a nav is that each item is its own place.
 *
 * The current item is matched on the path *and* the query, because `/events`
 * and `/events?when=past` are two destinations in this bar and differ only
 * there.
 */
export default function HeaderLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();

  const [path, query] = href.split("?");
  const current =
    query === undefined
      ? pathname === path && !params.toString()
      : pathname === path && params.toString() === query;

  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "relative py-1 text-sm transition-colors",
        current ? "text-hot" : "text-muted hover:text-chalk"
      )}
    >
      {children}
      {current && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 left-0 right-0 h-px bg-union"
        />
      )}
    </Link>
  );
}
