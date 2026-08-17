"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { type Stamp, iso } from "./when";

/**
 * How long until an instant, counting down.
 *
 * A client component for the same reason `EventDateRange` is one: the server
 * does not know what time it is where the reader is sitting, and it certainly
 * does not know what time it will be when they read it. The first paint is
 * whatever the server worked out, `suppressHydrationWarning` covers the second
 * or two of drift, and from then on it ticks.
 *
 * Coarse on purpose. "In 3 days · 4 hrs" is the number somebody plans around;
 * a seconds counter on a signup deadline three weeks away is a distraction that
 * also re-renders sixty times a minute. Seconds appear only inside the last
 * hour, which is the one time they mean something.
 */

export type CountdownProps = {
  to: Stamp;
  /** Shown once the instant has passed. */
  passed?: string;
  /** Shown when there is no instant at all. */
  fallback?: string;
  className?: string;
};

/** How far apart the parts of "3 days · 4 hrs" are, in milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 days · 4 hrs", "22 min", "in a moment". Null once the instant has gone. */
export function untilText(target: Date, now: Date): string | null {
  const left = target.getTime() - now.getTime();
  if (left <= 0) return null;

  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  const seconds = Math.floor((left % MINUTE) / 1000);

  if (days > 0) return `${days}d · ${hours}h`;
  if (hours > 0) return `${hours}h · ${minutes}m`;
  if (minutes > 0) return `${minutes}m · ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export default function Countdown({
  to,
  passed = "Under way",
  fallback = "No date yet",
  className,
}: CountdownProps) {
  const stamp = iso(to);
  const target = stamp ? new Date(stamp) : null;
  const valid = target && !Number.isNaN(target.getTime()) ? target : null;

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!valid) return;
    // Under an hour the seconds are on screen, so tick with them; above it a
    // minute is as fine as the text gets.
    const left = valid.getTime() - Date.now();
    const every = left > HOUR ? 30_000 : 1000;
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [valid?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = valid ? (untilText(valid, now) ?? passed) : fallback;

  return (
    <span
      suppressHydrationWarning
      className={cx("num", valid ? "text-gold" : "text-muted", className)}
    >
      {text}
    </span>
  );
}
