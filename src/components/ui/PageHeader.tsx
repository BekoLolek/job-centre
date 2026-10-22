import type { ReactNode } from "react";
import Eyebrow from "./Eyebrow";

/**
 * The top of every page: what this is, what it is called, what it is for, and
 * the figures that go with it.
 *
 * ## Why one component and not a pattern
 *
 * All thirty routes already drew this, and no two drew it quite the same. The
 * heading was `text-36` on seven pages, `font-display text-36 leading-none` on
 * eleven, `text-48` on two, `text-30` on one and `text-24` on another; the
 * intro was capped at `max-w-xl` on eleven and `max-w-2xl` on six; the eyebrow
 * had `mb-1`, `mb-2`, `mb-3` or nothing; six headers were wrapped in a `Panel`
 * for padding that insets the title from the page column the content below it
 * starts at, which is the one alignment the shell exists to hold. None of those
 * is wrong on its own. Thirty of them is, and a reader moving between two pages
 * sees it as the site not quite knowing what it looks like.
 *
 * So the decisions are made once, here:
 *
 * - **One heading size.** `text-36` — the scale in `tailwind.config.ts` names
 *   that step "page h1" and this is the only thing that should use it. Its 40px
 *   line height is kept rather than crushed with `leading-none`, because a long
 *   event name wraps to two lines at 400px and two 36px lines at 36px leading
 *   collide. The event page's title dropped 48 → 36 in the process: a hero is
 *   made by a banner, a countdown and a call to action, not by 12px of type.
 * - **No `font-display`.** `h1` in `globals.css` already sets the weight and
 *   tightens the tracking to -0.028em; `.font-display` is the same weight at
 *   -0.019em, so on a heading it did nothing but *loosen* the one it was added
 *   to look deliberate about.
 * - **One measure for the intro.** `62ch`, inside the 60-75 characters prose
 *   wants, instead of an `xl`/`2xl` guess per page.
 * - **No entrance animation.** Six of these rose on load. The page header is
 *   the first thing read on arrival, and animating it in on every navigation is
 *   the "fade in every section" tell; `rise` stays for things that genuinely
 *   appear, like an alert that was not there a moment ago.
 * - **One `<h1>`, and it is the page's own title.** `/` used to make its `<h1>`
 *   whichever event happened to be next, under two `<section>`s, which is both
 *   the wrong outline for a screen reader and a heading that changes when the
 *   calendar does.
 *
 * ## The slots
 *
 * Four are the header: `eyebrow`, `title`, `intro`, `aside`. Two more exist
 * because the pages that need them need them three and two times over, and the
 * alternative was those pages keeping a hand-built header:
 *
 * - `lead` — something beside the title rather than above it. The avatar on
 *   `/me`, `/me/profile` and `/players/[handle]`, where the page is a person.
 * - `banner` — a full-width strip above everything else. The event banner on
 *   `/` and `/events/[slug]`, which is content the organiser uploaded.
 *
 * There is no `className`. A header that call sites can nudge is a header that
 * drifts back to thirty, which is where this started.
 */
export type PageHeaderProps = {
  /**
   * The quiet line above the title, saying where you are: `Admin · Events`,
   * `Job Centre · Polls`, `/players/ada`.
   *
   * Required, and a `ReactNode` rather than a string so it can carry a count or
   * a name. It goes through `Eyebrow`, not `className="eyebrow"` — the class
   * loads after Tailwind's utilities and silently beats any colour next to it.
   */
  eyebrow: ReactNode;
  /** The page's name, rendered as its one `<h1>`. */
  title: ReactNode;
  /**
   * What the page is for, under the title. Prose, or the pills and dates that
   * describe the thing the page is about.
   *
   * A `<div>`, not a `<p>`: the event pages put a row of badges and a date
   * range in here, and a `<div>` inside a `<p>` closes the paragraph early and
   * leaves the markup nested differently from how it reads.
   */
  intro?: ReactNode;
  /**
   * The figures, or the one button out — `StatTile`s on fifteen pages, a link
   * back on two. Pushed to the right of the title from `sm` up, and underneath
   * it below that.
   */
  aside?: ReactNode;
  /** Beside the title: an avatar, on the three pages that are about a person. */
  lead?: ReactNode;
  /** Above everything: the event banner, on the two pages that have one. */
  banner?: ReactNode;
};

export default function PageHeader({
  eyebrow,
  title,
  intro,
  aside,
  lead,
  banner,
}: PageHeaderProps) {
  return (
    <header>
      {/*
        `mb-6` on the banner rather than `space-y-6` on the header, so that a
        header without one has no stray empty box above it and the spacing
        between the header and the first section below is `Page`'s business
        either way.
      */}
      {banner && <div className="mb-6">{banner}</div>}

      <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
        {/*
          `lead` and the words are one flex item, centred against each other,
          so that an avatar lines up with the name beside it — while the row
          outside is `items-end`, which is what sits a column of figures on the
          same line as the bottom of the intro rather than floating it against
          the middle of a paragraph.

          `min-w-0` on both: a flex item defaults to `min-width: auto`, so a
          long title would push the aside out of the column instead of wrapping.
        */}
        <div className="flex min-w-0 flex-wrap items-center gap-5">
          {lead}
          <div className="min-w-0">
            <Eyebrow className="mb-2">{eyebrow}</Eyebrow>
            <h1 className="text-36">{title}</h1>
            {intro && (
              <div className="mt-3 max-w-[62ch] text-14 leading-relaxed text-muted">{intro}</div>
            )}
          </div>
        </div>

        {aside && (
          <div className="flex min-w-0 flex-wrap items-end gap-x-8 gap-y-4 sm:ml-auto">{aside}</div>
        )}
      </div>
    </header>
  );
}
