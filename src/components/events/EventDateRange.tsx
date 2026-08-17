"use client";

import { cx } from "@/components/ui";
import { type Stamp, whenText } from "./when";

/**
 * When an event runs, in the reader's own timezone.
 *
 * A client component on purpose. Instants are stored absolute (see
 * `src/lib/time.ts`), so the only honest way to render one is in whatever zone
 * the reader is in — which the server does not know. `suppressHydrationWarning`
 * covers the one frame where the server-rendered string (the deployment's zone,
 * UTC on Vercel) differs from the client's; React replaces the text on
 * hydration and the reader sees their own clock.
 */

export type EventDateRangeProps = {
  startsAt: Stamp;
  endsAt?: Stamp;
  /** What to render when neither end is set. */
  fallback?: string;
  className?: string;
};

export default function EventDateRange({
  startsAt,
  endsAt,
  fallback = "No date yet",
  className,
}: EventDateRangeProps) {
  const from = whenText(startsAt);
  const to = whenText(endsAt);

  // An end with no start is not a range anybody can read, so it stands alone.
  const text = from ? (to ? `${from} → ${to}` : from) : (to ?? null);

  return (
    <span
      suppressHydrationWarning
      className={cx("num text-xs", text ? "text-chalk/80" : "text-muted", className)}
    >
      {text ?? fallback}
    </span>
  );
}
