import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow, cx, plural } from "@/components/ui";
import type { EventSummary } from "@/lib/events";
import EventDateRange from "./EventDateRange";
import { ApplicationsPill, EventStatusPill } from "./EventStatusPill";
import { eventTypeLabel } from "./labels";

/**
 * One event as a row in a list, rather than a card in a grid.
 *
 * A list of twelve cards is twelve outlined boxes, and the eye spends its
 * effort on the boxes instead of on the twelve titles. A row gives the title
 * the whole left edge to start from, hangs the facts off the right, and lets
 * one hairline between rows do what twelve outlines were doing.
 *
 * The structure is the Gestalt rule rather than a border: the gap *between*
 * rows is larger than the gaps *inside* one, so the grouping reads without a
 * line being drawn at all. The hairline is there for scanning long lists, at
 * an opacity where it registers as rhythm rather than as an edge.
 */

export type EventRowProps = {
  event: EventSummary;
  href: string;
  /** Counts or extra facts, shown under the title. */
  meta?: ReactNode;
  /** Shown on the right, before the status — an action, usually. */
  trailing?: ReactNode;
  className?: string;
};

export default function EventRow({ event, href, meta, trailing, className }: EventRowProps) {
  const live = event.seats.accepted + event.seats.waitlisted;

  return (
    <div
      className={cx(
        "group flex flex-wrap items-baseline gap-x-6 gap-y-2 py-6 sm:flex-nowrap",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <Link href={href} className="block">
          <h3 className="truncate font-display text-[19px] leading-tight tracking-wide text-chalk transition-colors group-hover:text-hot">
            {event.title}
          </h3>
        </Link>

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-muted">
          <span>{eventTypeLabel(event.type)}</span>
          <span aria-hidden className="text-hair">·</span>
          <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} />
          {live > 0 && (
            <>
              <span aria-hidden className="text-hair">·</span>
              <span className="num">{plural(live, "application")}</span>
            </>
          )}
          {meta}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4">
        {trailing}
        <ApplicationsPill state={event.applicationsState} />
        <EventStatusPill status={event.status} />
      </div>
    </div>
  );
}

/**
 * The list itself. Rows are separated by a hairline rather than wrapped in
 * anything, and `divide-y` means the first and last edges stay open — a list
 * that does not look like a table.
 */
export function EventRows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("divide-y divide-hair/60", className)}>{children}</div>;
}

/** A column heading for a list of rows, sat above the first hairline. */
export function EventRowsHeading({ children }: { children: ReactNode }) {
  return <Eyebrow className="pb-2">{children}</Eyebrow>;
}
