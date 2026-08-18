/**
 * Public player profiles — `/players/[handle]` (docs/platform-plan.md §4).
 *
 * "Events played, teams they were on, what they were bought for, and anything
 * they won." Public, no session: §11 puts every one of those facts in the
 * public row already, and the Teams tab has printed the prices since Phase 4.
 * This page is the same record indexed by person rather than by event, which is
 * the view somebody actually wants when a name comes up in Discord.
 *
 * ## What is deliberately not here
 *
 * **Application answers.** A question set is designed for an admin to read while
 * deciding who gets in — "can you make Sunday", "what's your rank", "anything
 * else we should know" — and a member answering it has no reason to expect the
 * answer on a public page. Nothing in this module reads `applications.answers`,
 * and nothing should.
 *
 * Also absent: which events somebody was *declined* from or withdrew from, and
 * anything about an unpublished event. Only accepted applications to events
 * that exist publicly are counted, so the profile can never leak that a draft
 * event is being planned or that somebody was turned down.
 *
 * Bid amounts are not here either, but that needs no rule: a losing bid is
 * `./draft`'s business and is redacted at source.
 *
 * ## Handles
 *
 * `users.handle` is derived from the Discord name **once** and then never
 * recomputed — see the column's comment. {@link ensureHandles} is the only
 * writer, it is idempotent, and it is safe to call from a read path: a member
 * who has never been given a handle gets one the first time anything wants to
 * link to them.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  type Database,
  type EventStatus,
  type User,
  applications,
  db as defaultDb,
  events,
  teamMembers,
  teams,
  users,
} from "@/db";
import { placementsOf } from "./event-board";
import { formatFor } from "./format";
import { slugify, uniqueKey } from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Handles                                                            */
/* ------------------------------------------------------------------ */

/** Nobody's handle, however creative their display name. */
const RESERVED = new Set(["admin", "me", "events", "players", "signin", "api", "new"]);

/**
 * The handle a member would get, before uniqueness is considered.
 *
 * Pure, so the awkward names are cheap to test: an all-emoji display name, a
 * name that slugs to `admin`, somebody called `-`. The fallback is `player`
 * rather than the Discord snowflake, because a URL is a thing people read out
 * and an eighteen-digit number is not — and `player-2` is a perfectly good
 * handle for the one member whose name contains no letters.
 */
export function handleBase(user: {
  displayName?: string | null;
  name?: string | null;
}): string {
  const base = slugify(user.displayName ?? user.name ?? "", 32);
  if (!base || RESERVED.has(base)) return base ? `${base}-player` : "player";
  return base;
}

/**
 * Give every one of these members a handle if they do not have one, and hand
 * back the map from id to handle.
 *
 * Idempotent, and cheap when there is nothing to do — the common case is one
 * `select` and no write at all. Concurrency is handled by the unique
 * constraint rather than by a lock: two requests naming the same new member at
 * the same instant is possible, one of them loses the insert, and the retry
 * picks the next free suffix. A lock over the whole `users` table to avoid a
 * once-in-a-year retry would cost more than it saves.
 */
export async function ensureHandles(
  userIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;

  const rows = await database
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      name: users.name,
    })
    .from(users)
    .where(inArray(users.id, wanted));

  const missing = rows.filter((row) => !row.handle);
  for (const row of rows) if (row.handle) out.set(row.id, row.handle);
  if (missing.length === 0) return out;

  // Every handle already spoken for. Read once, then kept in step locally, so a
  // batch of new members does not hand the same handle to two of them.
  const takenRows = await database
    .select({ handle: users.handle })
    .from(users)
    .where(isNotNull(users.handle));
  const taken = new Set(
    takenRows.map((row) => row.handle).filter((handle): handle is string => Boolean(handle))
  );

  for (const row of missing) {
    let assigned: string | null = null;

    for (let attempt = 0; attempt < 5 && !assigned; attempt += 1) {
      const candidate = uniqueKey(handleBase(row), taken, "player");
      taken.add(candidate);
      try {
        const [written] = await database
          .update(users)
          .set({ handle: candidate })
          // `is null` in the predicate is what makes this a compare-and-set:
          // the update simply matches nothing if a concurrent request got there
          // first, rather than overwriting the handle they were given.
          .where(and(eq(users.id, row.id), isNull(users.handle)))
          .returning({ handle: users.handle });
        // No row came back: somebody assigned this member a handle between the
        // read and the write. Their handle is the right answer, not ours.
        assigned = written?.handle ?? null;
        if (!assigned) {
          const [current] = await database
            .select({ handle: users.handle })
            .from(users)
            .where(eq(users.id, row.id))
            .limit(1);
          assigned = current?.handle ?? null;
          if (!assigned) break;
        }
      } catch {
        // The unique constraint fired — another request took the candidate.
        // Round again; `taken` already excludes it.
      }
    }

    if (assigned) out.set(row.id, assigned);
  }

  return out;
}

/** One member's handle, assigning it if they have not got one. */
export async function handleOf(
  userId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const map = await ensureHandles([userId], database);
  return map.get(userId) ?? null;
}

/**
 * Display names for a handful of ids.
 *
 * The audit log's summaries are written once and never rebuilt, so they need
 * the names at the moment they are written — "Made Beko Lolek captain of
 * Rivals Red" rather than a pair of uuids the reader has to go and look up.
 * Missing ids simply do not appear, which is what lets a caller pass a list
 * that includes nulls without filtering first.
 */
export async function displayNamesFor(
  userIds: readonly (string | null | undefined)[],
  database: Database = defaultDb
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const rows = await database
    .select({ id: users.id, displayName: users.displayName, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));

  return new Map(
    rows.map((row) => [row.id, row.displayName ?? row.name ?? "Unknown player"])
  );
}

/* ------------------------------------------------------------------ */
/* The profile                                                        */
/* ------------------------------------------------------------------ */

/** One event this member was in. */
export type PlayerEventEntry = {
  event: {
    id: string;
    slug: string;
    title: string;
    type: string;
    status: EventStatus;
    startsAt: Date | null;
    endsAt: Date | null;
  };
  /** Null when the event never had teams — a Jackbox night. */
  team: { id: string; name: string } | null;
  isCaptain: boolean;
  /**
   * What they were bought for. Null when there was nothing to buy: a captain
   * (§14 gives them a roster row at zero, which is not a price), or an event
   * with no draft at all. Zero is a real answer and means they went for nothing.
   */
  price: number | null;
  /** Where their team finished, once a stage has crowned somebody. */
  placement: { position: number; shared: number } | null;
  /** True only for first place outright. */
  won: boolean;
};

export type PlayerProfile = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  memberSince: Date;
  /** Newest first — the same order `/me/events` uses. */
  entries: PlayerEventEntry[];
  totals: {
    events: number;
    /** Events they were on a team for. */
    teams: number;
    /** Times they were bought at a draft. */
    drafted: number;
    /** The sum of those prices. */
    spent: number;
    /** Highest single price. */
    top: number;
    captained: number;
    won: number;
    podiums: number;
  };
};

/** The statuses a profile counts. A draft event does not exist publicly. */
const PUBLIC_STATUSES: readonly EventStatus[] = ["published", "live", "complete", "cancelled"];

/**
 * Look a member up by handle.
 *
 * Returns `null` rather than throwing for an unknown handle, so the page can
 * `notFound()` — a handle that has never existed and a handle belonging to a
 * member with nothing to show are different pages, and only the first is a 404.
 */
export async function getPlayerByHandle(
  handle: string,
  database: Database = defaultDb
): Promise<User | null> {
  const wanted = handle.trim().toLowerCase();
  if (!wanted) return null;
  const [row] = await database.select().from(users).where(eq(users.handle, wanted)).limit(1);
  return row ?? null;
}

/**
 * The whole public profile.
 *
 * Four reads and then one `formatFor` per event that has a bracket, which is
 * what "anything they won" costs: a placement is resolved from results on
 * read (§8.5) and is deliberately not a column, so there is nothing to look up.
 * A member with twenty events is twenty resolutions — comfortably fast, and the
 * page is `force-dynamic` anyway because everything else on the site is.
 */
export async function getPlayerProfile(
  user: User,
  database: Database = defaultDb
): Promise<PlayerProfile> {
  const handle = user.handle ?? (await handleOf(user.id, database)) ?? "player";

  const [accepted, memberships] = await Promise.all([
    database
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        type: events.type,
        status: events.status,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        createdAt: events.createdAt,
      })
      .from(applications)
      .innerJoin(events, eq(applications.eventId, events.id))
      .where(
        and(
          eq(applications.userId, user.id),
          eq(applications.status, "accepted"),
          inArray(events.status, PUBLIC_STATUSES)
        )
      )
      .orderBy(desc(events.startsAt), desc(events.createdAt)),

    database
      .select({
        eventId: teamMembers.eventId,
        teamId: teamMembers.teamId,
        teamName: teams.name,
        price: teamMembers.price,
        isCaptain: teamMembers.isCaptain,
        status: events.status,
        slug: events.slug,
        title: events.title,
        type: events.type,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        createdAt: events.createdAt,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .innerJoin(events, eq(teamMembers.eventId, events.id))
      .where(and(eq(teamMembers.userId, user.id), inArray(events.status, PUBLIC_STATUSES)))
      .orderBy(desc(events.startsAt), asc(teams.sort)),
  ]);

  // A roster row is the stronger claim: somebody can be on a team without an
  // application row surviving (an admin override, a late substitution), and
  // being on a team is the fact the page is about.
  const byEvent = new Map<string, PlayerEventEntry>();

  for (const row of accepted) {
    byEvent.set(row.id, {
      event: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        type: row.type,
        status: row.status,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
      team: null,
      isCaptain: false,
      price: null,
      placement: null,
      won: false,
    });
  }

  for (const row of memberships) {
    byEvent.set(row.eventId, {
      event: {
        id: row.eventId,
        slug: row.slug,
        title: row.title,
        type: row.type,
        status: row.status,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
      team: { id: row.teamId, name: row.teamName },
      isCaptain: row.isCaptain,
      price: row.isCaptain ? null : row.price,
      placement: null,
      won: false,
    });
  }

  // Honours: resolve each event that has a team, and read this member's team
  // out of the placements the deciding stage produced.
  const withTeams = [...byEvent.values()].filter((entry) => entry.team);
  await Promise.all(
    withTeams.map(async (entry) => {
      const format = await formatFor(entry.event.id, database);
      const placements = placementsOf(format);
      const mine = placements.find((placement) => placement.teamId === entry.team?.id);
      if (!mine) return;
      entry.placement = { position: mine.position, shared: mine.shared };
      entry.won = mine.position === 1 && mine.shared === 1;
    })
  );

  const entries = [...byEvent.values()].sort((a, b) => {
    const at = a.event.startsAt?.getTime() ?? 0;
    const bt = b.event.startsAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return a.event.title.localeCompare(b.event.title);
  });

  const prices = entries
    .map((entry) => entry.price)
    .filter((price): price is number => price !== null);

  return {
    id: user.id,
    handle,
    displayName: user.displayName ?? user.name ?? "Unknown player",
    avatarUrl: user.avatarUrl ?? user.image ?? null,
    memberSince: user.createdAt,
    entries,
    totals: {
      events: entries.length,
      teams: entries.filter((entry) => entry.team).length,
      drafted: prices.length,
      spent: prices.reduce((total, price) => total + price, 0),
      top: prices.length > 0 ? Math.max(...prices) : 0,
      captained: entries.filter((entry) => entry.isCaptain).length,
      won: entries.filter((entry) => entry.won).length,
      podiums: entries.filter(
        (entry) => entry.placement !== null && entry.placement.position <= 3
      ).length,
    },
  };
}
