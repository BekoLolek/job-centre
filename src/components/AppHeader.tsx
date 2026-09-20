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
import { PAGE_SHELL, cx } from "./ui";
import SessionNav from "./SessionNav";
import SiteNav from "./SiteNav";

export default function AppHeader({
  /** Extra controls, left of the account menu. */
  children,
}: {
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
      <div className={cx(PAGE_SHELL, "flex h-[72px] items-center gap-6")}>
        {/*
          The mark is the same three words on every page. It used to be
          "JOB CENTRE" in chalk with the section after it — EVENTS, ARCHIVE,
          ADMIN — which made the one fixed thing in the chrome change under the
          reader every time they moved, and put the lit treatment on the word
          that mattered least. The title of the page is the `<h1>` under it and
          the `<title>` in the tab; the header says where you are by lighting
          the link in the nav. So the accent moved onto the name itself.
        */}
        <Link href="/" className="wordmark wordmark-accent shrink-0">
          Job Centre
        </Link>

        {/* Renders nothing under `/admin`, where `children` is the section
            nav and the bar has no room for both. See `SiteNav`. */}
        <SiteNav />

        {/*
          `min-w-0` is the backstop. A flex item defaults to `min-width: auto`,
          so a `children` row wider than the space left over pushes the bar
          past the shell instead of giving — and the account menu ends up
          outside the column every page's `<h1>` starts from, which is the one
          alignment this shell exists to hold. With it, a long `children` is
          what gives, and it scrolls inside itself.

          Nothing currently needs it: `SiteNav` stands the site links down
          under `/admin`, which is what makes the seven admin sections fit
          unscrolled. This is here so that the next thing put in this slot
          cannot break the alignment, only its own row.
        */}
        <div className="ml-auto flex min-w-0 items-center gap-5">
          {children}
          <div className="shrink-0">
            <SessionNav />
          </div>
        </div>
      </div>

      {/*
        The one place the flag is drawn. A hairline that fades out at both ends
        so it reads as a seam of light rather than a stripe pinned across the
        page, with the colour drifting slowly along it and a highlight crossing
        every nine seconds.

        Two elements, not one: the blurred copy underneath is what makes the
        line look lit instead of drawn, and it has to sit outside the 1px box
        to spill below it. See `.seam` in `globals.css`.
      */}
      <div aria-hidden className="relative h-px">
        <div className="seam-bloom" />
        <div className="seam" />
      </div>
    </header>
  );
}
