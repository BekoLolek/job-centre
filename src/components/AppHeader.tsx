/**
 * The top bar the member and admin pages share.
 *
 * Navigation is text links, not buttons. A button is a thing you press to make
 * something happen; going to another page is not that, and a row of bordered
 * boxes reads as one block of chrome rather than as separate destinations —
 * which is what made this bar feel crowded when it held four links. Links sit
 * on the ground with space around them and only the current one is lit.
 *
 * Everything about identity lives in `SessionNav`'s account menu on the right.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import HeaderLink from "./HeaderLink";
import SessionNav from "./SessionNav";

export default function AppHeader({
  /** The word after "Job Centre", picked out in union blue. */
  section,
  /** Extra controls, left of the account menu. */
  children,
}: {
  section: string;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
      <div className="mx-auto flex h-[72px] max-w-[1400px] items-center gap-8 px-5 sm:px-8">
        <Link
          href="/"
          className="wordmark shrink-0 text-chalk transition-colors hover:text-hot"
        >
          JOB CENTRE<span className="text-union"> {section}</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Main">
          <HeaderLink href="/events">Events</HeaderLink>
          <HeaderLink href="/events?when=past">Archive</HeaderLink>
        </nav>

        <div className="ml-auto flex items-center gap-5">
          {children}
          <SessionNav />
        </div>
      </div>

      {/*
        The one place the flag is drawn. A hairline, fading out at both ends so
        it reads as a seam of light rather than a stripe pinned across the page.
      */}
      <div
        aria-hidden
        className="h-px bg-[linear-gradient(90deg,transparent,rgba(77,127,255,0.5)_18%,rgba(244,245,247,0.55)_50%,rgba(255,45,79,0.5)_82%,transparent)]"
      />
    </header>
  );
}
