/**
 * `/championship/[slug]` — one season, in public (UC-34, UC-35 3-4).
 *
 * Every season that has ever been published lives here, running or finished,
 * and keeps this address for good: `championships.slug` is written once at
 * creation and never changes, so a link posted in Discord in March still works
 * in November and still works after the season closes.
 *
 * ## A hidden season is a 404, not a 403
 *
 * R-189 in public: a season nobody has published must not be visible to a
 * visitor — not its name, not its slug, not by guessing this URL.
 * `publicSeason` answers the question with the status in the `where` rather
 * than filtering afterwards, and the null it returns becomes `notFound()`. A
 * 403 would be worse than useless here, because "you may not see this" is
 * itself the confirmation that there is something to see. Admins get the page,
 * with a banner saying what it is.
 *
 * No session is required for anything else on it. A season's standings are the
 * same public record its events already are.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import { Season } from "@/components/championship";
import { Page } from "@/components/ui";
import {
  finishedSeasons,
  publicSeason,
  seasonPage,
} from "@/lib/championship-season";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Never an admin here: page metadata is cached and shared, so it answers as
  // a visitor would be answered and a hidden season stays nameless.
  const season = await publicSeason(slug, { isAdmin: false });
  if (!season) return { title: "Championship · Job Centre Events" };
  return {
    title: `${season.name} · Job Centre Events`,
    description:
      season.description ?? `Standings and results for ${season.name}.`,
  };
}

export default async function ChampionshipPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  const season = await publicSeason(slug, { isAdmin: user?.isAdmin ?? false });
  if (!season) notFound();

  const [page, finished] = await Promise.all([seasonPage(season), finishedSeasons()]);

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
