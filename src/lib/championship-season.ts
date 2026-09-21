/**
 * The season as the public reads it — `/championship` and `/championship/[slug]`
 * (UC-34, UC-35 3-4).
 *
 * Every other championship module is an admin's or a host's: `./championships`
 * owns the season and which events count towards it, `./championship-results`
 * owns one event's finishing order, and `./championship-policy` owns the
 * arithmetic. This one owns a single question none of them answers — *what does
 * a visitor see* — and it changes when the public page changes, which is a
 * different reason from any of theirs.
 *
 * ## Nothing here scores anything
 *
 * The standings are `scoreChampionship`'s, handed plain data: this module's
 * whole job is the assembly, and the mapping from stored rows to
 * `CountingEventInput` is `scoringInputFor`'s alone. A second copy of that
 * mapping — here, or on the page — is a second copy that can drift from the one
 * the admin screens score against while every assertion stays green, which is
 * exactly the failure the split was made to prevent.
 *
 * ## Three decisions this module makes, because nothing else does
 *
 *  1. **An event has *counted* once a finishing order is recorded on it.**
 *     UC-34 6 splits the season's events into the ones that have counted and
 *     the ones still to come, and a recorded order is the only honest line
 *     between them. It also has to be the line the standings use: a counting
 *     event three weeks away already has accepted applicants, and feeding it to
 *     `scoreChampionship` would hand every one of them the taking-part points
 *     for a night nobody has played. So an unscored event is listed, never
 *     scored — which is also what makes UC-34 2e ("the season has not started")
 *     a case rather than a bug.
 *
 *  2. **A season's events run in the order they were played** — `starts_at`
 *     ascending, an undated one last, ties broken by title so the order is
 *     total. `listCountingEvents` returns them alphabetically, which is right
 *     for an admin picking one out of a list and wrong for a page that says
 *     "the last event". Hence the extra read below: the dates are not on the
 *     counting row.
 *
 *  3. **The current season is the newest published one.** Two published at
 *     once is possible — a season being wound down beside its successor — and
 *     `created_at` is the only thing that orders them without asking an admin
 *     to say so. `/championship` shows that one; every other one is still at
 *     its own slug.
 *
 * ## Movement is derived, never stored
 *
 * {@link seasonPage} scores the counted events twice: once with all of them,
 * once without the last. The difference in position is how far the last event
 * moved somebody (UC-34 2c). Storing that number would make it the fourth
 * thing a correction has to remember to update, and the whole design of this
 * subsystem is that there is no such thing — a standing is a function of the
 * recorded places, and so is the movement between two of them.
 *
 * ## Asking twice in one request costs once
 *
 * A single page view asks which season this is more than once and cannot help
 * it: `generateMetadata` needs the name for the `<title>`, the page body needs
 * the row itself, and the top bar asks separately because the rule about
 * whether the navigation item exists is `SiteNav`'s rather than any page's.
 * Three callers, one answer, and nothing about them should have to know about
 * each other.
 *
 * So the two lookups are wrapped in React's `cache`, which is Next 16's
 * request memoization for reads that are not `fetch` — an ORM read deduplicated
 * for the length of one render pass, with each request getting its own scope
 * and nothing shared between them (`node_modules/next/dist/docs/01-app/
 * 02-guides/caching-without-cache-components.md`, "Deduplicating requests").
 * It is not a cache in the sense that anything is held between requests: the
 * next visitor's read still hits the database, and an admin publishing a season
 * is visible on the next page view exactly as before.
 *
 * Memoization is keyed on the arguments, which is why `publicSeason` hands its
 * query to a helper taking the slug and a boolean: a fresh `{ isAdmin }` object
 * on every call is a fresh key every time, and would have deduplicated nothing.
 */

import { cache } from "react";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  type Database,
  type EventStatus,
  championships,
  db as defaultDb,
  events,
  games,
} from "@/db";
import {
  type ChampionshipScoring,
  type CountingEventInput,
  type SeasonResult,
  scoreChampionship,
  usesOwnTable,
} from "./championship-policy";
import {
  placementsFor,
  scoringInputFor,
  scoringInputsFor,
} from "./championship-results";
import {
  type ChampionshipRow,
  type CountingEvent,
  listCountingEvents,
  listCountingEventsIn,
} from "./championships";
import { UNKNOWN_PLAYER, profilesFor } from "./players";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

/** One event counting towards a season, as the public page lists it. */
export type SeasonEvent = {
  eventId: string;
  slug: string;
  title: string;
  /** Which game it was — "among us", "fall guys" — or null for a game-less night. */
  gameName: string | null;
  startsAt: Date | null;
  status: EventStatus;
  /** Above 1 when the night is worth more than an ordinary one. */
  weight: number;
  /**
   * True when this event scores off its own points table rather than the
   * season's (R-177).
   *
   * A boolean rather than the table itself, and deliberately: the page prints
   * *one* table — the season's — and what a reader needs is to be told that
   * this night did not use it, not a second ladder to compare place by place.
   * Handing the whole array up would also put a copy of the rule that decides
   * which table wins next to `resultsForEvent`, which is the only place that
   * decides it (an empty table falls back, which is why this is a length test
   * rather than a null test).
   *
   * Without it the page lies: the standings would show points the printed
   * table cannot produce, and UC-34 4's "so that the total makes sense" is
   * exactly the promise that breaks.
   */
  ownTable: boolean;
};

/** A counting event with a finishing order on it. */
export type CountedEvent = SeasonEvent & {
  /** Who won — a team's name or a player's. More than one when first was shared. */
  winners: string[];
};

/** One member's place in the season, with everything the page prints about them. */
export type SeasonPlayer = {
  userId: string;
  name: string;
  /** Their `/players/[handle]` segment, or null when they have never been given one. */
  handle: string | null;
  avatarUrl: string | null;
  /** 1-based. Members still level after the tie rule share one (R-181). */
  position: number;
  points: number;
  /** True when somebody else holds the same position. */
  level: boolean;
  /** How many of their results count, of how many they played (UC-34 2d). */
  counted: number;
  played: number;
  /** Every result, in the season's own event order — the ones `countBest` dropped included. */
  results: SeasonResult[];
  /**
   * Places gained at the last counted event: positive up, negative down, 0 for
   * a player who held station. Null for somebody who was not in the standings
   * before it, and null throughout when there is no earlier standing to compare.
   */
  moved: number | null;
};

/** Everything `/championship/[slug]` draws. */
export type SeasonPage = {
  season: ChampionshipRow;
  standings: SeasonPlayer[];
  /** The events that have counted, in the order they were played. */
  counted: CountedEvent[];
  /** The counting events with no finishing order yet, in the order they will be played. */
  toCome: SeasonEvent[];
  /** The event the movement figures are measured at. Null until a second one counts. */
  movedAt: CountedEvent | null;
};

/** One finished season, as UC-35 4 lists it. */
export type FinishedSeason = {
  slug: string;
  name: string;
  runsFrom: string | null;
  runsTo: string | null;
  /** Who took it. More than one when the season ended level; empty when nobody played. */
  winners: string[];
};

/* ------------------------------------------------------------------ */
/* Which season                                                       */
/* ------------------------------------------------------------------ */

/**
 * The season `/championship` shows, and the one the navigation item points at
 * — the newest published one, or null when none is.
 *
 * Null is also the whole of UC-34 1a: with no published season there is no
 * navigation item, because there is nowhere for it to go.
 *
 * Memoized per request — see the note at the top. `/championship` asks in its
 * metadata and again in its body, and the top bar asks on every page there is.
 */
export const currentSeason = cache(async function currentSeason(
  database: Database = defaultDb
): Promise<ChampionshipRow | null> {
  const [row] = await database
    .select()
    .from(championships)
    .where(eq(championships.status, "published"))
    .orderBy(desc(championships.createdAt))
    .limit(1);
  return row ?? null;
});

/** Who is asking for a season by its slug. */
export type SeasonViewer = { isAdmin: boolean };

/**
 * The season at this slug, or null when the person asking may not see it.
 *
 * **R-189 in public.** A hidden season is an admin's draft: its name and its
 * points table are still being argued about, and a visitor who guesses the slug
 * must not learn that it exists. So the status is part of the lookup rather
 * than something the page remembers to check afterwards, and the page turns
 * null into `notFound()` — a 404, not a 403, because a 403 confirms the season
 * is there.
 *
 * Published and closed are both visible, and closed deliberately so: a finished
 * season keeping its page for good is the whole promise of UC-35.
 *
 * Memoized per request — see the note at the top. `/championship/[slug]` asks
 * in its metadata and again in its body, and the two ask as different viewers,
 * which is exactly why the memoized helper is keyed on the boolean rather than
 * on the object carrying it.
 */
export async function publicSeason(
  slug: string,
  viewer: SeasonViewer,
  database: Database = defaultDb
): Promise<ChampionshipRow | null> {
  return seasonBySlug(slug, viewer.isAdmin, database);
}

/** {@link publicSeason}'s query, keyed on what actually decides the answer. */
const seasonBySlug = cache(async function seasonBySlug(
  slug: string,
  isAdmin: boolean,
  database: Database
): Promise<ChampionshipRow | null> {
  const [row] = await database
    .select()
    .from(championships)
    .where(
      isAdmin
        ? eq(championships.slug, slug)
        : and(eq(championships.slug, slug), ne(championships.status, "hidden"))
    )
    .limit(1);
  return row ?? null;
});

/* ------------------------------------------------------------------ */
/* The season's events                                                */
/* ------------------------------------------------------------------ */

/** The scoring rules, off the row the columns store them in. */
function scoringOf(season: ChampionshipRow): ChampionshipScoring {
  return {
    pointsTable: season.pointsTable,
    participationPoints: season.participationPoints,
    countBest: season.countBest,
  };
}

/**
 * Every event counting towards this season, in the order it was played.
 *
 * The counting rows carry the weight; the events carry the dates, the slug and
 * the game, and neither table has the other's. Two reads and a join in memory
 * rather than a third query shape in `./championships`: a season has tens of
 * counting events, and that module's list is an admin's alphabetical one.
 */
async function seasonEvents(
  championshipId: string,
  database: Database
): Promise<SeasonEvent[]> {
  const counting = await listCountingEvents(championshipId, database);
  if (counting.length === 0) return [];

  const rows = await database
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      status: events.status,
      startsAt: events.startsAt,
      gameName: games.name,
    })
    .from(events)
    .leftJoin(games, eq(games.id, events.gameId))
    .where(
      inArray(
        events.id,
        counting.map((row) => row.eventId)
      )
    );

  const detail = new Map(rows.map((row) => [row.id, row]));
  const out: SeasonEvent[] = [];
  for (const row of counting) {
    const event = detail.get(row.eventId);
    if (!event) continue;
    out.push({
      eventId: row.eventId,
      slug: event.slug,
      title: event.title,
      gameName: event.gameName,
      startsAt: event.startsAt,
      status: event.status,
      weight: row.weight,
      // The same question `resultsForEvent` asks, asked of the same function:
      // the mark on the page and the table the arithmetic used cannot disagree
      // while there is only one of it.
      ownTable: usesOwnTable(row.pointsTable),
    });
  }
  return out.sort(byWhenPlayed);
}

/**
 * The order the season was played in: by date, an undated event last, ties
 * broken by title.
 *
 * Total on purpose. "The last event" has to mean one event, and two nights that
 * started at the same minute — or two that have no date at all — would
 * otherwise be ordered by whatever the query planner felt like.
 */
function byWhenPlayed(x: SeasonEvent, y: SeasonEvent): number {
  const xs = x.startsAt?.getTime() ?? Infinity;
  const ys = y.startsAt?.getTime() ?? Infinity;
  if (xs !== ys) return xs - ys;
  return x.title.localeCompare(y.title);
}

/** Whoever finished first — a team's name or a player's, and both when it was shared. */
function winnersOf(places: readonly { position: number; name: string }[]): string[] {
  return places.filter((place) => place.position === 1).map((place) => place.name);
}

/* ------------------------------------------------------------------ */
/* The page                                                           */
/* ------------------------------------------------------------------ */

/**
 * The whole of a season's public page: the standings, the events that have
 * counted, the ones still to come, and how far the last one moved people.
 *
 * Takes the season row rather than its id, because the caller has already read
 * it — `publicSeason` is what decided the visitor may see it at all, and
 * re-reading it here would be a second chance to get that answer wrong.
 */
export async function seasonPage(
  season: ChampionshipRow,
  database: Database = defaultDb
): Promise<SeasonPage> {
  const all = await seasonEvents(season.id, database);

  /*
   * The recorded order, read once per event and used twice: it is what decides
   * whether an event has counted at all, it is what the arithmetic scores, and
   * it carries the names this page prints under "Won by". Handing those rows to
   * `scoringInputFor` rather than letting it read the same ones again is the
   * whole of the saving: the mapping is still its, and there is still one of it.
   */
  const places = await placementsFor(
    all.map((event) => event.eventId),
    database
  );

  // One `scoringInputFor` per event — the single mapping from stored rows to
  // what the arithmetic takes. An event with no places recorded has not
  // counted, so it is listed and not scored; see the note at the top.
  const inputs = await Promise.all(
    all.map((event) =>
      scoringInputFor(event.eventId, database, places.get(event.eventId) ?? [])
    )
  );

  const counted: CountedEvent[] = [];
  const scored: CountingEventInput[] = [];
  const toCome: SeasonEvent[] = [];
  for (const [index, event] of all.entries()) {
    const input = inputs[index];
    if (input && input.placements.length > 0) {
      scored.push(input);
      counted.push({ ...event, winners: winnersOf(places.get(event.eventId) ?? []) });
    } else {
      toCome.push(event);
    }
  }

  const scoring = scoringOf(season);
  const standings = scoreChampionship(scoring, scored);

  /*
   * Where everybody stood before the last event — the same arithmetic over one
   * fewer event. `countBest` makes this more than a subtraction: dropping the
   * last night can change which of a member's earlier results count, so the
   * only way to know where they were is to score it as it was.
   */
  const before =
    scored.length > 1
      ? new Map(
          scoreChampionship(scoring, scored.slice(0, -1)).map((row) => [
            row.userId,
            row.position,
          ])
        )
      : null;

  const people = await profilesFor(
    standings.map((row) => row.userId),
    database
  );

  return {
    season,
    counted,
    toCome,
    movedAt: before ? (counted.at(-1) ?? null) : null,
    standings: standings.map((row) => {
      const person = people.get(row.userId);
      const was = before?.get(row.userId);
      return {
        userId: row.userId,
        name: person?.name ?? UNKNOWN_PLAYER,
        handle: person?.handle ?? null,
        avatarUrl: person?.avatarUrl ?? null,
        position: row.position,
        points: row.points,
        level: row.level,
        counted: row.counted,
        played: row.played,
        results: row.results,
        moved: was === undefined ? null : was - row.position,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Past seasons (UC-35 3-4)                                           */
/* ------------------------------------------------------------------ */

/**
 * Every finished season, newest first, with whoever took it.
 *
 * The winner is the standings' first position re-derived, not a name written
 * down when the season closed: closing freezes the season by refusing writes,
 * which is what makes re-scoring it give the same answer for ever. Level at the
 * top puts both names on the line, for the same reason the standings show them
 * level rather than picking one.
 *
 * It re-scores every finished season on every read, which is the honest cost of
 * storing no totals. What it must not also cost is a round trip per event: this
 * is a *footer*, it runs on every view of every championship page, and read one
 * season at a time it was a query per counting event inside a query per season
 * — five closed seasons of twenty events is five hundred queries to print five
 * names.
 *
 * So the whole closed set is read at once and scored in memory: the counting
 * rows for every closed season in one `inArray`, their stored orders and
 * participant lists in a fixed handful more (`scoringInputsFor`), and one last
 * read for the names at the top. The number of queries no longer depends on how
 * many seasons have finished or how many nights were in them.
 *
 * The scoring itself is unchanged, and deliberately so. It would be cheaper
 * still to read the places alone and call whoever came first the winner, but a
 * season is not scored that way: taking part is worth points (UC-31 4), so
 * somebody who turned up to every night can finish above somebody who won the
 * one they entered, and a footer that disagreed with the standings page it
 * links to would be worse than a slow one.
 */
export async function finishedSeasons(
  database: Database = defaultDb
): Promise<FinishedSeason[]> {
  const rows = await database
    .select()
    .from(championships)
    // Newest first, by when the season was set up rather than by when it ran:
    // `runs_to` is nullable, and a null sorts differently at either end of a
    // `desc`, so a season whose months were never filled in would jump about.
    .where(eq(championships.status, "closed"))
    .orderBy(desc(championships.createdAt));
  if (rows.length === 0) return [];

  const counting = await listCountingEventsIn(
    rows.map((season) => season.id),
    database
  );
  const inputs = await scoringInputsFor(
    [...counting.values()].flat(),
    database
  );

  /*
   * Every season's top scorers, before any name is read: which member ids the
   * one read below has to cover is not known until all of them are scored.
   */
  const tops = rows.map((season) => winnersOfSeason(season, counting, inputs));
  const people = await profilesFor(tops.flat(), database);

  return rows.map((season, index) => ({
    slug: season.slug,
    name: season.name,
    runsFrom: season.runsFrom,
    runsTo: season.runsTo,
    winners: tops[index].map((userId) => people.get(userId)?.name ?? UNKNOWN_PLAYER),
  }));
}

/**
 * Whoever is first in one season's standings, scored from rows already read.
 *
 * The same arithmetic `seasonPage` runs, over the same inputs and with the same
 * rule about what has counted — an event with no order recorded on it is not
 * scored — so a closed season's winner here is the name at the top of its own
 * page. Empty when nobody ever played.
 */
function winnersOfSeason(
  season: ChampionshipRow,
  counting: Map<string, CountingEvent[]>,
  inputs: Map<string, CountingEventInput>
): string[] {
  const scored = (counting.get(season.id) ?? [])
    .map((row) => inputs.get(row.eventId))
    .filter(
      (input): input is CountingEventInput =>
        input !== undefined && input.placements.length > 0
    );

  return scoreChampionship(scoringOf(season), scored)
    .filter((row) => row.position === 1)
    .map((row) => row.userId);
}

