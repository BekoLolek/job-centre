import { cx, plural } from "@/components/ui";
import type { CapacityState } from "@/lib/events-policy";

/**
 * Seats and queue — the three numbers every event screen shows (§14).
 *
 * Reads a `CapacityState` and nothing else, because every one of those numbers
 * is derived by `capacityState()` and none of them is stored. An uncapped event
 * says so rather than showing a blank where a limit would be, and an event an
 * admin has deliberately over-filled says *that* rather than quietly showing
 * "0 left" as though nothing had happened.
 */

export type EventSeatsProps = {
  seats: CapacityState;
  /** `sm` for a card, `md` for a page header. */
  size?: "sm" | "md";
  className?: string;
};

/** "6/8 seats", or "6 in" when there is no cap. */
export function seatsText(seats: CapacityState): string {
  if (seats.capacity === null) return `${seats.accepted} in · no limit`;
  return `${seats.accepted}/${seats.capacity} seats`;
}

export default function EventSeats({ seats, size = "sm", className }: EventSeatsProps) {
  const tone = seats.overCapacity
    ? "text-ember"
    : seats.full
      ? "text-gold"
      : "text-chalk/80";

  return (
    <span
      className={cx(
        "num inline-flex flex-wrap items-baseline gap-x-2",
        size === "sm" ? "text-xs" : "text-sm",
        className
      )}
    >
      <span className={tone}>{seatsText(seats)}</span>

      {seats.waitlisted > 0 && (
        <span className="text-muted">· {plural(seats.waitlisted, "queued", "queued")}</span>
      )}

      {seats.overCapacity && (
        <span className="text-ember">
          · {seats.accepted - (seats.capacity ?? 0)} over
        </span>
      )}
    </span>
  );
}
