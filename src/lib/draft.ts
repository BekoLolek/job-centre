/**
 * Teams and the draft — the part that talks to Postgres.
 *
 * The rules live in `./draft-policy`, which has no database handle and is
 * tested exhaustively. This module is the trust boundary and the transaction
 * boundary, exactly as `./events` is for applications.
 *
 * ## Nothing here believes the request
 *
 * Team ids, captain choices, pool members and bid amounts are re-read from the
 * database on every write. A bid naming a team from another event is refused
 * outright rather than ignored; a captain who is not an accepted applicant is
 * refused with a sentence saying so. Quietly dropping either produces a draft
 * that looks right and is not, and a draft that is wrong about money is a draft
 * nobody trusts again.
 *
 * ## Bidding and awarding are one transaction each, and they have to be
 *
 * "Read the balance, check the cap, write the row" is a race with a window in
 * the middle of it. Two awards of the same lot both read the same balance and
 * both spend it; two bids merged into one document lose whichever landed first.
 * So every mutation that touches money takes the event's row lock
 * (`select … for update`) and does its reading *and* its writing inside it. The
 * lock is on the event rather than the table, so two drafts never queue behind
 * each other.
 *
 * `src/lib/__tests__/draft-concurrency.test.ts` fires the overlapping calls and
 * asserts the outcome — and, to prove the harness can actually produce the bug,
 * runs a deliberately naive implementation of each alongside and watches it
 * fail. One of those controls is the *old* storage model, a bids blob rewritten
 * whole, which is precisely why this schema is rows.
 *
 * ## What is deliberately not stored
 *
 * A team's remaining balance. It is derived from the awarded lots on every
 * read (`balanceFor`), so it cannot disagree with the history — which matters
 * most at the one moment a stored copy would be wrong, immediately after an
 * undo. See the note at the top of `./draft-policy`.
 */

import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  type Database,
  type DraftBid,
  type DraftLot,
  type DraftPoolEntry,
  type DraftPoolKind,
  type DraftSpin,
  type EventRow,
  type Team,
  type TeamMember,
  applications,
  db as defaultDb,
  draftBids,
  draftConfigs,
  draftLots,
  draftPoolEntries,
  events,
  teamMembers,
  teams,
  users,
} from "@/db";
import {
  type AwardedLotView,
  type DraftCompletion,
  type DraftConfig,
  type DraftPhase,
  type DraftRole,
  type DraftSnapshot,
  type DraftView,
  type DraftViewer,
  type LotResolution,
  type OpenLot,
  type PoolPlayer,
  type RosterState,
  type SettledLot,
  type TeamMemberView,
  type TeamStanding,
  MAX_TEAMS,
  SPIN_DURATION_MS,
  SPIN_TURNS,
  balanceFor,
  canPlaceBid,
  draftComplete,
  draftConfigFrom,
  maxBidFor,
  redactDraft,
  resolveLot,
  rosterState,
} from "./draft-policy";
import type { EventResult } from "./events";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * The same discriminated result `./events` returns, and deliberately the same
 * type rather than a twin of it: the callers are forms, and a form wants one
 * shape to branch on however many modules it talks to.
 */
export type DraftResult<T = null> = EventResult<T>;

function fail(error: string, errors?: Record<string, string>): {
  ok: false;
  error: string;
  errors?: Record<string, string>;
} {
  return errors ? { ok: false, error, errors } : { ok: false, error };
}

function withData<T>(data: T): DraftResult<T> {
  return { ok: true, data };
}

const NAME_MAX = 60;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/* ------------------------------------------------------------------ */
/* Small shared reads                                                 */
/* ------------------------------------------------------------------ */

async function readEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

/**
 * Read the event **and take its row lock**, so everything that follows in this
 * transaction is the only thing spending this draft's money.
 */
async function lockEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function readConfig(database: Database, eventId: string): Promise<DraftConfig> {
  const [row] = await database
    .select()
    .from(draftConfigs)
    .where(eq(draftConfigs.eventId, eventId))
    .limit(1);
  return draftConfigFrom(row ?? null);
}

async function readTeams(database: Database, eventId: string): Promise<Team[]> {
  return database
    .select()
    .from(teams)
    .where(eq(teams.eventId, eventId))
    .orderBy(asc(teams.sort), asc(teams.createdAt));
}

async function readMembers(database: Database, eventId: string): Promise<TeamMember[]> {
  return database
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(desc(teamMembers.isCaptain), asc(teamMembers.acquiredAt));
}

async function readPool(database: Database, eventId: string): Promise<DraftPoolEntry[]> {
  return database
    .select()
    .from(draftPoolEntries)
    .where(eq(draftPoolEntries.eventId, eventId))
    .orderBy(asc(draftPoolEntries.sort), asc(draftPoolEntries.addedAt));
}

async function readLots(database: Database, eventId: string): Promise<DraftLot[]> {
  return database
    .select()
    .from(draftLots)
    .where(eq(draftLots.eventId, eventId))
    .orderBy(desc(draftLots.openedAt), desc(draftLots.id));
}

async function readOpenLot(database: Database, eventId: string): Promise<DraftLot | null> {
  const [row] = await database
    .select()
    .from(draftLots)
    .where(and(eq(draftLots.eventId, eventId), eq(draftLots.status, "open")))
    .limit(1);
  return row ?? null;
}

async function readBids(database: Database, lotId: string): Promise<DraftBid[]> {
  return database
    .select()
    .from(draftBids)
    .where(eq(draftBids.lotId, lotId))
    .orderBy(asc(draftBids.placedAt));
}

function asMemberViews(rows: readonly TeamMember[]): TeamMemberView[] {
  return rows.map((row) => ({
    teamId: row.teamId,
    userId: row.userId,
    price: row.price,
    isCaptain: row.isCaptain,
  }));
}

function asLotViews(rows: readonly DraftLot[]): AwardedLotView[] {
  return rows.map((row) => ({
    status: row.status,
    winnerTeamId: row.winnerTeamId,
    price: row.price,
  }));
}

/** The next `sort` at the back of one pool. */
function nextSort(entries: readonly DraftPoolEntry[], kind: DraftPoolKind): number {
  let highest = -1;
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    if (entry.sort > highest) highest = entry.sort;
  }
  return highest + 1;
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/* ------------------------------------------------------------------ */

export type TeamInput = {
  /** Present for a team that already exists; absent creates one. */
  id?: string;
  name: string;
  seed?: number | null;
  /** Only read when the config's balance mode is `per_team`. */
  balanceStart?: number;
};

export type SetTeamsResult = {
  teams: Team[];
  /** Teams the list dropped. */
  removed: number;
};

/**
 * Write the whole team list for an event.
 *
 * The list is authoritative: a team whose id is absent is removed — unless it
 * has a draft history, in which case the write is refused rather than quietly
 * shredding somebody's roster and the prices they paid. checklist.md's standing
 * rule is that nothing is destructive, and a team that has won lots is a
 * completed part of the record.
 *
 * The **maximum** of eight teams (§8.1) is enforced here; the minimum of two is
 * not, because an admin types the names one at a time and being told "you need
 * two teams" while typing the first one is the sort of validation that makes
 * people stop using a form. Two is a publish-time question.
 *
 * Balances follow the config: under `uniform` every team starts on the event's
 * default and any per-team number in the input is ignored, because a mode that
 * says the balances are equal and a form that says otherwise is a
 * disagreement, and the mode should win.
 */
export async function setTeams(
  eventId: string,
  input: readonly TeamInput[],
  database: Database = defaultDb
): Promise<DraftResult<SetTeamsResult>> {
  if (input.length > MAX_TEAMS) {
    return fail(`An event can have at most ${MAX_TEAMS} teams.`);
  }

  return database.transaction(async (tx) => {
    const event = await readEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const config = await readConfig(tx, eventId);
    const existing = await readTeams(tx, eventId);
    const existingIds = new Set(existing.map((team) => team.id));

    const errors: Record<string, string> = {};
    const cleaned: Array<{
      id: string;
      name: string;
      seed: number | null;
      balanceStart: number;
      sort: number;
    }> = [];
    const names = new Set<string>();

    for (const [index, team] of input.entries()) {
      const at = team.id ?? `new-${index}`;

      if (team.id && !existingIds.has(team.id)) {
        errors[at] = "That team belongs to a different event.";
        continue;
      }

      const name = cleanText(team.name, NAME_MAX);
      if (!name) {
        errors[at] = "Give the team a name.";
        continue;
      }
      if (names.has(name.toLowerCase())) {
        errors[at] = "Two teams cannot share a name.";
        continue;
      }
      names.add(name.toLowerCase());

      const wanted =
        config.balanceMode === "per_team"
          ? (team.balanceStart ?? config.defaultBalance)
          : config.defaultBalance;
      if (!Number.isInteger(wanted) || wanted < 0) {
        errors[at] = "A starting balance has to be a whole number, and not negative.";
        continue;
      }

      cleaned.push({
        id: team.id ?? "",
        name,
        seed: team.seed ?? null,
        balanceStart: wanted,
        sort: index,
      });
    }

    if (Object.keys(errors).length > 0) {
      return fail("Some of those teams need another look.", errors);
    }

    const keeping = new Set(cleaned.map((team) => team.id).filter(Boolean));
    const doomed = existing.filter((team) => !keeping.has(team.id));

    if (doomed.length > 0) {
      const lots = await tx
        .select({ winnerTeamId: draftLots.winnerTeamId })
        .from(draftLots)
        .where(
          inArray(
            draftLots.winnerTeamId,
            doomed.map((team) => team.id)
          )
        );
      if (lots.length > 0) {
        const held = new Set(lots.map((row) => row.winnerTeamId));
        const named = doomed
          .filter((team) => held.has(team.id))
          .map((team) => team.name)
          .join(", ");
        return fail(
          `${named} has already drafted players, so removing the team would erase what they paid. Void those lots first.`
        );
      }
      await tx.delete(teams).where(
        inArray(
          teams.id,
          doomed.map((team) => team.id)
        )
      );
    }

    // Names are unique per event, so swapping two of them in place trips the
    // constraint halfway through a perfectly legal rewrite. Parking every
    // survivor on a name nobody can type sidesteps it without dropping rows —
    // the same two-pass `setEventQuestions` uses for question keys.
    for (const team of existing) {
      if (!keeping.has(team.id)) continue;
      await tx
        .update(teams)
        .set({ name: `tmp-${team.id}` })
        .where(eq(teams.id, team.id));
    }

    for (const team of cleaned) {
      const values = {
        name: team.name,
        seed: team.seed,
        balanceStart: team.balanceStart,
        sort: team.sort,
      };
      if (team.id) {
        await tx.update(teams).set(values).where(eq(teams.id, team.id));
      } else {
        await tx.insert(teams).values({ eventId, ...values });
      }
    }

    return withData({ teams: await readTeams(tx, eventId), removed: doomed.length });
  });
}

export type CaptainInput = {
  teamId: string;
  /** Null clears the captaincy and frees the roster slot. */
  userId: string | null;
};

export type SetCaptainsResult = {
  teams: Team[];
  members: TeamMember[];
};

/**
 * Choose who leads each team.
 *
 * §14 settles what a captain *is*: a `team_members` row with `is_captain` true
 * and `price` 0, occupying a roster slot, never in the draft pool. So this
 * writes two things at once — the column on `teams` and the roster row — and
 * pulls the new captain out of the pool if they were sitting in it.
 *
 * A captain must be an **accepted applicant**. That is not a wall: §8.3's
 * override lives one layer up, in `setApplicationStatus`, so an admin who wants
 * somebody unusual to captain accepts them first and the intent is recorded
 * where it belongs rather than as a silent exception here.
 *
 * The whole assignment is applied in two passes because one person cannot lead
 * two teams: swapping two captains has to clear both before setting either, or
 * the unique constraint fires halfway through a legal change.
 */
export async function setCaptains(
  eventId: string,
  input: readonly CaptainInput[],
  database: Database = defaultDb
): Promise<DraftResult<SetCaptainsResult>> {
  return database.transaction(async (tx) => {
    const event = await readEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const eventTeams = await readTeams(tx, eventId);
    const byId = new Map(eventTeams.map((team) => [team.id, team]));

    const errors: Record<string, string> = {};
    const wanted = new Map<string, string | null>();
    const claimed = new Set<string>();

    for (const assignment of input) {
      if (!byId.has(assignment.teamId)) {
        errors[assignment.teamId] = "That team belongs to a different event.";
        continue;
      }
      if (wanted.has(assignment.teamId)) {
        errors[assignment.teamId] = "That team is named twice.";
        continue;
      }
      if (assignment.userId !== null && claimed.has(assignment.userId)) {
        errors[assignment.teamId] = "One person cannot captain two teams.";
        continue;
      }
      if (assignment.userId !== null) claimed.add(assignment.userId);
      wanted.set(assignment.teamId, assignment.userId);
    }

    const userIds = [...claimed];
    if (userIds.length > 0) {
      const accepted = await tx
        .select({ userId: applications.userId })
        .from(applications)
        .where(
          and(
            eq(applications.eventId, eventId),
            eq(applications.status, "accepted"),
            inArray(applications.userId, userIds)
          )
        );
      const ok = new Set(accepted.map((row) => row.userId));

      const alreadyDrafted = await tx
        .select({
          userId: teamMembers.userId,
          teamId: teamMembers.teamId,
          isCaptain: teamMembers.isCaptain,
        })
        .from(teamMembers)
        .where(
          and(eq(teamMembers.eventId, eventId), inArray(teamMembers.userId, userIds))
        );
      // A captaincy this write is about to clear is not "already drafted": two
      // captains exchanging teams would otherwise each block the other.
      const reassigned = new Set(wanted.keys());
      const drafted = new Map(
        alreadyDrafted
          .filter((row) => !(row.isCaptain && reassigned.has(row.teamId)))
          .map((row) => [row.userId, row.teamId])
      );

      for (const [teamId, userId] of wanted) {
        if (userId === null) continue;
        if (!ok.has(userId)) {
          errors[teamId] =
            "A captain has to be an accepted applicant. Accept them on the Applicants tab first.";
          continue;
        }
        const on = drafted.get(userId);
        if (on !== undefined && on !== teamId) {
          errors[teamId] = "That player has already been drafted by another team.";
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      return fail("Some of those captains need another look.", errors);
    }

    const touched = [...wanted.keys()];
    if (touched.length === 0) {
      return withData({
        teams: eventTeams,
        members: await readMembers(tx, eventId),
      });
    }

    // Pass one: clear. Both the column and the roster row, so a captaincy that
    // moves does not leave the old holder occupying a slot on the old team.
    await tx
      .update(teams)
      .set({ captainUserId: null })
      .where(inArray(teams.id, touched));
    await tx
      .delete(teamMembers)
      .where(and(inArray(teamMembers.teamId, touched), eq(teamMembers.isCaptain, true)));

    // Pass two: set.
    for (const [teamId, userId] of wanted) {
      if (userId === null) continue;
      await tx.update(teams).set({ captainUserId: userId }).where(eq(teams.id, teamId));
      await tx
        .insert(teamMembers)
        .values({ teamId, eventId, userId, price: 0, isCaptain: true, lotId: null })
        .onConflictDoUpdate({
          target: [teamMembers.teamId, teamMembers.userId],
          set: { isCaptain: true, price: 0, lotId: null },
        });
      // §14: a captain never enters the pool.
      await tx
        .delete(draftPoolEntries)
        .where(
          and(eq(draftPoolEntries.eventId, eventId), eq(draftPoolEntries.userId, userId))
        );
    }

    return withData({
      teams: await readTeams(tx, eventId),
      members: await readMembers(tx, eventId),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

export type SetDraftConfigResult = {
  config: DraftConfig;
  /** Teams whose starting balance the change rewrote. */
  rebalanced: number;
};

/** The rules for this event, or the defaults when it has never been configured. */
export async function getDraftConfig(
  eventId: string,
  database: Database = defaultDb
): Promise<DraftConfig> {
  return readConfig(database, eventId);
}

/**
 * Write the draft rules. Only the keys present in `patch` change.
 *
 * One side effect is deliberate and worth knowing about: under a `uniform`
 * balance mode, changing the default balance rewrites every team's starting
 * balance, because a mode that says "everybody has the same" and a set of teams
 * that disagree is not a state worth being able to reach. It refuses to do so
 * **once a lot has been awarded**, since moving the starting line mid-draft
 * would silently rewrite what every team can still afford.
 */
export async function setDraftConfig(
  eventId: string,
  patch: Partial<DraftConfig>,
  database: Database = defaultDb
): Promise<DraftResult<SetDraftConfigResult>> {
  return database.transaction(async (tx) => {
    const event = await readEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const current = await readConfig(tx, eventId);
    const next = draftConfigFrom({ ...current, ...patch });

    const awarded = await tx
      .select({ id: draftLots.id })
      .from(draftLots)
      .where(and(eq(draftLots.eventId, eventId), eq(draftLots.status, "awarded")))
      .limit(1);
    const started = awarded.length > 0;

    if (started && next.rosterTarget < current.rosterTarget) {
      return fail(
        "The draft has already awarded players, so the roster size cannot be lowered now."
      );
    }

    await tx
      .insert(draftConfigs)
      .values({ eventId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: draftConfigs.eventId,
        set: { ...next, updatedAt: new Date() },
      });

    let rebalanced = 0;
    if (next.balanceMode === "uniform" && !started) {
      const stale = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.eventId, eventId), ne(teams.balanceStart, next.defaultBalance)));
      if (stale.length > 0) {
        await tx
          .update(teams)
          .set({ balanceStart: next.defaultBalance })
          .where(
            inArray(
              teams.id,
              stale.map((team) => team.id)
            )
          );
        rebalanced = stale.length;
      }
    }

    return withData({ config: next, rebalanced });
  });
}

/* ------------------------------------------------------------------ */
/* The pool                                                           */
/* ------------------------------------------------------------------ */

export type SetDraftPoolInput = {
  /**
   * The exact list. Absent seeds it from the event's accepted applications, in
   * the order they applied — which is what the admin screen does on first open.
   */
  userIds?: readonly string[];
  /** Leave anybody already sitting in the reserve pool where they are. */
  keepReserve?: boolean;
};

export type SetDraftPoolResult = {
  main: number;
  reserve: number;
  added: string[];
  removed: string[];
};

/**
 * Write the draft pool.
 *
 * Seeded from the accepted applications and **excluding captains and anyone
 * already on a roster** — §14's rule that a captain never enters the pool, plus
 * the obvious one that a player already bought is not still for sale.
 *
 * Existing rows are kept rather than replaced, so somebody who has been moved
 * to the reserve pool stays there across a reseed (`keepReserve`, on by
 * default). Anyone on the block right now cannot be removed: settle their lot
 * first, or the open lot would point at a player who is no longer in the draft.
 */
export async function setDraftPool(
  eventId: string,
  input: SetDraftPoolInput = {},
  database: Database = defaultDb
): Promise<DraftResult<SetDraftPoolResult>> {
  return database.transaction(async (tx) => {
    const event = await readEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const members = await readMembers(tx, eventId);
    const drafted = new Set(members.map((member) => member.userId));

    let candidates: string[];
    if (input.userIds) {
      const seen = new Set<string>();
      candidates = [];
      for (const userId of input.userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        candidates.push(userId);
      }

      const known = await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, candidates.length > 0 ? candidates : [eventId]));
      const knownIds = new Set(known.map((row) => row.id));
      const stranger = candidates.find((userId) => !knownIds.has(userId));
      if (stranger) return fail("We do not have an account for one of those players.");
    } else {
      const accepted = await tx
        .select({ userId: applications.userId })
        .from(applications)
        .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")))
        .orderBy(asc(applications.submittedAt), asc(applications.id));
      candidates = accepted.map((row) => row.userId);
    }

    const target = candidates.filter((userId) => !drafted.has(userId));
    const targetSet = new Set(target);

    const existing = await readPool(tx, eventId);
    const existingByUser = new Map(existing.map((entry) => [entry.userId, entry]));

    const openLot = await readOpenLot(tx, eventId);
    if (openLot && !targetSet.has(openLot.playerUserId) && existingByUser.has(openLot.playerUserId)) {
      return fail("Somebody is on the block. Settle that lot before changing the pool.");
    }

    const removed = existing
      .filter((entry) => !targetSet.has(entry.userId))
      .map((entry) => entry.userId);
    if (removed.length > 0) {
      await tx
        .delete(draftPoolEntries)
        .where(
          and(
            eq(draftPoolEntries.eventId, eventId),
            inArray(draftPoolEntries.userId, removed)
          )
        );
    }

    const keepReserve = input.keepReserve !== false;
    const added: string[] = [];
    let mainSort = 0;

    for (const userId of target) {
      const entry = existingByUser.get(userId);
      const kind: DraftPoolKind = entry && keepReserve ? entry.kind : "main";
      if (entry) {
        await tx
          .update(draftPoolEntries)
          .set({ kind, sort: kind === "main" ? mainSort : entry.sort })
          .where(eq(draftPoolEntries.id, entry.id));
      } else {
        await tx.insert(draftPoolEntries).values({ eventId, userId, kind: "main", sort: mainSort });
        added.push(userId);
      }
      if (kind === "main") mainSort += 1;
    }

    const written = await readPool(tx, eventId);
    return withData({
      main: written.filter((entry) => entry.kind === "main").length,
      reserve: written.filter((entry) => entry.kind === "reserve").length,
      added,
      removed,
    });
  });
}

/** The pool as it stands, both halves, in wheel order. */
export async function getDraftPool(
  eventId: string,
  database: Database = defaultDb
): Promise<{ main: PoolPlayer[]; reserve: PoolPlayer[] }> {
  const rows = await readPool(database, eventId);
  const asPlayer = (entry: DraftPoolEntry): PoolPlayer => ({
    userId: entry.userId,
    kind: entry.kind,
    sort: entry.sort,
  });
  return {
    main: rows.filter((entry) => entry.kind === "main").map(asPlayer),
    reserve: rows.filter((entry) => entry.kind === "reserve").map(asPlayer),
  };
}

/**
 * Move one player between the main and reserve pools before the draft reaches
 * them — the admin deciding up front that somebody is held over.
 *
 * This is deliberately not the same act as `moveToReserve`, which closes an open
 * lot and belongs in the history because it happened *during* the draft, in
 * front of everyone. Setting up the pool beforehand is bookkeeping and should
 * leave no lot behind; composing the two would record a spin that never
 * happened and cost two transactions to undo.
 *
 * A no-op when the player is already in that pool. Refuses anyone who has
 * already been drafted, since their place is a roster row, not a pool entry.
 */
export async function setPoolKind(
  eventId: string,
  userId: string,
  kind: DraftPoolKind,
  database: Database = defaultDb
): Promise<DraftResult<{ main: PoolPlayer[]; reserve: PoolPlayer[]; moved: boolean }>> {
  return database.transaction(async (tx) => {
    const event = await readEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const entries = await readPool(tx, eventId);
    const entry = entries.find((row) => row.userId === userId);
    if (!entry) {
      const [member] = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
        .limit(1);
      return fail(
        member
          ? "That player is already on a team. Undo the lot that put them there first."
          : "That player is not in this draft's pool."
      );
    }

    if (entry.kind !== kind) {
      await tx
        .update(draftPoolEntries)
        .set({ kind, sort: nextSort(entries, kind) })
        .where(eq(draftPoolEntries.id, entry.id));
    }

    const pool = await getDraftPool(eventId, tx);
    return withData({ ...pool, moved: entry.kind !== kind });
  });
}

/* ------------------------------------------------------------------ */
/* Lots                                                               */
/* ------------------------------------------------------------------ */

export type OpenLotInput = {
  /** Put this player up. Absent, the wheel picks one from `kind`. */
  userId?: string;
  /** Which pool to draw from. Absent: main while it has anyone, else reserve. */
  kind?: DraftPoolKind;
  openedBy?: string | null;
  now?: Date;
  /**
   * Where the wheel lands, injected so a test can pin a spin. Defaults to
   * `crypto.randomInt`, which is the same source the current board uses.
   */
  pick?: (length: number) => number;
};

/** Where the wheel lands. `crypto.randomInt`, as the current board uses. */
function defaultPick(length: number): number {
  return randomInt(0, length);
}

/**
 * Put a player on the block.
 *
 * The player **stays in the pool** until the lot settles, exactly as the
 * current board leaves them on the wheel until the admin awards or discards
 * them: an abandoned lot then costs nothing to unwind.
 *
 * A spin is recorded in full — the pool as it stood, the landing index, the
 * start instant, the duration and the turn count — which is what lets every
 * browser draw the same wheel at the same angle, and lets one that opens late
 * replay it rather than guess.
 *
 * Only one lot may be open per event. That is checked here *and* enforced by a
 * partial unique index, because two admins clicking spin at the same moment is
 * a race no screen can see.
 */
export async function openLot(
  eventId: string,
  input: OpenLotInput = {},
  database: Database = defaultDb
): Promise<DraftResult<DraftLot>> {
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const already = await readOpenLot(tx, eventId);
    if (already) return fail("Somebody is already on the block. Settle that lot first.");

    const config = await readConfig(tx, eventId);
    const pool = await readPool(tx, eventId);
    const main = pool.filter((entry) => entry.kind === "main");
    const reserve = pool.filter((entry) => entry.kind === "reserve");

    const kind: DraftPoolKind =
      input.kind ?? (main.length > 0 ? "main" : config.reserveEnabled ? "reserve" : "main");
    if (kind === "reserve" && !config.reserveEnabled) {
      return fail("The reserve pool is switched off for this event.");
    }

    const candidates = kind === "main" ? main : reserve;
    if (candidates.length === 0) return fail("That pool is empty.");

    let index: number;
    if (input.userId) {
      index = candidates.findIndex((entry) => entry.userId === input.userId);
      if (index === -1) return fail("That player is not in that pool.");
    } else if (config.selectionMode === "fixed_order") {
      index = 0;
    } else if (config.selectionMode === "admin_pick") {
      return fail("This draft is set to admin picks, so name the player.");
    } else {
      const pick = input.pick ?? defaultPick;
      index = pick(candidates.length);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        return fail("The wheel landed outside the pool, which should be impossible.");
      }
    }

    const chosen = candidates[index];
    const spin: DraftSpin | null =
      config.selectionMode === "wheel" && !input.userId
        ? {
            pool: candidates.map((entry) => entry.userId),
            targetIndex: index,
            startedAt: now.getTime(),
            durationMs: SPIN_DURATION_MS,
            turns: SPIN_TURNS,
          }
        : null;

    const [lot] = await tx
      .insert(draftLots)
      .values({
        eventId,
        playerUserId: chosen.userId,
        status: "open",
        fromKind: kind,
        openedAt: now,
        openedBy: input.openedBy ?? null,
        spin,
      })
      .returning();

    return withData(lot);
  });
}

export type PlaceBidResult = {
  bid: DraftBid;
  /** The team's balance, unchanged — a bid is a promise, not a payment. */
  balance: number;
  /** Their cap, so the panel can show what is left to play with. */
  max: number;
};

/**
 * A captain's bid on the open lot.
 *
 * Everything this decides — the balance, the roster, the standing bid, the cap
 * — is read inside the event's row lock and written inside it too. Splitting
 * those apart is how two overlapping bids end up merged into one, or how a bid
 * gets checked against a balance that changed while it was being checked.
 *
 * A sealed bid is final: the unique index on (lot, team) means a double-clicked
 * submit cannot produce two, and the check above it means the second click gets
 * a sentence rather than a constraint violation. Open bidding raises the same
 * row, so "what did they bid" never needs a max over a history.
 */
export async function placeBid(
  lotId: string,
  teamId: string,
  amount: number,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<PlaceBidResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    // Re-read inside the lock: between the peek and the lock somebody else's
    // transaction may have awarded it.
    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, lot.eventId)))
      .limit(1);
    if (!team) return fail("That team is not in this draft.");

    const config = await readConfig(tx, lot.eventId);
    const members = await readMembers(tx, lot.eventId);
    const lots = await readLots(tx, lot.eventId);
    const bids = await readBids(tx, lotId);

    const balance = balanceFor(team, asLotViews(lots));
    const roster = rosterState(team, asMemberViews(members), config);

    const check = canPlaceBid(
      { id: team.id, balance },
      amount,
      {
        status: lot.status,
        openedAt: lot.openedAt,
        bids: bids.map((bid) => ({ teamId: bid.teamId, amount: bid.amount })),
      },
      config,
      roster,
      now
    );
    if (!check.ok) return fail(check.message);

    const [written] = await tx
      .insert(draftBids)
      .values({ lotId, teamId, amount, placedAt: now })
      .onConflictDoUpdate({
        target: [draftBids.lotId, draftBids.teamId],
        set: { amount, placedAt: now },
      })
      .returning();

    return withData({ bid: written, balance, max: check.max });
  });
}

/** Take a bid back off a lot. Admin only — a captain's bid is their word. */
export async function clearBid(
  lotId: string,
  teamId: string,
  database: Database = defaultDb
): Promise<DraftResult<{ cleared: boolean }>> {
  return database.transaction(async (tx) => {
    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");

    const removed = await tx
      .delete(draftBids)
      .where(and(eq(draftBids.lotId, lotId), eq(draftBids.teamId, teamId)))
      .returning({ id: draftBids.id });

    return withData({ cleared: removed.length > 0 });
  });
}

export type AwardLotResult = {
  lot: DraftLot;
  member: TeamMember;
  /** What the winning team has left afterwards. */
  balance: number;
};

/**
 * Give the player to a team at their bid.
 *
 * The price is the team's own bid, never a number the caller supplies: an
 * admin who wants a different figure should clear the bid and have it placed
 * again, so the amount on the record is always one a captain actually offered.
 * Breaking a tie is therefore naming the team, which is exactly what
 * `resolveLot` asks an admin to do.
 *
 * Deducting exactly once is not enforced by arithmetic here — nothing is
 * decremented. The lot *is* the deduction, and `balanceFor` sums the awarded
 * ones. Two concurrent awards of the same lot cannot both land because the
 * second finds it already settled, inside the same lock.
 */
export async function awardLot(
  lotId: string,
  teamId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<AwardLotResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, lot.eventId)))
      .limit(1);
    if (!team) return fail("That team is not in this draft.");

    const bids = await readBids(tx, lotId);
    const bid = bids.find((row) => row.teamId === teamId);
    if (!bid) return fail(`${team.name} has not bid on this player.`);

    const config = await readConfig(tx, lot.eventId);
    const members = await readMembers(tx, lot.eventId);
    const lots = await readLots(tx, lot.eventId);

    if (members.some((member) => member.userId === lot.playerUserId)) {
      return fail("That player has already been drafted.");
    }

    const balance = balanceFor(team, asLotViews(lots));
    const roster = rosterState(team, asMemberViews(members), config);

    if (roster.slotsLeft <= 0) return fail(`${team.name}'s roster is already full.`);
    if (bid.amount > balance) {
      return fail(`${team.name} cannot cover that bid — they have ${balance}.`);
    }
    const cap = maxBidFor({ balance }, config, roster);
    if (bid.amount > cap) {
      return fail(
        `${team.name} can spend at most ${cap} here and still fill their roster.`
      );
    }

    const [awarded] = await tx
      .update(draftLots)
      .set({
        status: "awarded",
        winnerTeamId: teamId,
        price: bid.amount,
        closedAt: now,
        closedBy: options.closedBy ?? null,
      })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!awarded) return fail("That lot settled while you were looking at it.");

    const [member] = await tx
      .insert(teamMembers)
      .values({
        teamId,
        eventId: lot.eventId,
        userId: lot.playerUserId,
        price: bid.amount,
        acquiredAt: now,
        isCaptain: false,
        lotId,
      })
      .returning();

    await tx
      .delete(draftPoolEntries)
      .where(
        and(
          eq(draftPoolEntries.eventId, lot.eventId),
          eq(draftPoolEntries.userId, lot.playerUserId)
        )
      );

    return withData({ lot: awarded, member, balance: balance - bid.amount });
  });
}

/** Take the player out of the draft entirely. Nobody wanted them, or a misclick. */
export async function discardLot(
  lotId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<DraftLot>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");

    const [closed] = await tx
      .update(draftLots)
      .set({ status: "discarded", closedAt: now, closedBy: options.closedBy ?? null })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!closed) return fail("That lot settled while you were looking at it.");

    await tx
      .delete(draftPoolEntries)
      .where(
        and(
          eq(draftPoolEntries.eventId, lot.eventId),
          eq(draftPoolEntries.userId, lot.playerUserId)
        )
      );

    return withData(closed);
  });
}

/**
 * Send the player round again later.
 *
 * They go to the back of the reserve pool rather than out of the draft, which
 * is the point of the second wheel: the names that went for nothing the first
 * time get another chance once the money is spent.
 */
export async function moveToReserve(
  lotId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<DraftLot>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");

    const config = await readConfig(tx, lot.eventId);
    if (!config.reserveEnabled) return fail("The reserve pool is switched off for this event.");
    if (lot.fromKind === "reserve") return fail("That player is already in the reserve pool.");

    const [closed] = await tx
      .update(draftLots)
      .set({ status: "reserved", closedAt: now, closedBy: options.closedBy ?? null })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!closed) return fail("That lot settled while you were looking at it.");

    const pool = await readPool(tx, lot.eventId);
    await tx
      .insert(draftPoolEntries)
      .values({
        eventId: lot.eventId,
        userId: lot.playerUserId,
        kind: "reserve",
        sort: nextSort(pool, "reserve"),
      })
      .onConflictDoUpdate({
        target: [draftPoolEntries.eventId, draftPoolEntries.userId],
        set: { kind: "reserve", sort: nextSort(pool, "reserve") },
      });

    return withData(closed);
  });
}

export type VoidLotResult = {
  lot: DraftLot;
  /** The balance the winning team gets back. Null when nothing was awarded. */
  refunded: number | null;
  /** Where the player was put back. Null when they stayed where they were. */
  returnedTo: DraftPoolKind | null;
};

/**
 * Undo a lot.
 *
 * The row is **not deleted**. Its winner and its price stay exactly as they
 * were and the status becomes `voided`, so the history can say what was undone
 * and by whom — checklist.md's standing rule is that nothing is destructive,
 * and "the price is gone and so is any record there was one" is the worst
 * possible reading of an undo.
 *
 * Everything derived then simply ignores it: `balanceFor` skips voided lots, so
 * the money comes back without a single number being written, which is the
 * whole reason the remaining balance is not a column. The roster row goes,
 * because a roster is a set of people rather than a history, and the player
 * returns to the pool they were drawn from.
 *
 * Voiding an *open* lot is the current board's "cancel": the player never left
 * the pool, so nothing needs putting back.
 */
export async function voidLot(
  lotId: string,
  options: { voidedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<VoidLotResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status === "voided") return fail("That lot has already been voided.");

    const refunded = lot.status === "awarded" ? (lot.price ?? 0) : null;

    if (lot.status === "awarded") {
      await tx.delete(teamMembers).where(eq(teamMembers.lotId, lotId));
    }

    let returnedTo: DraftPoolKind | null = null;
    if (lot.status === "awarded" || lot.status === "discarded" || lot.status === "reserved") {
      const pool = await readPool(tx, lot.eventId);
      returnedTo = lot.fromKind;
      await tx
        .insert(draftPoolEntries)
        .values({
          eventId: lot.eventId,
          userId: lot.playerUserId,
          kind: returnedTo,
          sort: nextSort(pool, returnedTo),
        })
        .onConflictDoUpdate({
          target: [draftPoolEntries.eventId, draftPoolEntries.userId],
          set: { kind: returnedTo, sort: nextSort(pool, returnedTo) },
        });
    }

    const [voided] = await tx
      .update(draftLots)
      .set({ status: "voided", voidedAt: now, voidedBy: options.voidedBy ?? null })
      .where(and(eq(draftLots.id, lotId), ne(draftLots.status, "voided")))
      .returning();
    if (!voided) return fail("That lot was voided while you were looking at it.");

    return withData({ lot: voided, refunded, returnedTo });
  });
}

/**
 * Undo the most recent lot — the admin's one-button undo.
 *
 * "Most recent" is by the moment it opened, so a run of lots unwinds in the
 * order it was drafted however long each one took to settle.
 */
export async function voidLastLot(
  eventId: string,
  options: { voidedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<VoidLotResult>> {
  const [last] = await database
    .select()
    .from(draftLots)
    .where(and(eq(draftLots.eventId, eventId), ne(draftLots.status, "voided")))
    .orderBy(desc(draftLots.openedAt), desc(draftLots.id))
    .limit(1);
  if (!last) return fail("There is nothing to undo.");
  return voidLot(last.id, options, database);
}

/* ------------------------------------------------------------------ */
/* Reads                                                              */
/* ------------------------------------------------------------------ */

export type TeamWithRoster = Team & {
  members: TeamMember[];
  /** Derived from the awarded lots, never stored. */
  balance: number;
  roster: RosterState;
};

/** Every team with its roster, balance and how many slots are left. */
export async function getTeams(
  eventId: string,
  database: Database = defaultDb
): Promise<TeamWithRoster[]> {
  const [config, rows, members, lots] = await Promise.all([
    readConfig(database, eventId),
    readTeams(database, eventId),
    readMembers(database, eventId),
    readLots(database, eventId),
  ]);
  const memberViews = asMemberViews(members);
  const lotViews = asLotViews(lots);

  return rows.map((team) => ({
    ...team,
    members: members.filter((member) => member.teamId === team.id),
    balance: balanceFor(team, lotViews),
    roster: rosterState(team, memberViews, config),
  }));
}

/** Every lot ever opened for this event, newest first. */
export async function getDraftHistory(
  eventId: string,
  database: Database = defaultDb
): Promise<DraftLot[]> {
  return readLots(database, eventId);
}

/** Who won the open lot, or that it is tied. Admin-facing; never redacted. */
export async function getOpenLotResolution(
  eventId: string,
  database: Database = defaultDb
): Promise<LotResolution | null> {
  const lot = await readOpenLot(database, eventId);
  if (!lot) return null;
  const bids = await readBids(database, lot.id);
  return resolveLot(bids.map((bid) => ({ teamId: bid.teamId, amount: bid.amount })));
}

/**
 * The whole draft, unredacted.
 *
 * Nothing renders this directly — `getDraftView` puts it through
 * `redactDraft` first. It is separate because the redaction is a pure function
 * and deserves to be tested as one, over a snapshot a test can build by hand.
 */
export async function getDraftSnapshot(
  eventId: string,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftSnapshot | null> {
  const event = await readEvent(database, eventId);
  if (!event) return null;

  const now = (options.now ?? new Date()).getTime();
  const [config, teamRows, memberRows, lotRows, poolRows] = await Promise.all([
    readConfig(database, eventId),
    readTeams(database, eventId),
    readMembers(database, eventId),
    readLots(database, eventId),
    readPool(database, eventId),
  ]);

  const memberViews = asMemberViews(memberRows);
  const lotViews = asLotViews(lotRows);
  const openRow = lotRows.find((lot) => lot.status === "open") ?? null;
  const bidRows = openRow ? await readBids(database, openRow.id) : [];

  const standings: TeamStanding[] = teamRows.map((team) => {
    const balance = balanceFor(team, lotViews);
    const roster = rosterState(team, memberViews, config);
    const bid = bidRows.find((row) => row.teamId === team.id) ?? null;
    return {
      id: team.id,
      name: team.name,
      captainUserId: team.captainUserId,
      balanceStart: team.balanceStart,
      seed: team.seed,
      sort: team.sort,
      balance,
      roster,
      members: memberViews.filter((member) => member.teamId === team.id),
      maxBid: maxBidFor({ balance }, config, roster),
      bid: bid ? bid.amount : null,
    };
  });

  const main = poolRows.filter((entry) => entry.kind === "main");
  const reserve = poolRows.filter((entry) => entry.kind === "reserve");
  const asPlayer = (entry: DraftPoolEntry): PoolPlayer => ({
    userId: entry.userId,
    kind: entry.kind,
    sort: entry.sort,
  });

  const lot: OpenLot | null = openRow
    ? {
        id: openRow.id,
        playerUserId: openRow.playerUserId,
        fromKind: openRow.fromKind,
        openedAt: openRow.openedAt.getTime(),
        spin: openRow.spin ?? null,
        bids: bidRows.map((bid) => ({
          teamId: bid.teamId,
          amount: bid.amount,
          placedAt: bid.placedAt.getTime(),
        })),
        endsAt:
          config.bidTimerSeconds === null
            ? null
            : openRow.openedAt.getTime() + config.bidTimerSeconds * 1000,
      }
    : null;

  const history: SettledLot[] = lotRows
    .filter((row) => row.status !== "open")
    .map((row) => ({
      id: row.id,
      playerUserId: row.playerUserId,
      status: row.status,
      fromKind: row.fromKind,
      winnerTeamId: row.winnerTeamId,
      price: row.price,
      closedAt: row.closedAt ? row.closedAt.getTime() : null,
      voidedAt: row.voidedAt ? row.voidedAt.getTime() : null,
    }));

  const completion: DraftCompletion = draftComplete(
    { main: main.length, reserve: reserve.length },
    teamRows.map((team) => ({
      id: team.id,
      members: memberViews.filter((member) => member.teamId === team.id),
    })),
    config
  );

  return {
    now,
    config,
    teams: standings,
    lot,
    history,
    pools: { main: main.map(asPlayer), reserve: reserve.map(asPlayer) },
    activeKind:
      openRow?.fromKind ??
      (main.length > 0 || !config.reserveEnabled ? "main" : "reserve"),
    completion,
  };
}

export type PlayerCard = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
};

/** A draft room, redacted for one viewer, with the names to render the ids. */
export type DraftRoomView = DraftView & {
  eventId: string;
  /** Everyone the view mentions, keyed by user id. */
  players: Record<string, PlayerCard>;
};

/**
 * Work out what this viewer is to this draft.
 *
 * Admin beats everything; then captaincy, then being in it at all. Somebody
 * signed in who is not part of this event is an observer, and so is somebody
 * signed out — §11 puts the whole room in the same row for watching.
 */
export async function viewerFor(
  eventId: string,
  userId: string | null,
  isAdmin: boolean,
  database: Database = defaultDb
): Promise<DraftViewer> {
  if (isAdmin) return { role: "admin", userId, teamId: null };
  if (!userId) return { role: "observer", userId: null, teamId: null };

  const [captained] = await database
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.eventId, eventId), eq(teams.captainUserId, userId)))
    .limit(1);
  if (captained) return { role: "captain", userId, teamId: captained.id };

  const [onARoster] = await database
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (onARoster) return { role: "player", userId, teamId: null };

  const [inPool] = await database
    .select({ id: draftPoolEntries.id })
    .from(draftPoolEntries)
    .where(and(eq(draftPoolEntries.eventId, eventId), eq(draftPoolEntries.userId, userId)))
    .limit(1);
  if (inPool) return { role: "player", userId, teamId: null };

  return { role: "observer", userId, teamId: null };
}

/**
 * The draft as one particular viewer is allowed to see it.
 *
 * The redaction itself is `redactDraft`, a pure function over the snapshot;
 * this only fetches, and then looks up the display names for every id the
 * redacted view still mentions — never for one it hid, or the payload would
 * quietly leak the name of the player the wheel has not landed on yet.
 */
export async function getDraftView(
  eventId: string,
  viewer: DraftViewer,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftRoomView | null> {
  const snapshot = await getDraftSnapshot(eventId, options, database);
  if (!snapshot) return null;

  const view = redactDraft(snapshot, viewer);

  const mentioned = new Set<string>();
  for (const team of view.teams) {
    if (team.captainUserId) mentioned.add(team.captainUserId);
    for (const member of team.members) mentioned.add(member.userId);
  }
  for (const entry of view.activePool) mentioned.add(entry.userId);
  for (const entry of view.mainPool ?? []) mentioned.add(entry.userId);
  for (const entry of view.reservePool ?? []) mentioned.add(entry.userId);
  for (const settled of view.history) mentioned.add(settled.playerUserId);
  if (view.lot?.playerUserId) mentioned.add(view.lot.playerUserId);
  if (view.you.userId) mentioned.add(view.you.userId);

  const players: Record<string, PlayerCard> = {};
  if (mentioned.size > 0) {
    const rows = await database
      .select({
        id: users.id,
        displayName: users.displayName,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, [...mentioned]));
    for (const row of rows) {
      players[row.id] = {
        id: row.id,
        displayName: row.displayName ?? row.name ?? "Unknown player",
        avatarUrl: row.avatarUrl,
      };
    }
  }

  return { ...view, eventId, players };
}

/** Re-exported so a caller needs one import to render a draft. */
export type { DraftPhase, DraftRole, DraftViewer, DraftView };

/**
 * Players accepted into the event who are in neither a roster nor the pool.
 *
 * The Draft tab's "who is missing" line: somebody accepted after the pool was
 * seeded shows up here rather than silently never being drafted.
 */
export async function getUnpooledApplicants(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const accepted = await database
    .select({ userId: applications.userId })
    .from(applications)
    .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")))
    .orderBy(asc(applications.submittedAt));

  const [members, pool] = await Promise.all([
    readMembers(database, eventId),
    readPool(database, eventId),
  ]);
  const placed = new Set([
    ...members.map((member) => member.userId),
    ...pool.map((entry) => entry.userId),
  ]);

  return accepted.map((row) => row.userId).filter((userId) => !placed.has(userId));
}

/**
 * Players who were discarded and never came back — the other half of the
 * accounting, so a screen can say why the numbers do not add up.
 */
export async function getDiscardedPlayers(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const lots = await readLots(database, eventId);
  const [members, pool] = await Promise.all([
    readMembers(database, eventId),
    readPool(database, eventId),
  ]);
  const placed = new Set([
    ...members.map((member) => member.userId),
    ...pool.map((entry) => entry.userId),
  ]);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const lot of lots) {
    if (lot.status !== "discarded") continue;
    if (placed.has(lot.playerUserId) || seen.has(lot.playerUserId)) continue;
    seen.add(lot.playerUserId);
    out.push(lot.playerUserId);
  }
  return out;
}
