"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

/**
 * The admin area's own navigation, sat in the top bar next to the session links.
 *
 * Seven sections as text links on the ground rather than seven bordered
 * buttons: side by side, boxes read as one object and the bar stops looking
 * like navigation at all. Only the current section is lit, and it carries a
 * hairline under it.
 *
 * Every one of these also lives in the account menu, which is where they are
 * reachable from on a narrow screen — this row hides below `lg` rather than
 * collapsing into a hamburger, per §4.
 *
 * `startsWith` rather than equality, so `/admin/events/[id]` still lights the
 * Events link — except for `/admin` itself, which is a prefix of every other
 * link here and would otherwise light permanently. It gets an exact match.
 */

const SECTIONS = [
  { href: "/admin", label: "Tonight", exact: true },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/templates", label: "Templates" },
  { href: "/admin/games", label: "Games" },
  { href: "/admin/users", label: "Members" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export default function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";

  return (
    <nav className={cx("hidden items-center gap-6 lg:flex", className)} aria-label="Admin sections">
      {SECTIONS.map((section) => {
        const active =
          "exact" in section && section.exact
            ? pathname === section.href
            : pathname === section.href || pathname.startsWith(`${section.href}/`);
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "relative py-1 text-sm transition-colors",
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
