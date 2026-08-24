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
  Panel,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
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

/** Gold for a win, chalk for the rest of the podium. */
const PLACE_TONE: Record<number, string> = {
  1: "text-gold",
  2: "text-chalk",
  3: "text-chalk/80",
};

function ordinal(position: number): string {
  const tens = position % 100;
  if (tens >= 11 && tens <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
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

  const profile = await getPlayerProfile(user);
  const { totals } = profile;

  return (
    <div className="min-h-screen">
      <AppHeader section="Player" />

      <main className="mx-auto max-w-[1000px] space-y-6 px-4 py-8 sm:px-6">
        {/* --- Who --------------------------------------------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={profile.displayName} size="lg" />
            <div className="min-w-0">
              <Eyebrow className="mb-1">/players/{profile.handle}</Eyebrow>
              <h1 className="font-display text-4xl leading-none">
                {profile.displayName}
              </h1>
              {totals.won > 0 && (
                <p className="mt-2">
                  <Badge tone="gold">
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
                valueClassName={totals.drafted > 0 ? "text-gold" : "text-muted"}
              />
              <StatTile
                label="Captained"
                value={totals.captained}
                valueClassName={totals.captained > 0 ? "text-chalk" : "text-muted"}
              />
              <StatTile
                label="Podiums"
                value={totals.podiums}
                valueClassName={totals.podiums > 0 ? "text-signal" : "text-muted"}
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
                        {entry.isCaptain && <Badge tone="gold">Captain</Badge>}
                      </div>

                      <h2 className="font-display text-2xl leading-none">
                        <Link
                          href={`/events/${entry.event.slug}`}
                          className="hover:text-gold"
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
                            className="text-sm text-chalk hover:text-gold"
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
                              "font-display text-2xl leading-none",
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

        <p className="pb-4 text-center text-xs leading-relaxed text-muted">
          Everything here is already public on the event pages — a roster, a price paid at
          a draft, a bracket result.
          {totals.spent > 0 &&
            ` Teams have paid ${formatMoney(totals.spent)} for them across ${plural(totals.drafted, "draft")}.`}{" "}
          Nothing anybody wrote on an application form appears on this page.
        </p>
      </main>
    </div>
  );
}
