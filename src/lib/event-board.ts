/**
 * Everything the *public* tournament surface reads (docs/platform-plan.md §4,
 * §6.2, §11).
 *
 * The public tabs — Teams, Schedule, Bracket, Results — need three things that
 * live in three modules: rosters and prices from `./draft`, the resolved format
 * from `./format`, and display names from `users`. This is the one place that
 * joins them, so the event page makes one call rather than four and so the
 * shape the tabs render against is stated once.
 *
 * ## Nothing here decides anything
 *
 * There is no policy in this file. Balances are `./draft-policy`'s derivation
 * from the awarded lots, the bracket is `./format-resolve`'s resolve-on-read,
 * the running order is `./format-schedule`'s plan. This fetches, joins, and
 * hands over what those three already worked out.
 *
 * It also converts nothing. `getTeams` returns `TeamWithRoster` and
 * `src/components/draft/` renders exactly that shape, so a public roster is the
 * same card the admin's Teams tab and the live draft room draw — one component,
 * one idea of where the money sits, no third copy that drifts.
 *
 * ## Why the prices are public
 *
 * §11 puts "view published events, results, brackets" in the public column, and
 * a draft whose prices vanish once the room closes is a draft nobody can argue
 * about afterwards. `team_members.price` is written when a lot is awarded and
 * never rewritten, so publishing it costs nothing and is what makes the storage
 * rewrite worth having: what somebody went for becomes a permanent public fact
 * rather than a screenshot in a Discord channel.
 *
 * ## Read-only, and unredacted on purpose
 *
 * Every function takes an event id and returns what anybody may see. There is
 * no viewer argument because there is nothing left to hide: the live draft's
 * sealed bid amounts are `./draft`'s problem and settle long before a team page
 * exists. An unpublished event is hidden by the page that calls this, not here.
 */

import { inArray } from "drizzle-orm";
import { type Database, db as defaultDb, users } from "@/db";
import type { PlayerBook } from "@/components/draft";
import { type TeamWithRoster, getTeams } from "./draft";
import { type FormatView, formatFor } from "./format";
import type { ResolvedMatch } from "./format-resolve";

/* ------------------------------------------------------------------ */
/* Names                                                              */
/* ------------------------------------------------------------------ */

/**
 * The display name and avatar for everybody these teams mention.
 *
 * Captains are looked up as well as roster rows: `teams.captain_user_id` is set
 * before the draft starts, so a team can have a captain and an empty roster,
 * and a card that printed "Unknown player" next to the © for a whole week would
 * be a plain bug.
 */
export async function playerBookFor(
  teams: TeamWithRoster[],
  database: Database = defaultDb
): Promise<PlayerBook> {
  const ids = new Set<string>();
  for (const team of teams) {
    if (team.captainUserId) ids.add(team.captainUserId);
    for (const member of team.members) ids.add(member.userId);
  }
  if (ids.size === 0) return {};

  const rows = await database
    .select({
      id: users.id,
      displayName: users.displayName,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, [...ids]));

  const book: Record<string, { displayName: string; avatarUrl: string | null }> = {};
  for (const row of rows) {
    book[row.id] = {
      displayName: row.displayName ?? row.name ?? "Unknown player",
      avatarUrl: row.avatarUrl,
    };
  }
  return book;
}

/* ------------------------------------------------------------------ */
/* The whole board                                                    */
/* ------------------------------------------------------------------ */

export type EventBoard = {
  /** Teams in the admin's order, each with its derived balance and roster state. */
  teams: TeamWithRoster[];
  /** Everyone those teams name, keyed by user id. */
  players: PlayerBook;
  /** Null when the event has no stages — a Jackbox night, or one not set up yet. */
  format: FormatView | null;
  /** Every match of every stage, in play order. The flat view the tabs want. */
  matches: ResolvedMatch[];
  /** Which tabs have something in them (§6.2). */
  has: {
    teams: boolean;
    schedule: boolean;
    bracket: boolean;
    results: boolean;
  };
};

/**
 * The whole public tournament surface for one event.
 *
 * `has` is the part the page branches on. §6.2's rule is that a tab appears
 * only once it has content — a Jackbox night never shows a bracket — and that
 * is a question about data, so it is answered here rather than retyped as four
 * conditions in the page:
 *
 *  - **teams** once there is a team, captain or not;
 *  - **schedule** once a match has a time, or the event has days of its own —
 *    which is what keeps the existing day list on a Jackbox night that will
 *    never have a match;
 *  - **bracket** once matches exist at all, played or not, because an unplayed
 *    bracket full of placeholder names is exactly what somebody checking
 *    whether they are in the quarters came to see;
 *  - **results** only once something has actually been played. An untouched
 *    results tab is a promise the board cannot keep.
 */
export async function getEventBoard(
  eventId: string,
  options: { days?: number } = {},
  database: Database = defaultDb
): Promise<EventBoard> {
  const [teams, format] = await Promise.all([
    getTeams(eventId, database),
    formatFor(eventId, database),
  ]);
  const players = await playerBookFor(teams, database);

  const matches = format ? format.stages.flatMap((stage) => stage.matches) : [];

  return {
    teams,
    players,
    format,
    matches,
    has: {
      teams: teams.length > 0,
      schedule: matches.some((match) => match.scheduledAt) || (options.days ?? 0) > 0,
      bracket: matches.length > 0,
      results: matches.some(
        (match) => match.status === "done" || match.games.some((game) => game.played)
      ),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Placements across stages                                           */
/* ------------------------------------------------------------------ */

export type BoardPlacement = {
  position: number;
  shared: number;
  teamId: string;
  name: string;
};

/**
 * Who finished where, with the names filled in — or nothing at all.
 *
 * The *last* stage that has crowned somebody is the one that decides the event:
 * a group stage settles a table, not a tournament, so a two-stage event takes
 * its podium from the playoffs. An event still being played gets an empty list,
 * which is the honest answer — half a podium is worse than none.
 */
export function podiumFor(board: EventBoard): BoardPlacement[] {
  if (!board.format) return [];

  const deciding = [...board.format.stages].reverse().find((stage) => stage.champion !== null);
  if (!deciding) return [];

  const named = new Map(board.format.teams.map((team) => [team.id, team.name]));
  return deciding.placements
    .filter((placement) => named.has(placement.teamId))
    .map((placement) => ({ ...placement, name: named.get(placement.teamId) as string }));
}

/** Team names by id, for anything that has a team id and needs a word. */
export function teamNames(board: EventBoard): Map<string, string> {
  return new Map((board.format?.teams ?? board.teams).map((team) => [team.id, team.name]));
}
