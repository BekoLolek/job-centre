"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

/**
 * The admin area's own navigation, sat in the top bar next to the session links.
 *
 * Plan §4 gives the admin area a left sidebar eventually. This is the two-link
 * version of that, and it exists now because `/admin/events` is otherwise only
 * reachable by typing the URL — a page nobody can navigate to is a page that
 * does not really exist. It grows a row per section rather than a hamburger,
 * per §4's "no hamburger menus on desktop".
 *
 * `startsWith` rather than equality, so `/admin/events/[id]` still lights the
 * Events link — except for `/admin` itself, which is a prefix of every other
 * link here and would otherwise light permanently. It gets an exact match.
 */

const SECTIONS = [
  { href: "/admin", label: "Tonight", exact: true },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/games", label: "Games" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export default function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";

  return (
    <nav className={cx("flex border border-hair", className)} aria-label="Admin sections">
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
              "btn border-0",
              active ? "bg-gold/10 text-gold" : "bg-transparent text-muted"
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
