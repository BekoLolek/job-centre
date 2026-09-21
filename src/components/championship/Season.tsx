import { Alert, Eyebrow, Section, SectionList, StatTile, StatusPill, plural } from "@/components/ui";
import { seasonMonths } from "@/lib/championship-policy";
import type { FinishedSeason, SeasonPage } from "@/lib/championship-season";
import PastSeasons from "./PastSeasons";
import Podium from "./Podium";
import ScoringRules from "./ScoringRules";
import SeasonEvents from "./SeasonEvents";
import StandingsTable from "./StandingsTable";

/**
 * A season, in public — everything `/championship` and `/championship/[slug]`
 * draw (UC-34, UC-35 3-4).
 *
 * The two routes differ only in how they find the season, so the page itself
 * lives here: both render `<Page>` and hand it this. Nothing below reads the
 * database or decides who may see a season — `publicSeason` has already settled
 * that, and a second opinion here would be a second place for R-189 to be got
 * wrong.
 *
 * The order is the order the questions get asked: who is winning, what the
 * whole table looks like, which nights got us here and which are left, and
 * finally how the arithmetic works. Past seasons come last because they are the
 * way out of this page rather than part of it.
 */

/** A season's status in the pill vocabulary the rest of the site already uses. */
const PILL = {
  hidden: { tone: "draft", label: "Hidden" },
  published: { tone: "open", label: "Running" },
  closed: { tone: "complete", label: "Finished" },
} as const;

export default function Season({
  page,
  past,
  viewerId,
}: {
  page: SeasonPage;
  /** Finished seasons other than this one. */
  past: FinishedSeason[];
  /** The signed-in reader, so their own row can be marked (UC-34 2b). */
  viewerId: string | null;
}) {
  const { season, standings, counted, toCome, movedAt } = page;
  const months = seasonMonths(season.runsFrom, season.runsTo);
  const pill = PILL[season.status];
  const started = counted.length > 0;

  return (
    <>
      {season.status === "hidden" && (
        <Alert tone="union">
          <span className="block font-medium">This season is hidden</span>
          <span className="mt-1 block opacity-90">
            Nobody but an admin can reach this page, and it is not in the top bar. Publish it
            when the points table is settled.
          </span>
        </Alert>
      )}

      <header className="flex flex-wrap items-end gap-x-10 gap-y-6">
        <div className="min-w-0">
          <Eyebrow className="mb-2">Championship{months ? ` · ${months}` : ""}</Eyebrow>
          <h1 className="font-display text-36 leading-none sm:text-48">{season.name}</h1>
          <div className="mt-4">
            <StatusPill status={pill.tone} label={pill.label} />
          </div>
          {season.description && (
            <p className="mt-4 max-w-[62ch] whitespace-pre-line text-14 leading-relaxed text-body">
              {season.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-4 sm:ml-auto">
          <StatTile label="Events counted" value={counted.length} />
          <StatTile
            label="Still to come"
            value={toCome.length}
            valueClassName={toCome.length > 0 ? undefined : "text-muted"}
          />
          <StatTile
            label="Players scoring"
            value={standings.length}
            valueClassName={standings.length > 0 ? undefined : "text-muted"}
          />
        </div>
      </header>

      <SectionList>
        <Section
          // Not `first`: the rule above the standings would draw a line under
          // the season's own header, but the space that `first` also drops is
          // exactly what sets this region apart from it.
          tone="plain"
          title="Standings"
          description={
            started
              ? "Every point on this page comes from a recorded finishing order. Open a player to see where theirs came from."
              : undefined
          }
          aside={
            started ? (
              <span className="text-12 text-muted">{plural(standings.length, "player")}</span>
            ) : undefined
          }
        >
          {started ? (
            <div className="space-y-8">
              <Podium players={standings.slice(0, 3)} countBest={season.countBest} />

              <div>
                {/*
                  `StandingsEvent` is a strict subset of `CountedEvent`, so the
                  table takes them as they are. Copying the six fields across by
                  hand only meant that adding a seventh to the narrow type left
                  the table reading `undefined` from a row that had the value.
                */}
                <StandingsTable
                  rows={standings}
                  events={counted}
                  viewerId={viewerId}
                  showMovement={movedAt !== null}
                  countBest={season.countBest}
                />

                <p className="mt-4 max-w-[62ch] text-12 leading-relaxed text-muted">
                  Two players level on points are separated by most firsts, then most seconds,
                  and so on. Anyone still level after that shares a position, marked{" "}
                  <span className="num text-body">=</span>.
                  {movedAt && (
                    <>
                      {" "}
                      The <span className="text-body">Moved</span> column is how far{" "}
                      <span className="text-body">{movedAt.title}</span> shifted each player.
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <NotStarted toCome={toCome.length} />
          )}
        </Section>

        <Section
          title="The season's events"
          description="Every event that counts towards this season, whatever the game it was played on."
        >
          <SeasonEvents counted={counted} toCome={toCome} />
        </Section>

        <Section
          title="How the scoring works"
          // Not "one table for the whole season": an event may carry its own
          // (R-177), and `resultsForEvent` uses it in preference to this one.
          // Saying otherwise left a reader checking a marked night's points
          // against the only table on the page and finding they did not add up.
          description="The season's own table, below. A night with its own table, or worth more than the others, is marked in the events list above."
        >
          <ScoringRules
            pointsTable={season.pointsTable}
            participationPoints={season.participationPoints}
            countBest={season.countBest}
          />
        </Section>

        <Section title="Past seasons" description="Finished seasons keep their page for good.">
          {/*
            `past` has this season taken out of it (both routes filter it), so
            an empty list means two different things depending on which season
            you are reading — and on a closed one's own page "no season has
            finished yet" is contradicted by the page it is printed on.
          */}
          <PastSeasons seasons={past} thisOneFinished={season.status === "closed"} />
        </Section>
      </SectionList>
    </>
  );
}

/** UC-34 2e: published, but nothing has been scored into it yet. */
function NotStarted({ toCome }: { toCome: number }) {
  return (
    <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
      The season has not started. No finishing order has been recorded yet, so there is
      nothing in the table.{" "}
      {toCome > 0
        ? `There ${toCome === 1 ? "is" : "are"} already ${plural(toCome, "event")} lined up below, and the standings start the moment the first one is scored.`
        : "Events are added to a season as they are scheduled."}
    </p>
  );
}
