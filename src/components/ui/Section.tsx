import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";
import { cx } from "./cx";

/**
 * A region of a page, and the thing that separates one region from the next.
 *
 * The previous version stacked three separators on top of each other — a rule,
 * a 210px heading gutter, and a blue icon — on the theory that with the boxes
 * gone the eye needed help. Measuring the sites that do this well says the
 * opposite: separation is **space**, with everything else a whisper. Linear
 * runs 128px between sections and no rule at all; Vercel's headings are 24px
 * semibold sentence case with nothing drawn around them.
 *
 * So this is space first: 56px of padding either side of a hairline, which puts
 * 112px between one region's content and the next. The heading sits above its
 * content in the normal reading order rather than off in a column, because a
 * gutter is a documentation layout and this is an app. The icon stays — it is
 * the handle the eye finds when scrolling a long page — but at the type's own
 * colour, not the accent's. Blue means *interactive* now, and spending it on
 * decoration is what made the accent stop meaning anything.
 */

export type SectionProps = {
  title?: ReactNode;
  /** One line under the title. Keep it to a sentence. */
  description?: ReactNode;
  icon?: IconName;
  /** Sits opposite the title — a count, a filter, a small action. */
  aside?: ReactNode;
  /** `band` lifts the region onto a surface; `plain` drops the rule. */
  tone?: "default" | "band" | "plain";
  /** Drops the rule and the top padding, for the first section on a page. */
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
  const heading = Boolean(title || icon || aside);

  return (
    <section
      className={cx(
        "relative",
        !first && tone !== "plain" && "border-t border-hair",
        first ? "pt-0" : "pt-14",
        "pb-14",
        tone === "band" && "px-6 -mx-6 rounded bg-panel",
        className
      )}
    >
      {heading && (
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              {icon && <Icon name={icon} className="relative top-[3px] text-muted" />}
              {title && <h2 className="text-[20px] text-chalk">{title}</h2>}
            </div>
            {description && (
              <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-muted">
                {description}
              </p>
            )}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
      )}

      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * The column a page's sections live in. Sections carry their own rhythm, so
 * this only sets the measure.
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
