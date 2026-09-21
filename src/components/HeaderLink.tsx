"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A top-bar destination.
 *
 * Text on the ground, with the current one lit and carrying a short underline.
 * No border, no fill, no box — a row of bordered buttons reads as a single
 * object, and the point of a nav is that each item is its own place.
 *
 * Matched on the path alone.
 *
 * It used to compare the query as well, because the archive lived at
 * `/events?when=past` and the two items differed only there. The archive has
 * its own address now, so every item in this bar is its own path — and
 * comparing the query had become actively wrong: `/events?type=tournament` is
 * still the events page, and matching exactly left nothing lit the moment
 * somebody used the kind filter.
 */
/**
 * How loud an item is when it is not the current page.
 *
 * `strong` is for the one destination that is meant to sit above the list —
 * the championship (R-194). It changes the resting state only: the brightest
 * step of the type ladder at the next weight up, against the others' muted
 * regular. Nothing about the current-page treatment moves, because a row where
 * "you are here" is said two different ways is a row that says it once badly.
 */
export type HeaderLinkTone = "default" | "strong";

const REST: Record<HeaderLinkTone, string> = {
  default: "text-muted hover:text-chalk",
  strong: "font-medium text-chalk hover:text-hot",
};

export default function HeaderLink({
  href,
  tone = "default",
  children,
}: {
  href: string;
  tone?: HeaderLinkTone;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const [path] = href.split("?");
  const current = pathname === path;

  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "relative py-1 text-14 transition-colors",
        current ? "text-hot" : REST[tone]
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
