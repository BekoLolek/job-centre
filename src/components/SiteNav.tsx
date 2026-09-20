"use client";

import { usePathname } from "next/navigation";
import HeaderLink from "./HeaderLink";

/**
 * The four public destinations in the top bar — and nothing at all under
 * `/admin`.
 *
 * The admin area puts its own seven sections in the same bar, and the two rows
 * together do not fit the page: 129px of wordmark, 479px of admin sections and
 * a 271px account menu is already 879 of the 1052px content box, and these
 * four links are another 292 plus a gap. Before this the row simply grew past
 * the shell and the account menu sat 85px outside the column every page's
 * `<h1>` starts from; after `min-w-0` it fitted, but only by scrolling the
 * admin nav sideways on a 1440px desktop, which reads as broken rather than as
 * a decision.
 *
 * So on admin routes the site links stand down and the section nav gets the
 * room. Nothing is unreachable: the wordmark goes home, and the account menu
 * carries the rest. Everywhere else this is the primary navigation and is
 * exactly as it was.
 *
 * A component rather than a prop because the rule is about the route, not
 * about the page: a new admin screen inherits it without its author having to
 * know it exists.
 */
export default function SiteNav() {
  const pathname = usePathname() ?? "";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;

  return (
    <nav className="hidden shrink-0 items-center gap-7 md:flex" aria-label="Main">
      <HeaderLink href="/events">Events</HeaderLink>
      <HeaderLink href="/archive">Archive</HeaderLink>
      <HeaderLink href="/suggestions">Suggestions</HeaderLink>
      <HeaderLink href="/polls">Polls</HeaderLink>
    </nav>
  );
}
