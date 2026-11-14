"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";
import type { AdminSection } from "./sections";

/**
 * The admin area's own navigation, sat in the top bar next to the session links.
 *
 * The row itself, and a client component because which link is *current* is a
 * question about the URL in the browser. Which links there are is not decided
 * here: `AdminNav` asks what the signed-in member's powers reach and hands
 * the answer down as `sections` (R-265 / UC-56 2), the split `SiteNav` and
 * `SiteNavLinks` already have.
 *
 * Up to eleven sections as text links on the ground rather than eleven bordered buttons:
 * side by side, boxes read as one object and the bar stops looking like
 * navigation at all. Only the current section is lit, and it carries a
 * hairline under it.
 *
 * Availability (UC-07 1) and the host queue are here because they were not,
 * and the account menu had them: a page an admin is told to "open" in a use
 * case has to be reachable from the bar that lists the admin area, or the use
 * case starts with a step nobody can take.
 *
 * Every one of these also lives in the account menu, which is where they are
 * reachable from on a narrow screen — this row hides below `lg` rather than
 * collapsing into a hamburger, per §4.
 *
 * `startsWith` rather than equality, so `/admin/events/[id]` still lights the
 * Events link — except for `/admin` itself, which is a prefix of every other
 * link here and would otherwise light permanently. It gets an exact match.
 */

export default function AdminNavLinks({
  sections,
  className,
}: {
  /** What this reader's powers reach - `sectionsFor`'s answer, from `AdminNav`. */
  sections: readonly AdminSection[];
  className?: string;
}) {
  const pathname = usePathname() ?? "";
  // A manager of one event who holds no power is on an admin page with no
  // section to go to, and an empty bar is not navigation.
  if (sections.length === 0) return null;

  return (
    <nav
      /*
       * `min-w-0` so the header can shrink this instead of widening past the
       * page shell, and `overflow-x-auto` so what will not fit is still
       * reachable. `overflow-y-hidden` is explicit: `overflow-x: auto` promotes
       * the other axis to `auto` too, and a vertical scrollbar inside a 72px
       * bar is not a thing anybody asked for.
       */
      className={cx(
        // `py-2` is not spacing: the active link's underline hangs 2px below
        // its box, and `overflow-y-hidden` would otherwise shave it off.
        "hidden min-w-0 items-center gap-5 overflow-x-auto overflow-y-hidden py-2 lg:flex",
        className
      )}
      aria-label="Admin sections"
    >
      {sections.map((section) => {
        const active =
          section.exact
            ? pathname === section.href
            : pathname === section.href || pathname.startsWith(`${section.href}/`);
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "relative py-1 text-14 transition-colors",
              active ? "text-hot" : "text-muted hover:text-chalk"
            )}
          >
            {section.label}
            {active && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 left-0 right-0 h-px bg-union"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
