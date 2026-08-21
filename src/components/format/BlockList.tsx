import type { ReactNode } from "react";
import { EmptyState, Eyebrow, cx } from "@/components/ui";
import type { PlannedBlock } from "@/lib/format-schedule";
import { formatClock } from "@/lib/time";
import { hhmm } from "./labels";

/**
 * The running order — every block, its clock window and each day's total.
 *
 * The old board's preview, generalised from two days to four. It is the same
 * information in the same shape, because that shape has been used live and
 * works: one line per block, the window on the right, the length after it, and
 * the day's total in the header so a day that has quietly grown to seven hours
 * says so before anybody turns up to play it.
 *
 * A block with no start time still shows its offset. That is the case where the
 * admin has not filled a day in yet, and "+2h 30m" is more use than a blank.
 */

export type PreviewBlock = PlannedBlock & {
  startsAt: string | null;
  endsAt: string | null;
};

export type BlockListProps = {
  blocks: PreviewBlock[];
  /** Minutes per day, day 1 first — `dayMinutes(blocks)`. */
  dayMinutes: number[];
  /** Rendered at the right-hand end of a block row. The day override lives here. */
  renderAction?: (block: PreviewBlock) => ReactNode;
  /** Highlights the block a given slot belongs to. */
  highlightSlot?: string | null;
  className?: string;
};

export default function BlockList({
  blocks,
  dayMinutes,
  renderAction,
  highlightSlot,
  className,
}: BlockListProps) {
  if (blocks.length === 0) {
    return (
      <EmptyState>
        Nothing to lay out yet — generate the matches on the Format tab first.
      </EmptyState>
    );
  }

  const days = [...new Set(blocks.map((block) => block.day))].sort((x, y) => x - y);

  return (
    <div className={cx("rounded-xl border border-hair", className)}>
      {days.map((day) => {
        const inDay = blocks.filter((block) => block.day === day);
        const opens = inDay[0]?.startsAt ?? null;
        const closes = inDay[inDay.length - 1]?.endsAt ?? null;

        return (
          <div key={day}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair bg-raised/50 px-3 py-2">
              <Eyebrow as="span">
                Day {day} · {inDay.length === 1 ? "1 block" : `${inDay.length} blocks`}
              </Eyebrow>
              <Eyebrow as="span">
                {opens && closes && (
                  <span className="num mr-3 text-chalk/70">
                    {formatClock(opens)} – {formatClock(closes)}
                  </span>
                )}
                <span className="num text-gold">{hhmm(dayMinutes[day - 1] ?? 0)}</span>
              </Eyebrow>
            </div>

            <ul>
              {inDay.map((block) => (
                <li
                  key={block.index}
                  className={cx(
                    "flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair/50 px-3 py-1.5 text-[11px] last:border-0",
                    highlightSlot &&
                      block.slots.includes(highlightSlot) &&
                      "bg-gold/5 text-gold"
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-chalk/80">{block.label}</span>
                  <span className="num shrink-0 text-muted">
                    {block.startsAt && block.endsAt
                      ? `${formatClock(block.startsAt)} – ${formatClock(block.endsAt)}`
                      : `+${hhmm(block.offsetMin)}`}
                  </span>
                  <span className="num w-14 shrink-0 text-right text-muted">
                    {block.lengthMin}m
                  </span>
                  {renderAction && <span className="shrink-0">{renderAction(block)}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** The one-line version, for a header: "Day 1 4h 30m · Day 2 3h 10m". */
export function dayTotalsText(dayMinutes: number[]): ReactNode {
  return dayMinutes.map((minutes, index) => (
    <span key={index}>
      {index > 0 && " · "}
      Day {index + 1} <span className="num text-gold">{hhmm(minutes)}</span>
    </span>
  ));
}
