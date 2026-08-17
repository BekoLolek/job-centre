"use server";

/**
 * The server actions behind the Teams, Captains and Draft tabs.
 *
 * As thin as `./actions.ts`, and for the same reason: every rule — the eight
 * team maximum, "a captain must be an accepted applicant", what a balance mode
 * does to a starting balance, whether a pool may be rewritten while somebody is
 * on the block — lives in `src/lib/draft.ts` and `src/lib/draft-policy.ts`,
 * which are tested against real Postgres and against every awkward case. A
 * second copy of any of them here is a second copy that drifts, and a draft
 * that is wrong about money is a draft nobody trusts again.
 *
 * `requireAdmin()` runs inside every action rather than being trusted from the
 * page that rendered the button, because a server action is a public endpoint.
 *
 * ## The one place this file does arithmetic
 *
 * `previewTeams` counts what removing a team would cost. `setTeams` reports
 * nothing beforehand — it either removes the teams or refuses — and a confirm
 * dialog needs the number *before* the write, which is exactly the problem
 * `previewEventDays` solves for days. There is no `previewTeams` in the library
 * to call, so this reads `getTeams` and `getDraftHistory` (both exported, both
 * the same reads the write itself uses) and counts. It decides nothing: whether
 * a removal is actually allowed is still `setTeams`'s answer, and the dialog
 * says what it would cost rather than promising it will work.
 */

import { revalidatePath } from "next/cache";
import type { DraftPoolKind } from "@/db/schema";
import {
  type CaptainInput,
  type DraftResult,
  type TeamInput,
  getDraftConfig,
  getDraftHistory,
  getDraftPool,
  getTeams,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setPoolKind,
  setTeams,
} from "@/lib/draft";
import type { DraftConfig } from "@/lib/draft-policy";
import { requireAdmin } from "@/lib/session-guards";

/** Both admin screens: a team or a pool change alters what the list summarises. */
function refresh(eventId: string): void {
  revalidatePath("/admin/events");
  revalidatePath(`/admin/events/${eventId}`);
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/* ------------------------------------------------------------------ */

export type TeamFields = {
  /** Pass an existing team's id back to keep it — and its roster. */
  id?: string;
  name: string;
  seed: number | null;
  /** Only read when the balance mode is `per_team`; `setTeams` ignores it under uniform. */
  balanceStart: number;
};

export type RemovedTeamImpact = {
  id: string;
  name: string;
  /** Everybody on it, captain included (§14). */
  memberUserIds: string[];
  captainUserId: string | null;
  /** What the drafted players on it cost. */
  spent: number;
  /**
   * True when the team has won lots, so `setTeams` will refuse the removal
   * outright rather than erase what was paid. The dialog says so before the
   * admin discovers it as an error.
   */
  blocked: boolean;
};

export type TeamsImpact = {
  removed: RemovedTeamImpact[];
  /** Roster rows the removal would drop, across every removed team. */
  clearedMembers: number;
  spent: number;
  /** True when at least one removal would be refused. */
  anyBlocked: boolean;
};

function toTeamInput(team: TeamFields): TeamInput {
  return { id: team.id, name: team.name, seed: team.seed, balanceStart: team.balanceStart };
}

/**
 * What saving this team list would cost — asked *before* the write.
 *
 * Read-only. Nothing here writes, and nothing here decides: `setTeams` still
 * has the final word on whether a removal is allowed at all.
 */
export async function previewTeamsAction(
  eventId: string,
  input: TeamFields[]
): Promise<TeamsImpact> {
  await requireAdmin();

  const keeping = new Set(input.map((team) => team.id).filter(Boolean) as string[]);
  const [existing, lots] = await Promise.all([
    getTeams(eventId),
    getDraftHistory(eventId),
  ]);

  // Exactly the set `setTeams` checks: any lot naming the team as winner, at
  // any status. A voided award still records a price that was once paid.
  const hasHistory = new Set(
    lots.map((lot) => lot.winnerTeamId).filter(Boolean) as string[]
  );

  const removed: RemovedTeamImpact[] = existing
    .filter((team) => !keeping.has(team.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      memberUserIds: team.members.map((member) => member.userId),
      captainUserId: team.captainUserId,
      spent: team.members.reduce((total, member) => total + member.price, 0),
      blocked: hasHistory.has(team.id),
    }));

  return {
    removed,
    clearedMembers: removed.reduce((total, team) => total + team.memberUserIds.length, 0),
    spent: removed.reduce((total, team) => total + team.spent, 0),
    anyBlocked: removed.some((team) => team.blocked),
  };
}

/**
 * Write the whole team list.
 *
 * The written rows come back **with their ids** and the tab adopts them, for
 * the same reason the days do in `./actions.ts`: a team is kept rather than
 * replaced only when its id is passed back, so a tab still holding "four new
 * teams" after a successful save would delete those four rows on the next one.
 */
export async function saveTeamsAction(
  eventId: string,
  input: TeamFields[]
): Promise<DraftResult<{ teams: Array<TeamFields & { id: string }>; removed: number }>> {
  await requireAdmin();

  const result = await setTeams(eventId, input.map(toTeamInput));
  if (!result.ok) return result;

  refresh(eventId);
  return {
    ok: true,
    data: {
      teams: result.data.teams.map((team) => ({
        id: team.id,
        name: team.name,
        seed: team.seed,
        balanceStart: team.balanceStart,
      })),
      removed: result.data.removed,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Captains                                                           */
/* ------------------------------------------------------------------ */

/**
 * Set every team's captain in one write.
 *
 * One call rather than one per team is not a saving — it is the only correct
 * shape. Two captains exchanging teams needs both cleared before either is set,
 * and `setCaptains` does exactly that in two passes; sending the changes one at
 * a time would trip the unique constraint halfway through a legal swap.
 */
export async function saveCaptainsAction(
  eventId: string,
  input: CaptainInput[]
): Promise<DraftResult<{ captains: Array<{ teamId: string; userId: string | null }> }>> {
  await requireAdmin();

  const result = await setCaptains(eventId, input);
  if (!result.ok) return result;

  refresh(eventId);
  return {
    ok: true,
    data: {
      captains: result.data.teams.map((team) => ({
        teamId: team.id,
        userId: team.captainUserId,
      })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Configuration (§9)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Write the draft rules.
 *
 * The config comes back rather than being assumed, because `draftConfigFrom`
 * may not have stored what was sent: open bidding with `admin_only` visibility
 * is silently upgraded to `captains`, since "bid ten more than a number you
 * cannot see" is not a rule anybody can follow. The screen shows what was
 * actually saved.
 *
 * `rebalanced` is the other surprise worth surfacing — under a uniform balance
 * mode, changing the default rewrites every team's starting balance.
 */
export async function saveDraftConfigAction(
  eventId: string,
  patch: Partial<DraftConfig>
): Promise<DraftResult<{ config: DraftConfig; rebalanced: number }>> {
  await requireAdmin();

  const result = await setDraftConfig(eventId, patch);
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: result.data };
}

/* ------------------------------------------------------------------ */
/* The pool                                                           */
/* ------------------------------------------------------------------ */

export type PoolState = {
  main: string[];
  reserve: string[];
};

async function poolState(eventId: string): Promise<PoolState> {
  const pool = await getDraftPool(eventId);
  return {
    main: pool.main.map((entry) => entry.userId),
    reserve: pool.reserve.map((entry) => entry.userId),
  };
}

/**
 * Seed or rewrite the pool.
 *
 * With no `userIds` this is the admin screen's "fill it from the accepted
 * applicants" button, and `setDraftPool` does the excluding: captains never
 * enter the pool (§14) and anybody already on a roster is not still for sale.
 * Neither rule is applied here.
 */
export async function seedDraftPoolAction(
  eventId: string,
  input: { userIds?: string[]; keepReserve?: boolean } = {}
): Promise<DraftResult<{ added: number; removed: number; pool: PoolState }>> {
  await requireAdmin();

  const result = await setDraftPool(eventId, input);
  if (!result.ok) return result;

  refresh(eventId);
  return {
    ok: true,
    data: {
      added: result.data.added.length,
      removed: result.data.removed.length,
      pool: await poolState(eventId),
    },
  };
}

/**
 * Move one player between the two pools.
 *
 * One transaction, via `setPoolKind`. This is setup rather than draft history:
 * deciding up front that somebody is held over should leave no lot behind, and
 * composing `openLot` + `moveToReserve` to achieve it would record a spin that
 * never happened and take two transactions to undo.
 *
 * `setDraftPool` with `keepReserve: false` is the different, blunter action —
 * it returns *everyone* to the main pool — and is offered separately.
 */
export async function movePoolPlayerAction(
  eventId: string,
  userId: string,
  to: DraftPoolKind,
  options: { by?: string | null } = {}
): Promise<DraftResult<{ pool: PoolState }>> {
  await requireAdmin();

  const config = await getDraftConfig(eventId);
  if (!config.reserveEnabled) {
    return { ok: false, error: "The reserve pool is switched off for this event." };
  }

  const moved = await setPoolKind(eventId, userId, to);
  if (!moved.ok) return moved;

  refresh(eventId);
  return { ok: true, data: { pool: await poolState(eventId) } };
}
