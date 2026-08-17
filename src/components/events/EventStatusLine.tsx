import { cx } from "@/components/ui";
import type { ApplicationsState } from "@/lib/events-policy";
import EventDateRange from "./EventDateRange";

/**
 * The sentence under an event heading: can anyone apply right now, and if not,
 * why not — with the deadline that decides it.
 *
 * Every word comes from `applicationsOpen()`. The point of §14's rule that
 * there is no `applications_open` column is that this line is computed at read
 * time; writing a second copy of the reasoning here would be the same mistake
 * one layer up.
 */

export type EventStatusLineProps = {
  state: ApplicationsState;
  className?: string;
};

export default function EventStatusLine({ state, className }: EventStatusLineProps) {
  const tone = state.open
    ? state.willWaitlist
      ? "text-gold"
      : "text-signal"
    : "text-muted";

  const deadline = state.open
    ? state.closesAt
    : state.reason === "too_early"
      ? state.opensAt
      : null;

  const deadlineWord = state.open ? "Closes" : "Opens";

  return (
    <p className={cx("flex flex-wrap items-baseline gap-x-2 text-xs", className)}>
      <span className={tone}>{state.message}</span>
      {deadline && (
        <span className="text-muted">
          {deadlineWord} <EventDateRange startsAt={deadline} />
        </span>
      )}
    </p>
  );
}
