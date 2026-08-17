import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Eyebrow, Panel, cx, plural } from "@/components/ui";
import type { EventSummary } from "@/lib/events";
import EventDateRange from "./EventDateRange";
import EventSeats from "./EventSeats";
import EventStatusLine from "./EventStatusLine";
import { ApplicationsPill, EventStatusPill } from "./EventStatusPill";
import { eventTypeLabel } from "./labels";

/**
 * One event, as a card — plan §5's "banner strip, title, type badge, date
 * range, status pill, signup counter".
 *
 * Built against `EventSummary` rather than against any one page's view model,
 * because §5 says the same card carries the hub, the public events list and the
 * admin list, and three near-identical cards is how those three lists slowly
 * stop agreeing about what "full" looks like.
 *
 * The banner is a CSS background rather than an `<img>`: it is decoration
 * behind a title, `banner_url` is admin-entered text that may well 404, and a
 * broken-image icon in the middle of a card is worse than no banner at all.
 *
 * `footer` sits **outside** the link. Buttons nested inside an anchor are a
 * keyboard trap and a browser's guess as to what a click meant.
 */

export type EventCardProps = {
  event: EventSummary;
  /** Wraps the card's body in a link. Omit for a card that is not clickable. */
  href?: string;
  /** Extra badges alongside the type — a game name, an applicant total. */
  meta?: ReactNode;
  /** Action row along the bottom, outside the link. */
  footer?: ReactNode;
  className?: string;
};

export default function EventCard({
  event,
  href,
  meta,
  footer,
  className,
}: EventCardProps) {
  const body = (
    <>
      {event.bannerUrl && (
        <div
          aria-hidden
          className="h-16 w-full border-b border-hair bg-raised bg-cover bg-center"
          style={{ backgroundImage: `url(${JSON.stringify(event.bannerUrl)})` }}
        />
      )}

      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <EventStatusPill status={event.status} />
          <ApplicationsPill state={event.applicationsState} />
          <Badge>{eventTypeLabel(event.type)}</Badge>
          {meta}
        </div>

        <div>
          <h3 className="font-display text-xl leading-tight tracking-wide">{event.title}</h3>
          <Eyebrow className="mt-1">{event.slug}</Eyebrow>
        </div>

        <EventDateRange startsAt={event.startsAt} endsAt={event.endsAt} className="block" />

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <EventSeats seats={event.seats} />
          <span className="num text-xs text-muted">
            {plural(event.seats.accepted + event.seats.waitlisted, "live application")}
          </span>
        </div>

        <EventStatusLine state={event.applicationsState} />
      </div>
    </>
  );

  return (
    <Panel
      as="article"
      padding="none"
      className={cx("overflow-hidden transition-colors", href && "hover:border-gold/40", className)}
    >
      {href ? (
        <Link href={href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}

      {footer && (
        <div className="flex flex-wrap gap-2 border-t border-hair px-5 py-3">{footer}</div>
      )}
    </Panel>
  );
}
