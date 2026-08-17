"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { type Stamp, whenText } from "./when";

/**
 * When an event runs, in the reader's own timezone.
 *
 * A client component on purpose. Instants are stored absolute (see
 * `src/lib/time.ts`), so the only honest way to render one is in whatever zone
 * the reader is in — which the server does not know. `suppressHydrationWarning`
 * covers the one frame where the server-rendered string (the deployment's zone,
 * UTC on Vercel) differs from the client's.
 *
 * Suppressing the warning is only half of it, though, and the missing half was
 * a real bug. React does not *patch* text it has been told to ignore, and worse,
 * it goes on believing the DOM holds the value the client computed — so a later
 * re-render compares two identical client strings and changes nothing. With the
 * deployment in UTC every date on the site sat at the server's clock forever,
 * silently. Re-keying the node on mount makes React discard the hydrated element
 * and build a new one from the browser's own zone.
 *
 * The first paint is still the server's string rather than a blank, so the
 * layout is right before JavaScript arrives.
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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const from = whenText(startsAt);
  const to = whenText(endsAt);

  // An end with no start is not a range anybody can read, so it stands alone.
  const text = from ? (to ? `${from} → ${to}` : from) : (to ?? null);

  return (
    <span
      // Re-keyed on mount, which is what actually replaces the text. React
      // hydrated this node holding the server's string but believing it holds
      // the client's, so a plain re-render finds nothing to change and the
      // server's zone stays on screen. See the note above.
      key={mounted ? "local" : "ssr"}
      suppressHydrationWarning
      className={cx("num text-xs", text ? "text-chalk/80" : "text-muted", className)}
    >
      {text ?? fallback}
    </span>
  );
}
