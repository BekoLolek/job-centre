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
 * A night scored in rounds (decision 006) is the fourth thing: its setup from
 * `events.config`, its rows from `./round-scores`, and its ranking from
 * `./round-scoring`. Joined here for the same reason, so that "does this event
 * have a result" is one answer whichever shape the event has.
 *
 * ## Nothing here decides anything
 *
 * There is no policy in this file. Balances are `./draft-policy`'s derivation
 * from the awarded lots, the bracket is `./format-resolve`'s resolve-on-read,
 * the running order is `./format-schedule`'s plan, the night's table is
 * `rankRounds`. This fetches, joins, and hands over what those already worked
 * out.
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
 * A round score is public for R-234's reason — a total nobody can see the parts
 * of is a number to be argued with — and names only people who hold or held a
 * seat, which "Who's in" already prints.
 */

import { eq, inArray } from "drizzle-orm";
import { type Database, db as defaultDb, events, users } from "@/db";
import type { PlayerBook } from "@/components/draft";
import { type TeamWithRoster, getTeams } from "./draft";
import { type RoundScoring, roundScoringFrom } from "./events-policy";
import { ensureHandles } from "./players";
import { type FormatView, formatFor } from "./format";
import type { ResolvedMatch } from "./format-resolve";
import { listRoundScores } from "./round-scores";
import { type RoundRank, type RoundScoreRow, rankRounds } from "./round-scoring";

/* ------------------------------------------------------------------ */
/* Names                                                              */
/* ------------------------------------------------------------------ */

/**
 * Everybody these teams mention.
 *
 * Captains are looked up as well as roster rows: `teams.captain_user_id` is set
 * before the draft starts, so a team can have a captain and an empty roster,
 * and a card that printed "Unknown player" next to the © for a whole week would
 * be a plain bug.
 */
function namedBy(teams: TeamWithRoster[]): string[] {
  const ids = new Set<string>();
  for (const team of teams) {
    if (team.captainUserId) ids.add(team.captainUserId);
    for (const member of team.members) ids.add(member.userId);
  }
  return [...ids];
}

/** The display name and avatar for each of these users, keyed by id. */
export async function playerBookFor(
  userIds: Iterable<string>,
  database: Database = defaultDb
): Promise<PlayerBook> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return {};

  // Assigning here is what guarantees a roster row can link to §4's public
  // profile. It is a write on a read path, which is unusual enough to justify:
  // `ensureHandles` is idempotent and costs one `select` once everybody has
  // one, and the alternative — assigning only at sign-in — leaves every member
  // who existed before this feature unlinkable until they next sign in.
  //
  // Deliberately *not* done in `getDraftView`: the draft room polls this data
  // once a second, and a write on that path would be a write once a second.
  const handles = await ensureHandles(ids, database);

  const rows = await database
    .select({
      id: users.id,
      displayName: users.displayName,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, ids));

  const book: Record<
    string,
    { displayName: string; avatarUrl: string | null; handle: string | null }
  > = {};
  for (const row of rows) {
    book[row.id] = {
      displayName: row.displayName ?? row.name ?? "Unknown player",
      avatarUrl: row.avatarUrl,
      handle: handles.get(row.id) ?? null,
    };
  }
  return book;
}

/* ------------------------------------------------------------------ */
/* The whole board                                                    */
/* ------------------------------------------------------------------ */

/**
 * A round-scored night's table, derived on every read (decision 006).
 *
 * `ranks` is `rankRounds`' output in a **stated** order: best first, and
 * players level on a place by name. `rankRounds` leaves a tie in the order the
 * rows arrived, and `listRoundScores` orders a round's rows by their random
 * uuid (Task 88's note), so an order inherited from it would shuffle two tied
 * players between one page load and the next. The podium and the public table
 * both read this list, so they agree.
 */
export type RoundTable = {
  /** The setup, as stored on the event. */
  scoring: RoundScoring;
  /** Every recorded score, in `listRoundScores`' order. */
  rows: RoundScoreRow[];
  /** Who finished where, best first, ties by name. */
  ranks: RoundRank[];
  /** How many of the night's rounds hold at least one score (UC-46 3a). */
  scored: number;
};

export type EventBoard = {
  /** Teams in the admin's order, each with its derived balance and roster state. */
  teams: TeamWithRoster[];
  /** Everyone those teams name and everyone the table places, keyed by user id. */
  players: PlayerBook;
  /** Null when the event has no stages — a Jackbox night, or one not set up yet. */
  format: FormatView | null;
  /** Every match of every stage, in play order. The flat view the tabs want. */
  matches: ResolvedMatch[];
  /** The night's table, or null for an event that is not scored in rounds. */
  rounds: RoundTable | null;
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
 *  - **results** only once something has actually been played — a match with
 *    a game in it, or a round with a score in it. An untouched results tab is
 *    a promise the board cannot keep, and a night whose Scoring panel was
 *    saved on Tuesday has not been played on Tuesday; the page says so where
 *    the result would go (UC-46 4a), not with an empty tab.
 */
export async function getEventBoard(
  eventId: string,
  options: { days?: number } = {},
  database: Database = defaultDb
): Promise<EventBoard> {
  const [teams, format, scoring] = await Promise.all([
    getTeams(eventId, database),
    formatFor(eventId, database),
    roundScoringOf(eventId, database),
  ]);
  const rows = scoring ? await listRoundScores(eventId, database) : [];
  const players = await playerBookFor(
    [...namedBy(teams), ...rows.map((row) => row.userId)],
    database
  );
  const rounds = scoring ? roundTable(scoring, rows, players) : null;

  const matches = format ? format.stages.flatMap((stage) => stage.matches) : [];

  return {
    teams,
    players,
    format,
    matches,
    rounds,
    has: {
      teams: teams.length > 0,
      schedule: matches.some((match) => match.scheduledAt) || (options.days ?? 0) > 0,
      bracket: matches.length > 0,
      results:
        matches.some(
          (match) => match.status === "done" || match.games.some((game) => game.played)
        ) ||
        (rounds !== null && rounds.rows.length > 0),
    },
  };
}

/** The stored scoring setup, or null for an event that is not scored in rounds — or gone. */
async function roundScoringOf(eventId: string, database: Database): Promise<RoundScoring | null> {
  const [row] = await database
    .select({ config: events.config })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return roundScoringFrom(row?.config);
}

function roundTable(scoring: RoundScoring, rows: RoundScoreRow[], players: PlayerBook): RoundTable {
  const nameOf = (userId: string) => players[userId]?.displayName ?? "Unknown player";
  const ranks = rankRounds(scoring, rows).sort(
    (x, y) => x.position - y.position || nameOf(x.userId).localeCompare(nameOf(y.userId))
  );
  const count = scoring.rounds.length;
  const scored = new Set(
    rows.filter((row) => row.roundIndex >= 1 && row.roundIndex <= count).map((row) => row.roundIndex)
  ).size;
  return { scoring, rows, ranks, scored };
}

/* ------------------------------------------------------------------ */
/* Placements across stages                                           */
/* ------------------------------------------------------------------ */

/**
 * Who a placement is of: a team out of a bracket, or a player out of a
 * round-scored night's table.
 *
 * One type with two subjects rather than a second placement type beside the
 * first, because every reader of a placement asks the same two questions —
 * where, and what to call them — and only the reader that *links* somewhere
 * cares which kind it has. Not the championship's `PlacementSubject`: that one
 * carries a team's member ids so the season can pay each of them, and a format
 * view has no roster to fill that from.
 */
export type BoardSubject = { kind: "team"; teamId: string } | { kind: "player"; userId: string };

export type BoardPlacement = {
  position: number;
  shared: number;
  name: string;
  subject: BoardSubject;
};

/**
 * Who finished where in a bracket, with the names filled in — or nothing at all.
 *
 * The *last* stage that has crowned somebody is the one that decides the event:
 * a group stage settles a table, not a tournament, so a two-stage event takes
 * its podium from the playoffs. An event still being played gets an empty list,
 * which is the honest answer — half a podium is worse than none.
 *
 * Takes the format rather than the board because `src/lib/players.ts` asks the
 * same question about twenty events at once and has no reason to build twenty
 * boards to do it. `podiumFor` below is the same rule for callers that already
 * hold one, and there is only ever one copy of "which stage decides it".
 */
export function placementsOf(format: FormatView | null): BoardPlacement[] {
  if (!format) return [];

  const deciding = [...format.stages].reverse().find((stage) => stage.champion !== null);
  if (!deciding) return [];

  const named = new Map(format.teams.map((team) => [team.id, team.name]));
  return deciding.placements
    .filter((placement) => named.has(placement.teamId))
    .map((placement) => ({
      position: placement.position,
      shared: placement.shared,
      name: named.get(placement.teamId) as string,
      subject: { kind: "team", teamId: placement.teamId },
    }));
}

/**
 * Who finished where, whatever shape the event has.
 *
 * For a night scored in rounds the table is the **only** authority for the
 * finishing order (decision 006, decision 2), so the bracket is not consulted
 * at all — not even as a fallback while the table is empty. Everything else
 * is {@link placementsOf}.
 */
export function podiumFor(board: EventBoard): BoardPlacement[] {
  if (board.rounds) return tablePlacements(board.rounds.ranks, board.players);
  return placementsOf(board.format);
}

/** The table's ranks as placements: `shared` is how many players hold that place. */
function tablePlacements(ranks: RoundRank[], players: PlayerBook): BoardPlacement[] {
  const holders = new Map<number, number>();
  for (const rank of ranks) holders.set(rank.position, (holders.get(rank.position) ?? 0) + 1);
  return ranks.map((rank) => ({
    position: rank.position,
    shared: holders.get(rank.position) ?? 1,
    name: players[rank.userId]?.displayName ?? "Unknown player",
    subject: { kind: "player", userId: rank.userId },
  }));
}

/**
 * The one-line result of a night scored in rounds (UC-46 4), or null.
 *
 * Null for everything that is not such a night: a bracket's podium already says
 * who won in its tiles, and a sentence on top would change what a team event
 * shows. Null too while nothing is scored — the page says so in its own words.
 *
 * Every round in: "Won by Ada." / "Ada and Bo share first place." Part-way
 * through: "Ada leads after 2 of 6 rounds." / "Ada and Bo share the lead after
 * 2 of 6 rounds." A half-scored night has a leader, not a winner, and the verb
 * is what says which the sentence is reporting (UC-46 3a). A shared first place
 * names everybody in it (R-238): two winners are two names on the one line.
 */
export function resultLine(board: EventBoard): string | null {
  const rounds = board.rounds;
  if (!rounds || rounds.rows.length === 0) return null;

  const first = podiumFor(board)
    .filter((placement) => placement.position === 1)
    .map((placement) => placement.name);
  if (first.length === 0) return null;
  const who = inWords(first);

  const count = rounds.scoring.rounds.length;
  if (rounds.scored >= count) {
    return first.length === 1 ? `Won by ${who}.` : `${who} share first place.`;
  }
  const after = `after ${rounds.scored} of ${count} rounds`;
  return first.length === 1 ? `${who} leads ${after}.` : `${who} share the lead ${after}.`;
}

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
function inWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Team names by id, for anything that has a team id and needs a word. */
export function teamNames(board: EventBoard): Map<string, string> {
  return new Map((board.format?.teams ?? board.teams).map((team) => [team.id, team.name]));
}
