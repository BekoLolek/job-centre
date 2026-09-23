/**
 * `/players/[handle]` — a public player profile (docs/platform-plan.md §4).
 *
 * "Events played, teams they were on, what they were bought for, and anything
 * they won." No session required: every fact on this page is already in §11's
 * public row and already on the event pages — this is the same record indexed
 * by person, which is the view somebody actually wants when a name comes up.
 *
 * ## What is not on it
 *
 * Application answers. A question set is designed for an admin to read while
 * deciding who gets in, and a member answering "anything else we should know"
 * has no reason to expect it published. `getPlayerProfile` never reads
 * `applications.answers`, and neither does this page. Nor are declined or
 * withdrawn applications listed, nor anything about an unpublished event — the
 * profile cannot leak that somebody was turned down or that a draft event
 * exists.
 *
 * Prices *are* on it, and that is not a slip: `team_members.price` is written
 * once when a lot is awarded and has been on the public Teams tab since Phase
 * 4. §11's whole argument for publishing them is that a draft whose prices
 * vanish is a draft nobody can argue about afterwards.
 *
 * **No instant is formatted here.** The dates go through `EventDateRange`,
 * which re-keys on mount in the reader's own zone.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import { EventDateRange, EventStatusPill, eventTypeLabel } from "@/components/events";
import { Money, formatMoney } from "@/components/draft";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Page,
  Panel,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { seasonMonths } from "@/lib/championship-policy";
import { type PlayerSeason, playerSeasons } from "@/lib/championship-season";
import { ordinal } from "@/lib/format-policy";
import { getPlayerByHandle, getPlayerProfile } from "@/lib/players";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const user = await getPlayerByHandle(handle);
  if (!user) return { title: "Player · Job Centre Events" };
  const name = user.displayName ?? user.name ?? "Player";
  return {
    title: `${name} · Job Centre Events`,
    description: `Events, teams and results for ${name}.`,
  };
}

/** Union blue for a win, chalk for the rest of the podium. */
const PLACE_TONE: Record<number, string> = {
  1: "text-union",
  2: "text-chalk",
  3: "text-chalk/80",
};

/**
 * "Finished" for a season that is over, "so far" for one still being played
 * (R-198, UC-36 5).
 *
 * The difference is the whole point of the section: a closed season's position
 * is a result and a running season's is a scoreboard, and printing them
 * identically would claim a third place in a championship with four nights
 * left. `PlayerSeason.finished` is the season's status, not a date, because
 * closing is what freezes the standings.
 */
function seasonPlaceLabel(season: PlayerSeason): string {
  return season.finished ? "Finished" : "So far";
}

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  const user = await getPlayerByHandle(handle);
  // A handle nobody holds is a 404. A member with nothing to show is not — they
  // exist, and an empty profile is the honest page for somebody who has just
  // joined.
  if (!user) notFound();

  /*
   * The seasons are read alongside the profile rather than inside it, and that
   * is not a preference: `getPlayerProfile` lives in `players.ts`, and the
   * season history is scored by `championship-results.ts`, which reads its
   * names out of `players.ts`. One module asking the other back would be an
   * import cycle — so the page, which is downstream of both, asks them both.
   */
  const [profile, seasons] = await Promise.all([
    getPlayerProfile(user),
    playerSeasons(user.id),
  ]);
  const { totals } = profile;

  return (
    <div className="min-h-screen">
      <AppHeader />

      <Page className="space-y-6">
        {/* --- Who --------------------------------------------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={profile.displayName} src={profile.avatarUrl} size="lg" />
            <div className="min-w-0">
              <Eyebrow className="mb-1">/players/{profile.handle}</Eyebrow>
              <h1 className="font-display text-36 leading-none">
                {profile.displayName}
              </h1>
              {totals.won > 0 && (
                <p className="mt-2">
                  <Badge tone="union">
                    {totals.won === 1 ? "Winner" : `${totals.won}× winner`}
                  </Badge>
                </p>
              )}
            </div>

            <div className="ml-auto flex flex-wrap gap-8">
              <StatTile label="Events" value={totals.events} />
              <StatTile
                label="Drafted"
                value={totals.drafted}
                valueClassName={totals.drafted > 0 ? "text-union" : "text-muted"}
              />
              <StatTile
                label="Captained"
                value={totals.captained}
                valueClassName={totals.captained > 0 ? "text-chalk" : "text-muted"}
              />
              <StatTile
                label="Podiums"
                value={totals.podiums}
                valueClassName={totals.podiums > 0 ? "text-body" : "text-muted"}
              />
            </div>
          </div>

          {totals.drafted > 0 && (
            <div className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hair pt-4">
              <span className="flex items-baseline gap-2">
                <Eyebrow as="span">Total paid for them</Eyebrow>
                <Money value={totals.spent} />
              </span>
              <span className="flex items-baseline gap-2">
                <Eyebrow as="span">Top price</Eyebrow>
                <Money value={totals.top} />
              </span>
            </div>
          )}
        </Panel>

        {/* --- Seasons ------------------------------------------------ */}
        {seasons.length > 0 && (
          <section className="space-y-3">
            <Eyebrow>{plural(seasons.length, "championship")}</Eyebrow>
            <Panel as="article">
              <ul className="space-y-3">
                {seasons.map((season) => {
                  const months = seasonMonths(season.runsFrom, season.runsTo);
                  return (
                    <li
                      key={season.slug}
                      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hair/60 pb-3 last:border-0 last:pb-0"
                    >
                      <Link
                        href={`/championship/${season.slug}`}
                        className="text-14 text-chalk underline-offset-4 hover:text-union hover:underline"
                      >
                        {season.name}
                      </Link>
                      {months && <span className="text-12 text-muted">{months}</span>}
                      <span className="text-12 text-muted">
                        {season.counted === season.played
                          ? plural(season.played, "event")
                          : `${season.counted} of ${plural(season.played, "event")} counting`}
                      </span>
                      <span className="ml-auto flex items-baseline gap-3">
                        <span className="text-12 text-muted">{seasonPlaceLabel(season)}</span>
                        <span
                          className={cx(
                            "font-display text-24 leading-none",
                            PLACE_TONE[season.position] ?? "text-muted"
                          )}
                        >
                          {season.level
                            ? `=${ordinal(season.position)}`
                            : ordinal(season.position)}
                        </span>
                        <span className="text-12 text-muted">
                          <span className="num text-13 text-body">{season.points}</span> points
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-4 text-12 leading-relaxed text-muted">
                Worked out from the recorded results every time this page is opened, so a
                correction to an old night shows up here too.
              </p>
            </Panel>
          </section>
        )}

        {/* --- Every event -------------------------------------------- */}
        <section className="space-y-3">
          <Eyebrow>{plural(profile.entries.length, "event")}</Eyebrow>

          {profile.entries.length === 0 ? (
            <Panel as="article">
              <EmptyState>
                Nothing yet. This page fills up the moment they are accepted to an event.
              </EmptyState>
              <div className="mt-4">
                <Button href="/events" size="sm">
                  What&apos;s on
                </Button>
              </div>
            </Panel>
          ) : (
            <ul className="space-y-2">
              {profile.entries.map((entry) => (
                <li key={entry.event.id}>
                  <Panel padding="sm" className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <EventStatusPill status={entry.event.status} />
                        <Badge>{eventTypeLabel(entry.event.type)}</Badge>
                        {entry.isCaptain && <Badge tone="union">Captain</Badge>}
                      </div>

                      <h2 className="font-display text-24 leading-none">
                        <Link
                          href={`/events/${entry.event.slug}`}
                          className="hover:text-union"
                        >
                          {entry.event.title}
                        </Link>
                      </h2>

                      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <EventDateRange
                          startsAt={entry.event.startsAt}
                          endsAt={entry.event.endsAt}
                        />
                        {entry.team && (
                          <Link
                            href={`/events/${entry.event.slug}?tab=teams`}
                            className="text-14 text-chalk hover:text-union"
                          >
                            {entry.team.name}
                          </Link>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-baseline gap-8">
                      {entry.placement && (
                        <div className="text-right">
                          <Eyebrow>Finished</Eyebrow>
                          <div
                            className={cx(
                              "font-display text-24 leading-none",
                              PLACE_TONE[entry.placement.position] ?? "text-muted"
                            )}
                          >
                            {entry.placement.shared > 1
                              ? `=${ordinal(entry.placement.position)}`
                              : ordinal(entry.placement.position)}
                          </div>
                        </div>
                      )}

                      {entry.price !== null && (
                        <div className="text-right">
                          <Eyebrow>Bought for</Eyebrow>
                          <Money
                            value={entry.price}
                            size="lg"
                            className="block leading-none"
                          />
                        </div>
                      )}
                    </div>
                  </Panel>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="pb-4 text-center text-12 leading-relaxed text-muted">
          Everything here is already public on the event pages — a roster, a price paid at
          a draft, a bracket result.
          {totals.spent > 0 &&
            ` Teams have paid ${formatMoney(totals.spent)} for them across ${plural(totals.drafted, "draft")}.`}{" "}
          Nothing anybody wrote on an application form appears on this page.
        </p>
      </Page>
    </div>
  );
}
