import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";
import { cx } from "./cx";

/**
 * A region of a page, and the thing that separates one region from the next.
 *
 * Three passes got here. Boxes read as a command centre; removing them entirely
 * left pages as one undifferentiated column. What separates regions now is
 * three quiet signals at once, none of which is an outline:
 *
 *  1. **A rule.** One hairline spanning the full content width, above the
 *     heading. A line across the page is a paragraph break; a line around
 *     something is a box.
 *  2. **A gutter.** From `md` up the heading sits in its own left column and
 *     the content sits to the right, so a new section announces itself by
 *     starting a new column rather than by being wrapped in anything.
 *  3. **An icon.** With no edges to catch, the icon is the handle the eye finds
 *     when scrolling. It sits in the gutter at the type's own weight.
 *
 * `tone="band"` adds a faint full-width wash for the few sections that should
 * feel set apart — a summary at the top of a page, something live. It is a
 * change of ground, not a card: no border, and it bleeds past the text.
 */

export type SectionProps = {
  title?: ReactNode;
  /** One line under the title, in the gutter. Keep it to a sentence. */
  description?: ReactNode;
  icon?: IconName;
  /** Sits with the title — a count, a status, a small action. */
  aside?: ReactNode;
  /** `band` washes the section's ground; `plain` drops the rule as well. */
  tone?: "default" | "band" | "plain";
  /** Drops the rule above, for the first section on a page. */
  first?: boolean;
  className?: string;
  children?: ReactNode;
};

export default function Section({
  title,
  description,
  icon,
  aside,
  tone = "default",
  first = false,
  className,
  children,
}: SectionProps) {
  const heading = Boolean(title || description || icon);

  return (
    <section
      className={cx(
        "relative",
        !first && tone !== "plain" && "border-t border-hair/70",
        tone === "band" && "bg-white/[0.015]",
        first ? "pt-2" : "pt-10",
        "pb-10",
        className
      )}
    >
      {tone === "band" && (
        // Bleeds the wash past the content column so it reads as ground rather
        // than as a panel that happens to be wide.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 bg-white/[0.015]"
        />
      )}

      <div className={cx(heading && "md:grid md:grid-cols-[210px_minmax(0,1fr)] md:gap-10")}>
        {heading && (
          <div className="mb-5 md:mb-0">
            <div className="flex items-baseline gap-2.5">
              {icon && <Icon name={icon} className="relative top-[3px] text-union" />}
              <h2 className="font-display text-[15px] uppercase leading-tight tracking-[0.12em] text-chalk">
                {title}
              </h2>
            </div>
            {description && (
              <p className="mt-2 text-[13px] leading-relaxed text-muted md:pr-4">
                {description}
              </p>
            )}
            {aside && <div className="mt-3">{aside}</div>}
          </div>
        )}

        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/**
 * The column a page's sections live in. Sections handle their own vertical
 * rhythm, so this only sets the measure.
 */
export function SectionList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("flex flex-col", className)}>{children}</div>;
}
