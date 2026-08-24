import type { ReactNode } from "react";
import { EmptyState, Eyebrow, cx } from "@/components/ui";
import type { ResolvedMatch } from "@/lib/format-resolve";
import MatchCard from "./MatchCard";
import { type BracketSection, bracketSections, widestColumn } from "./columns";

/**
 * The bracket canvas §5 asks for: one column per round, scrolling sideways,
 * collapsing to a plain vertical list on a phone.
 *
 * The layout the old board uses — three stacked blocks of `lg:grid-cols-3` with
 * six slot ids typed into them — is right for exactly four teams. Eight teams in
 * a double elimination is three upper rounds, four lower rounds and a grand
 * final: eight columns, and a grid of three would wrap them into nonsense. So
 * the columns come from `bracketSections` and the row scrolls.
 *
 * ## What each breakpoint does
 *
 * Under `md` there is no bracket at all, because a bracket needs width and a
 * phone has none: sections stack, columns stack inside them, and the whole
 * thing is one list in play order. From `md` up the columns lay out in a row
 * that scrolls horizontally inside its own container — the page itself never
 * scrolls sideways — and each column centres its matches vertically, which is
 * what makes a round of one sit level with the round of two that feeds it.
 *
 * Connector lines are hairlines on the left edge of every column after the
 * first. Real elbow joins would need measured positions and a resize observer;
 * a rule per column says the same thing — these come from those — at none of
 * the cost.
 */

export type BracketCanvasProps = {
  matches: ResolvedMatch[];
  /** Ringed in gold. The stage's champion slot, normally. */
  featuredSlot?: string | null;
  /** Rendered under each card — the admin's editor, on the admin's screen. */
  renderExtra?: (match: ResolvedMatch) => ReactNode;
  /** Hides the per-game breakdown, for a dense read-only board. */
  compact?: boolean;
  className?: string;
};

export default function BracketCanvas({
  matches,
  featuredSlot,
  renderExtra,
  compact,
  className,
}: BracketCanvasProps) {
  const sections = bracketSections(matches);

  if (sections.length === 0) {
    return (
      <EmptyState>
        No matches yet. Generate the bracket on the Format tab and it appears here.
      </EmptyState>
    );
  }

  const widest = widestColumn(sections);

  return (
    <div className={cx("space-y-8", className)}>
      {sections.map((section) => (
        <Section
          key={section.key}
          section={section}
          widest={widest}
          featuredSlot={featuredSlot}
          renderExtra={renderExtra}
          compact={compact}
        />
      ))}
    </div>
  );
}

function Section({
  section,
  widest,
  featuredSlot,
  renderExtra,
  compact,
}: {
  section: BracketSection;
  widest: number;
  featuredSlot?: string | null;
  renderExtra?: (match: ResolvedMatch) => ReactNode;
  compact?: boolean;
}) {
  // One column named all but identically to its section ("Bronze" / "Bronze
  // match") should not print the name twice.
  const showColumnLabels =
    section.columns.length > 1 || !section.columns[0]?.label.startsWith(section.label);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <Eyebrow as="h3">{section.label}</Eyebrow>
        <span className="eyebrow text-dim">
          {section.columns.length === 1
            ? "1 round"
            : `${section.columns.length} rounds`}
        </span>
      </div>

      {/*
        The scroller. `overflow-x-auto` is on this element and not on the page,
        so a wide bracket never drags the rest of the layout sideways with it.

        The explicit `overflow-y-hidden` is not redundant: CSS promotes the
        other axis to `auto` whenever one is not `visible`, so a box that
        scrolls sideways grows a vertical scrollbar for exactly the height of
        its own horizontal one. The `pb-3` is what that clips.
      */}
      <div className="-mx-1 flex flex-col gap-5 md:mx-0 md:flex-row md:items-stretch md:gap-0 md:overflow-x-auto md:overflow-y-hidden md:pb-3">
        {section.columns.map((column, index) => (
          <div
            key={column.key}
            className={cx(
              "min-w-0 md:w-[17rem] md:shrink-0 md:px-3",
              index > 0 && "md:border-l md:border-hair/60"
            )}
          >
            {showColumnLabels && (
              <Eyebrow className="mb-2 truncate text-dim">{column.label}</Eyebrow>
            )}

            <ul
              className={cx(
                "space-y-4 md:flex md:h-full md:flex-col md:space-y-0 md:gap-4",
                // A short column beside a tall one reads as a bracket only when
                // it sits in the middle of what feeds it.
                column.matches.length < widest && "md:justify-center"
              )}
            >
              {column.matches.map((match) => (
                <li key={match.slot}>
                  <MatchCard
                    match={match}
                    compact={compact}
                    featured={featuredSlot === match.slot}
                  >
                    {renderExtra?.(match)}
                  </MatchCard>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
