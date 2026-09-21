"use client";

import { usePathname } from "next/navigation";
import HeaderLink from "./HeaderLink";

/**
 * The public destinations in the top bar — and nothing at all under `/admin`.
 *
 * The admin area puts its own seven sections in the same bar, and the two rows
 * together do not fit the page: 129px of wordmark, 479px of admin sections and
 * a 271px account menu is already 879 of the 1052px content box, and these
 * links are another 292 plus a gap. Before this the row simply grew past the
 * shell and the account menu sat 85px outside the column every page's `<h1>`
 * starts from; after `min-w-0` it fitted, but only by scrolling the admin nav
 * sideways on a 1440px desktop, which reads as broken rather than as a
 * decision.
 *
 * So on admin routes the site links stand down and the section nav gets the
 * room. Nothing is unreachable: the wordmark goes home, and the account menu
 * carries the rest.
 *
 * ## The championship sits apart
 *
 * R-194 asks for it to be a cut above the other four, and the four are all one
 * thing: quiet text, evenly spaced, none louder than another. So the way to
 * raise one is not to paint it — blue means *interactive* on this site and
 * spending it on emphasis is what makes an accent stop meaning anything — but
 * to take it out of the row. A hairline and a wider gap separate it, and it is
 * set in the brightest step of the type ladder at the next weight up while
 * every other item stays muted and regular. Same size, same colour vocabulary,
 * same current-page treatment; it is simply the one item that is not part of
 * the list.
 *
 * It is here at all only while a season is published (UC-34 1a) — see
 * `SiteNav`, which asks.
 */
export default function SiteNavLinks({
  /** True when a season is published, and there is therefore somewhere to go. */
  championship,
}: {
  championship: boolean;
}) {
  const pathname = usePathname() ?? "";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;

  return (
    <nav className="hidden shrink-0 items-center gap-7 md:flex" aria-label="Main">
      <HeaderLink href="/events">Events</HeaderLink>
      <HeaderLink href="/archive">Archive</HeaderLink>
      <HeaderLink href="/suggestions">Suggestions</HeaderLink>
      <HeaderLink href="/polls">Polls</HeaderLink>

      {championship && (
        <>
          <span aria-hidden className="h-4 w-px bg-hair" />
          <HeaderLink href="/championship" tone="strong">
            Championship
          </HeaderLink>
        </>
      )}
    </nav>
  );
}
