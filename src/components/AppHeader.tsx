/**
 * The top bar the member and admin pages share.
 *
 * Same sticky hairline chrome as the boards, minus their board-specific
 * controls: wordmark on the left, the §4 session links on the right. The boards
 * keep their own headers — this is for the pages that have no board.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import SessionNav from "./SessionNav";
import { Button } from "@/components/ui";

export default function AppHeader({
  /** The word after "JOB CENTRE", picked out in union blue. */
  section,
  /** Extra controls, left of the session links. */
  children,
}: {
  section: string;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
      {/* The flag, as a 2px seam: blue, white, red, left to right. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[2px] bg-[linear-gradient(90deg,var(--union-blue)_0%,var(--union-blue)_38%,var(--hot)_46%,var(--hot)_54%,var(--union-red)_62%,var(--union-red)_100%)] opacity-70"
      />
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="wordmark text-base tracking-wide transition-colors hover:text-hot"
        >
          JOB CENTRE<span className="text-union"> {section}</span>
        </Link>

        <div className="ml-auto flex items-center gap-3">
          {children}
          <Button href="/events" size="sm">
            Events
          </Button>
          <SessionNav />
        </div>
      </div>
    </header>
  );
}
