"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { formatClock, formatWhen, parseStamp } from "@/lib/time";

/**
 * An instant, in the reader's own timezone.
 *
 * A client component for the same reason `EventDateRange` is one: schedule
 * values are stored absolute, so 18:00 in Budapest is 17:00 in London, and the
 * server has no idea which of those the reader wants.
 *
 * The rule this exists to enforce: **never format an instant in a server
 * component.** If a board needs a time on the page, it renders one of these.
 *
 * ## Two things are needed to make that actually true, not just intended
 *
 * `suppressHydrationWarning` stops React complaining that the server's string
 * (the deployment's zone — UTC on Vercel) is not the browser's. On its own that
 * is *worse* than the warning, because React then leaves the server's text in
 * the DOM while believing it holds the client's: a later re-render compares the
 * two client values, finds them identical, and changes nothing. The page ends
 * up saying "times in Europe/Budapest" over a column of UTC, silently.
 *
 * So the node is also **re-keyed on mount**, which makes React throw the
 * hydrated element away and build a new one from the browser's clock. That is
 * the render the reader actually sees.
 *
 * The first paint is still the server's string rather than a blank, so the page
 * has its shape before JavaScript arrives and a reader with none still gets a
 * time, correct to within the deployment's offset.
 */

export type LocalTimeFormat = "when" | "clock" | "day";

export type LocalTimeProps = {
  at: string | null | undefined;
  /** `when` is "Sat 12 Sep · 18:00", `clock` is "18:00", `day` is "Sat 12 Sep". */
  format?: LocalTimeFormat;
  /** What to render when there is no instant at all. */
  fallback?: string;
  className?: string;
};

function dayText(value: string): string | null {
  const at = parseStamp(value);
  if (!at) return null;
  return at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export default function LocalTime({
  at,
  format = "when",
  fallback = "—",
  className,
}: LocalTimeProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const text = at
    ? format === "clock"
      ? formatClock(at)
      : format === "day"
        ? dayText(at)
        : formatWhen(at)
    : null;

  return (
    <span
      // The key is what makes this work, and a plain re-render does not.
      // React hydrated this node holding the *server's* string but believing it
      // holds the client's, so a second render finds nothing to change and the
      // DOM keeps the wrong time forever. Changing the key on mount throws the
      // node away and builds a fresh one from the browser's clock.
      key={mounted ? "local" : "ssr"}
      suppressHydrationWarning
      className={cx("num", text ? undefined : "text-muted", className)}
    >
      {text ?? fallback}
    </span>
  );
}
