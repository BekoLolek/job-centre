import { StatusPill } from "@/components/ui";
import type { EventStatus } from "@/db/schema";
import type { ApplicationsState } from "@/lib/events-policy";
import { applicationsPill, eventStatusLabel, eventStatusTone } from "./labels";

/**
 * The event's lifecycle status as a pill — Draft, Published, Live, Complete,
 * Cancelled. Fixed colour per status, so a list of twenty events is readable
 * without reading any of the words (plan §5).
 */
export function EventStatusPill({
  status,
  className,
}: {
  status: EventStatus;
  className?: string;
}) {
  return (
    <StatusPill
      status={eventStatusTone(status)}
      label={eventStatusLabel(status)}
      className={className}
    />
  );
}

/**
 * Whether applications are open — a *different* question from the status, and
 * one that changes with the clock rather than with anything an admin clicked.
 * A published event whose signup window has passed shows Published and
 * Applications closed at the same time, which is exactly right.
 */
export function ApplicationsPill({
  state,
  className,
}: {
  state: ApplicationsState;
  className?: string;
}) {
  const pill = applicationsPill(state);
  return <StatusPill status={pill.tone} label={pill.label} className={className} />;
}

export default EventStatusPill;
