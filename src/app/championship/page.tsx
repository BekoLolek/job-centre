/**
 * `/championship` — the season that is on (UC-34 1-2).
 *
 * The address the top bar points at, so that the navigation item does not have
 * to know which season is current: this route asks, and every season also keeps
 * its own `/championship/[slug]` for good.
 *
 * A 404 when nothing is published, which is the same answer UC-34 1a gives in
 * the navigation — with no published season there is no item in the bar, so the
 * only way to arrive here is by typing the address, and the honest reply to
 * that is that there is nothing at it. A hidden season does not qualify, for an
 * admin either: this page is the *public* one, and `/admin/championships` is
 * where a draft is worked on.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import { Season } from "@/components/championship";
import { Page } from "@/components/ui";
import { currentSeason, finishedSeasons, seasonPage } from "@/lib/championship-season";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const season = await currentSeason();
  if (!season) return { title: "Championship · Job Centre Events" };
  return {
    title: `${season.name} · Job Centre Events`,
    description: season.description ?? `Standings and results for ${season.name}.`,
  };
}

export default async function CurrentChampionshipPage() {
  const season = await currentSeason();
  if (!season) notFound();

  const [user, page, finished] = await Promise.all([
    getCurrentUser(),
    seasonPage(season),
    finishedSeasons(),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader />
      <Page className="space-y-8">
        <Season
          page={page}
          past={finished.filter((other) => other.slug !== season.slug)}
          viewerId={user?.id ?? null}
        />
      </Page>
    </div>
  );
}
