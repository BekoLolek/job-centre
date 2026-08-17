import type { ReactNode } from "react";
import { Avatar, cx } from "@/components/ui";

/**
 * One person, on a line: initials, name, whatever the screen wants to say about
 * them, and whatever it wants done to them.
 *
 * Used for a pool entry, a roster row and a lot's player, which are three
 * different screens showing the same thing — a name with a fact attached. The
 * fact goes in `meta` and the buttons go in `actions`, so a list of these reads
 * as a column however different the two ends are.
 */

export type PlayerChipProps = {
  name: string;
  /** Small mono line under the name — a rank, a price, a reason. */
  meta?: ReactNode;
  /** To the right of the name, before the actions — badges, a figure. */
  trailing?: ReactNode;
  /** Buttons, pinned right. */
  actions?: ReactNode;
  /** A leading position marker — the wheel order, the pick number. */
  index?: number;
  /** Dims the row without hiding it: excluded, already gone, being saved. */
  dimmed?: boolean;
  className?: string;
};

export default function PlayerChip({
  name,
  meta,
  trailing,
  actions,
  index,
  dimmed,
  className,
}: PlayerChipProps) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 py-1.5",
        dimmed && "opacity-55",
        className
      )}
    >
      {index !== undefined && (
        <span className="num w-6 shrink-0 text-right text-[10px] text-muted">{index}</span>
      )}

      <Avatar name={name} size="sm" />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight">{name}</span>
        {meta && <span className="eyebrow block truncate">{meta}</span>}
      </span>

      {trailing && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}
