"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import AvailabilityGrid from "./AvailabilityGrid";
import type { PersonAvailability } from "@/lib/availability-resolve";

/**
 * The bit of the availability page that has to be a client component: paging
 * to another week.
 *
 * The week is a query parameter rather than React state, because the answer to
 * "what evening can we run this" is a thing you send to somebody, and a link
 * that opens on a different week than the one you were looking at is not an
 * answer. `router.push` re-runs the server read for the new week, so the
 * exceptions come with it — they are per date, and the previous week's read
 * does not contain them.
 */

export default function AvailabilityWeek({
  people,
  weekOf,
}: {
  people: PersonAvailability[];
  weekOf: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();

  return (
    <div className={busy ? "opacity-60 transition-opacity" : undefined}>
      <AvailabilityGrid
        people={people}
        weekOf={weekOf}
        onWeek={(monday) => start(() => router.push(`/admin/availability?week=${monday}`))}
      />
    </div>
  );
}
