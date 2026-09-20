import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The one content width on the site, and the `<main>` that carries it.
 *
 * Before this there were nine: 860, 880, 900, 1000, 1100, 1200, 1400 and 1500,
 * plus a `max-w-lg`, each picked by whoever wrote the page. Polls sat 540px
 * narrower than the events list it links to, so moving between two pages of
 * the same site moved the left edge of the text — which reads as two products,
 * not one. The number is not the point; having exactly one of it is.
 *
 * **1100px**, because that is the widest the page can be before it stops being
 * a page. The prose at the top of every page is capped at `max-w-xl` /
 * `max-w-2xl` on the paragraph itself, so the container is never what sets the
 * measure; what it does set is how far a 14px row of event metadata or an
 * audit line is allowed to stretch, and past ~1100 those run to 150 characters
 * with the eye having to travel the whole way back. Below it, the widest thing
 * that should not need a scroller starts to need one: the applicants table is
 * `min-w-[820px]`, the availability grid `min-w-[44rem]`, and the admin
 * two-column layouts want a 320px rail beside a column that still reads.
 * 1100 + the 24px gutters also lands inside a 1152px laptop viewport, so the
 * common case is the full width rather than a squeezed one.
 *
 * Wide content is not this component's problem: anything genuinely wider than
 * the page scrolls inside its own `overflow-x-auto` box, which is the pattern
 * `AvailabilityGrid`, `BracketCanvas`, `StandingsTable` and the admin tables
 * already use. Nothing widens the page.
 *
 * `AppHeader` and the draft room's own bar use `PAGE_SHELL` directly so their
 * contents line up with the page under them — same width, same padding, one
 * vertical edge down the screen.
 */
export const PAGE_SHELL = "mx-auto w-full max-w-[1100px] px-4 sm:px-6";

export type PageProps = {
  /**
   * Layout for the page's own content — `space-y-6`, or a grid.
   *
   * Not width, and not padding. The shell owns both, `cx` is a string join
   * with no idea that two Tailwind classes conflict, and `py-8 py-12` is
   * settled by whichever rule the stylesheet happens to emit second. The
   * page-width guard fails the build on either rather than leave it to that.
   */
  className?: string;
  children?: ReactNode;
};

/**
 * The `<main>` of a page. Vertical padding lives here too, so the top of every
 * page starts on the same line; pass only what stacks the content inside it.
 */
export default function Page({ className, children }: PageProps) {
  return <main className={cx(PAGE_SHELL, "py-8", className)}>{children}</main>;
}
