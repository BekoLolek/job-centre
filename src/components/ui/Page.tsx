import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The content widths on the site, and the `<main>` that carries one.
 *
 * ## Three, chosen; not nine, copied
 *
 * Before the first version of this file there were nine: 860, 880, 900, 1000,
 * 1100, 1200, 1400 and 1500, plus a `max-w-lg`, each picked by whoever wrote
 * the page. Polls sat 540px narrower than the events list it links to, so
 * moving between two pages of the same site moved the left edge of the text —
 * which reads as two products, not one.
 *
 * That was fixed by collapsing all nine to a single 1100. One number is easy to
 * hold and it did stop the edge jumping, but it was the wrong shape of answer:
 * the availability grid and the event editor's applicant table were both being
 * squeezed into a column sized for an audit line, and the suggestion box and
 * the application form were both being stretched to 1100 for a single column of
 * prose that wants 65 characters. A width is a decision about *content*, and
 * there are three kinds of content here, so there are three widths:
 *
 * | token      | cap    | for                                                   |
 * |------------|--------|-------------------------------------------------------|
 * | `reading`  | 880px  | prose and single-column forms                         |
 * | `standard` | 1200px | lists, dashboards, a page of sections — the default   |
 * | `wide`     | 1400px | the dense grids and tables, and the draft room        |
 *
 * Three is not nine because the set is closed and named. A page picks a token,
 * not a number; `page-width.test.ts` fails the build on a fourth.
 *
 * **The gutters are the same for all three**, which is what keeps the edge from
 * jumping where it would be noticed. `AppHeader` sits over every page at
 * `standard`, so on a `reading` page the text starts further in than the
 * wordmark and on a `wide` page further out — but both move by a whole step at
 * a time, on a page you navigated to, rather than by 8px for no reason. What
 * must never differ is the padding, because that is the one number two
 * *adjacent* elements — a sticky bar and the column under it — are compared on.
 *
 * ## Which token a page gets
 *
 * `reading` is the narrow one and it is for a measure: a column of prose, or a
 * form that is a column of fields. `/me/profile`, `/events/[slug]/apply`,
 * `/host`, `/polls`, `/suggestions`, `/me/notifications` and `/admin/host` are
 * all one column of text or controls and nothing else, and at 1200 the eye has
 * to travel the width of a laptop to get back to the start of the next line.
 *
 * `wide` is for content that is already wider than a page and scrolls inside
 * its own box: `AvailabilityGrid` is `min-w-[44rem]` and stretches to whatever
 * it is given, `ApplicantsTab`'s table is `min-w-[820px]`, and the draft room
 * puts a 320px rail beside a stage that needs 560 before the wheel stops
 * reading. Giving those 200px more is 200px fewer inside a scroller.
 *
 * Everything else is `standard`, which is the default here precisely so that a
 * new page that has not thought about it lands in the middle rather than at an
 * extreme.
 *
 * Nothing on a page widens the page. Anything genuinely wider than its token
 * scrolls inside its own `overflow-x-auto` box, which is the pattern
 * `AvailabilityGrid`, `BracketCanvas`, `StandingsTable` and the admin tables
 * already use.
 */

/** The three, and the only three. A page names one; nothing writes a pixel. */
export const PAGE_WIDTHS = {
  reading: "max-w-[880px]",
  standard: "max-w-[1200px]",
  wide: "max-w-[1400px]",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTHS;

/**
 * The gutters, shared by all three widths and by every bar that spans a page.
 *
 * `px-4 sm:px-6` is 16px on a phone and 24px from 640 up. It is deliberately
 * not part of `PAGE_WIDTHS`: a width is a choice a page makes, and the gutters
 * are not — a page that could set its own padding is a page whose sticky bar
 * and whose `<h1>` can disagree about where the column starts, which is the
 * defect this file exists to prevent and the one it shipped with (the header
 * bar was `px-5 sm:px-8` over pages at `px-4 sm:px-6`, so the wordmark sat 8px
 * further in than the heading it introduced).
 */
export const PAGE_GUTTERS = "mx-auto w-full px-4 sm:px-6";

/**
 * The shell for one width: the gutters, then the cap.
 *
 * Exported because the bars that span a page are not pages and cannot render
 * `Page`, but have to line up with it to the pixel — `AppHeader`,
 * `DevLoginBanner` and the draft room's own bar all build their inner row from
 * this. The draft room is the reason this takes an argument: its page is
 * `wide`, so a bar hard-coded to the standard shell would stop 200px short of
 * the content under it.
 */
export function pageShell(width: PageWidth): string {
  return `${PAGE_GUTTERS} ${PAGE_WIDTHS[width]}`;
}

/**
 * The standard shell, for the two bars that sit over ordinary pages.
 *
 * Derived rather than written out, so there is no second copy of 1200 to go
 * stale against `PAGE_WIDTHS`.
 */
export const PAGE_SHELL = pageShell("standard");

export type PageProps = {
  /**
   * Which of the three widths this page is.
   *
   * `standard` by default: a page that has not made the decision should land in
   * the middle, not at an extreme.
   */
  width?: PageWidth;
  /**
   * Layout for the page's own content — `space-y-6`, or a grid.
   *
   * Not width, and not padding. The shell owns both, `cx` is a string join with
   * no idea that two Tailwind classes conflict, and `py-8 py-12` is settled by
   * whichever rule the stylesheet happens to emit second. The page-width guard
   * fails the build on either rather than leave it to that.
   */
  className?: string;
  children?: ReactNode;
};

/**
 * The `<main>` of a page. Vertical padding lives here too, so the top of every
 * page starts on the same line; pass only what stacks the content inside it.
 */
export default function Page({ width = "standard", className, children }: PageProps) {
  return <main className={cx(pageShell(width), "py-8", className)}>{children}</main>;
}
