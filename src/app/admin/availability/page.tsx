/**
 * `/admin/availability` — when the community is free.
 *
 * The question this answers is the one that used to be forty messages in a
 * Discord thread: *what evening can we actually run this?* Every member fills
 * in a weekly pattern once, on their profile, and it stacks up here.
 *
 * The page is thin on purpose. It reads the week and hands the rows to the
 * grid, which does the counting in the browser — see the note in
 * `AvailabilityGrid.tsx` for why the arithmetic cannot happen on the server
 * without picking somebody else's clock to draw it in.
 */

import AppHeader from "@/components/AppHeader";
import AvailabilityWeek from "@/components/admin/AvailabilityWeek";
import { Eyebrow, Section } from "@/components/ui";
import { availabilityWeek } from "@/lib/availability";
import { requireAdmin } from "@/lib/session-guards";
import { formatDate, parseDate, todayIn, weekStart } from "@/lib/zoned-time";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Availability · Admin",
};

export default async function AdminAvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string | string[] }>;
}) {
  await requireAdmin();

  const raw = await searchParams;
  const asked = Array.isArray(raw.week) ? raw.week[0] : raw.week;

  /*
   * The week in the URL, so a link to "that Tuesday we found" is a link. The
   * fallback is this week in UTC rather than in the reader's zone, because the
   * server has no reader — the grid corrects it on mount if the two disagree,
   * which they only can for a few hours either side of midnight.
   */
  const monday = weekStart(parseDate(asked ?? "") ?? todayIn("UTC"));
  const people = await availabilityWeek(monday);

  return (
    <div className="min-h-screen">
      <AppHeader section="Admin" />

      <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6">
        <header className="mb-2">
          <Eyebrow className="mb-2">Admin · Availability</Eyebrow>
          <h1 className="text-4xl">When everyone is free</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            The weekly pattern every member set on their profile, stacked up. Darker means more
            people. Point at a slot to see exactly who — and remember a maybe counts for half,
            so a dark cell full of maybes is not the same as a dark cell full of yeses.
          </p>
        </header>

        <Section
          first
          icon="calendar"
          title="This week"
          description="Both ends of the day are adjustable — an evening community wants 14:00 to 01:00, not 09:00 to 17:00."
        >
          <AvailabilityWeek people={people} weekOf={formatDate(monday)} />
        </Section>
      </main>
    </div>
  );
}
