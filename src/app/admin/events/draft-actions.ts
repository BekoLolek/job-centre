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
 * A guard runs inside every action rather than being trusted from the page
 * that rendered the button, because a server action is a public endpoint. For
 * an action keyed on the event that is `requireEventManager`; for the two keyed
 * on a *team* — the hand placements — it is `requireManagerOfChild`, which
 * resolves the event from the team and never reads an id sent beside it. See
 * `src/lib/event-scope.ts` for the hole the second shape closes.
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
 *
 * ## Every write that changes the teams brings the matches with it
 *
 * The format follows the teams (R-73 / UC-18 8, 9), and these are the four
 * writes that can change them: a count, the whole list, and the two hand
 * placements Task 18 added. Each one calls `syncStages` after it succeeds, so a
 * four-team bracket becomes a six-team bracket the moment the sixth team
 * exists — whether or not anybody has the Format tab open. That last clause is
 * the whole point: this used to be an effect on that tab, so changing the teams
 * from the Teams tab left the matches on yesterday's shape until somebody
 * happened to look at the format.
 *
 * `syncStages` refuses to touch a stage that is carrying results and marks it
 * out of date instead (UC-18 9a), which is why calling it from a path as
 * ordinary as "move a player between rosters" is safe.
 */

import { revalidatePath } from "next/cache";
import type { DraftPoolKind } from "@/db/schema";
import {
  type BeforeRemoval,
  type CaptainInput,
  type DraftResult,
  type TeamInput,
  type TeamWithRoster,
  assignRandomTeams,
  eventIdOfTeam,
  getDraftConfig,
  getDraftHistory,
  getDraftPool,
  getTeams,
  placeOnRoster,
  removeFromRoster,
  setCaptains,
  setDraftConfig,
  setDraftPool,
  setPoolKind,
  setTeamCount,
  setTeams,
} from "@/lib/draft";
import type { DraftConfig } from "@/lib/draft-policy";
import { getEventById, updateEvent } from "@/lib/events";
import {
  type TeamFormat,
  eventShapeFrom,
  isNightFormat,
  teamFormatFrom,
} from "@/lib/events-policy";
import {
  type SyncResult,
  type TeamRelease,
  auditStageSync,
  matchesNamingTeams,
  releaseTeamsFromMatches,
  syncStages,
} from "@/lib/format";
import { recordAudit } from "@/lib/audit";
import { displayNamesFor } from "@/lib/players";
import { requireEventManager, requireManagerOfChild } from "@/lib/session-guards";

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
  /**
   * The generated matches naming a team that is going — the fourth thing
   * UC-15 E1 says a lower team count clears, and the one the dialog could not
   * say anything about until `matchesNamingTeams` existed.
   *
   * A match naming one of those teams and carrying a result refuses the whole
   * removal (see `releaseTeamsFromMatches`), so `matches.withResults` is as
   * much a blocker as a drafted roster is.
   */
  matches: TeamRelease;
};

function toTeamInput(team: TeamFields): TeamInput {
  return { id: team.id, name: team.name, seed: team.seed, balanceStart: team.balanceStart };
}

/**
 * Let the teams a write is about to remove actually be deleted, or hand back
 * the sentence saying why not (R-161 / UC-15 E1).
 *
 * ## Why the library calls this rather than the action calling it first
 *
 * `matches.team_a_id` references `teams` with no `on delete` action, so
 * Postgres refuses to delete a team any match names — and `setTeams` and
 * `setTeamCount` live in `src/lib/draft.ts`, which knows nothing about matches
 * and should not. Before this existed, lowering the team count on an event
 * whose matches had been generated came back as `matches_team_a_event_fk` in
 * front of the manager, and Task 21 made that the common case rather than a
 * rare one by generating the matches automatically.
 *
 * So the order the foreign key forces — release the references, then write the
 * teams, then sync — is this layer's to arrange. It used to arrange it by
 * running the release *before* the library call, and that was
 * `docs/decisions/004` one layer up: this **writes**, so a save the library
 * then refused had already stripped those match rows of their team references,
 * with no transaction around the pair to undo it and the admin told nothing had
 * changed. The reachable refusal is a team named as winner on a voided lot,
 * which `removeTeamsIn` declines at any lot status while every gate out here
 * lets it through.
 *
 * It is handed to the write instead, as `draft.ts`'s `BeforeRemoval`: called on
 * the write's own transaction, after every refusal has been settled and
 * immediately before the delete, so a refusal rolls this back with everything
 * else. Which teams are going is the write's answer too, rather than a second
 * copy of "the last by sort" / "the ones the list left out" read out here. The
 * rule itself is still `releaseTeamsFromMatches`'s — including its own refusal
 * when one of those matches carries a result.
 */
function releaseBefore(eventId: string): BeforeRemoval {
  return async (tx, doomed) => {
    const released = await releaseTeamsFromMatches(eventId, doomed, tx);
    return released.ok ? null : released.error;
  };
}

/**
 * Bring the matches into line, and log it — the half of UC-18 9 that belongs to
 * whatever just changed the teams.
 *
 * After the team write rather than inside it: the team write owns whether the
 * change is allowed, and a sync that declined to rebuild a stage must not roll
 * back a roster the manager has been told was saved. `syncStages` reports a
 * stage it cannot build rather than failing, so this never turns a successful
 * team write into an error.
 */
async function followTeams(
  actor: { id: string; displayName?: string | null; name?: string | null },
  eventId: string
): Promise<SyncResult | null> {
  const sync = await syncStages(eventId);
  await auditStageSync(actor, eventId, sync);
  return sync.ok ? sync.data : null;
}

/**
 * What removing these particular teams would cost.
 *
 * Shared by the two previews because there are two ways to remove a team — a
 * list that leaves one out, and a lower count — and one arithmetic. A second
 * copy would be a second chance for the dialog to under-report what a save is
 * about to clear.
 */
async function impactOfRemoving(
  eventId: string,
  doomed: (teams: TeamWithRoster[]) => TeamWithRoster[]
): Promise<TeamsImpact> {
  const [existing, lots] = await Promise.all([getTeams(eventId), getDraftHistory(eventId)]);

  // Exactly the set `setTeams` checks: any lot naming the team as winner, at
  // any status. A voided award still records a price that was once paid.
  const hasHistory = new Set(
    lots.map((lot) => lot.winnerTeamId).filter(Boolean) as string[]
  );

  const removed: RemovedTeamImpact[] = doomed(existing).map((team) => ({
    id: team.id,
    name: team.name,
    memberUserIds: team.members.map((member) => member.userId),
    captainUserId: team.captainUserId,
    spent: team.members.reduce((total, member) => total + member.price, 0),
    blocked: hasHistory.has(team.id),
  }));

  const matches = await matchesNamingTeams(
    eventId,
    removed.map((team) => team.id)
  );

  return {
    removed,
    clearedMembers: removed.reduce((total, team) => total + team.memberUserIds.length, 0),
    spent: removed.reduce((total, team) => total + team.spent, 0),
    anyBlocked: removed.some((team) => team.blocked) || matches.withResults > 0,
    matches,
  };
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
  await requireEventManager(eventId);

  const keeping = new Set(input.map((team) => team.id).filter(Boolean) as string[]);
  return impactOfRemoving(eventId, (existing) =>
    existing.filter((team) => !keeping.has(team.id))
  );
}

/**
 * What lowering the team count to `count` would cost (R-161 / UC-15 E1).
 *
 * The same teams `setTeamCount` would drop — the last by `sort`, which is the
 * order the tab shows — counted the same way. Read-only, and it decides
 * nothing: a team that has won lots is still refused by the write.
 */
export async function previewTeamCountAction(
  eventId: string,
  count: number
): Promise<TeamsImpact> {
  await requireEventManager(eventId);

  return impactOfRemoving(eventId, (existing) =>
    count >= existing.length ? [] : existing.slice(count)
  );
}

/**
 * Set how many teams the event has — UC-15 1, in one action.
 *
 * The teams it creates are named by the library, not by the browser, which is
 * the whole reason this exists beside `saveTeamsAction`: a placeholder written
 * here is recorded as a placeholder (`name_is_custom` false), so choosing a
 * captain renames it (UC-15 4) and a name the manager types instead of it is
 * never overwritten (UC-15 4a).
 */
export async function setTeamCountAction(
  eventId: string,
  count: number
): Promise<
  DraftResult<{
    teams: Array<TeamFields & { id: string }>;
    added: number;
    removed: number;
    sync: SyncResult | null;
  }>
> {
  const admin = await requireEventManager(eventId);

  // A lower count removes teams from the end, and a team a match names cannot
  // be deleted until that match stops naming it — so the release travels
  // *into* the write, which runs it inside its transaction once the removal is
  // certain. See `releaseBefore`. The `undefined` is the library's own database
  // handle, which this layer never names.
  const result = await setTeamCount(eventId, count, undefined, releaseBefore(eventId));
  if (!result.ok) return result;

  // Nothing is logged when nothing moved: a manager pressing Save on the
  // figure that is already stored should not leave a line saying the teams
  // changed.
  if (result.data.added > 0 || result.data.removed > 0) {
    await recordAudit({
      action: "team.count",
      actor: admin,
      eventId,
      summary:
        result.data.removed > 0
          ? `Set the event to ${count} teams, removing ${result.data.removed}.`
          : `Set the event to ${count} teams, adding ${result.data.added}.`,
      detail: { count, added: result.data.added, removed: result.data.removed },
    });
  }

  // The headline acceptance criterion of Task 21: changing the teams here
  // leaves the matches current, with the Format tab never opened.
  const sync = await followTeams(admin, eventId);

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
      added: result.data.added,
      removed: result.data.removed,
      sync,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The night's format, and teams nobody picked (R-215, R-216 / UC-41) */
/* ------------------------------------------------------------------ */

/**
 * Store whether the night is 6v6 or 3v3 — UC-41 1, and the admin's call.
 *
 * Written through `updateEvent`, which is the event's single write path, onto
 * `events.config` — so this needed no migration. `teamFormatFrom` explains why
 * the key is a *sibling* of `config.format` rather than inside it: a config
 * patch merges one level deep, and the Schedule tab replaces `config.format`
 * wholesale every time it saves.
 *
 * The value is re-validated here rather than trusted. A server action is a
 * public endpoint, so `isNightFormat` runs on whatever arrives, and the stored
 * format is read **back** through `teamFormatFrom` so the screen shows what
 * was stored rather than what was sent.
 */
export async function saveNightFormatAction(
  eventId: string,
  format: string
): Promise<DraftResult<{ teamFormat: TeamFormat }>> {
  const admin = await requireEventManager(eventId);

  if (!isNightFormat(format)) {
    return { ok: false, error: "A night is either 6v6 or 3v3." };
  }

  const before = teamFormatFrom((await getEventById(eventId))?.config);
  const result = await updateEvent(eventId, { config: { teamFormat: format } });
  if (!result.ok) return { ok: false, error: result.error };

  const stored = teamFormatFrom(result.data.config);

  // Nothing is logged when nothing moved, for the reason `team.count` says so:
  // re-saving the figure already stored should not leave a line claiming the
  // format changed.
  if (before.format !== stored.format) {
    await recordAudit({
      action: "event.format",
      actor: admin,
      eventId,
      summary: `Set the night to ${stored.format}, a ${stored.comp} comp.`,
      detail: { format: stored.format, teamSize: stored.teamSize, comp: stored.comp },
    });
  }

  refresh(eventId);
  return { ok: true, data: { teamFormat: stored } };
}

/**
 * Shuffle the accepted participants into teams of the format's size — UC-41 6.
 *
 * ## Where the randomness comes from
 *
 * Here, and only here. `assignRandomTeams` and `src/lib/random-teams.ts` take
 * the generator as a parameter and never call one, which is what makes the
 * shuffle testable at all (R-216; see `random-teams.ts`'s docblock). This is
 * the boundary where the real `Math.random` is handed in, so there is exactly
 * one line in the application to read to know what the production source is.
 *
 * ## `replace` is the admin's answer, not a default
 *
 * UC-41 3a refuses while teams exist until the admin says to replace them, and
 * the screen names how many would go before asking. The flag travels from that
 * confirmation; the library refuses without it rather than assuming consent.
 * Re-running is allowed and expected (5a) — this is the admin's own tool, and
 * 3a is what stops a reshuffle being an accident.
 *
 * Nothing about the size travels with the request. `assignRandomTeams` reads
 * the Format panel's sizing off the locked event row itself (R-218 / UC-42 6);
 * the night's comp is read here only to be named in the log line, because the
 * admin still reads "6v6" on the Teams tab and the audit should say what they
 * saw.
 */
export async function randomiseTeamsAction(
  eventId: string,
  replace: boolean
): Promise<
  DraftResult<{
    teams: Array<TeamFields & { id: string }>;
    rosters: RosterMove[];
    short: number[];
    discarded: number;
    sync: SyncResult | null;
  }>
> {
  const admin = await requireEventManager(eventId);

  // Both read from what is stored, never from anything sent beside the request.
  const config = (await getEventById(eventId))?.config;
  const teamFormat = teamFormatFrom(config);
  const sizing = eventShapeFrom(config).sizing;

  const result = await assignRandomTeams(eventId, {
    random: Math.random,
    replace,
    /*
     * The shuffle empties the team list, and a team a generated match names
     * cannot be deleted until that match stops naming it — the same foreign
     * key, and now literally the same hook the other two team writes take.
     * Task 78 passed it here first and spelled it out inline; `releaseBefore`
     * carries the reasoning, which is no longer this path's alone.
     */
    beforeRemoval: releaseBefore(eventId),
  });
  if (!result.ok) return result;

  await recordAudit({
    action: "team.random",
    actor: admin,
    eventId,
    summary: `Shuffled ${result.data.rosters.reduce((total, row) => total + row.userIds.length, 0)} accepted players into ${result.data.teams.length} random teams, sized by ${sizing.mode === "teams" ? `${sizing.value} teams` : `${sizing.value} per team`} (${teamFormat.format})${result.data.discarded > 0 ? `, replacing ${result.data.discarded}` : ""}.`,
    detail: {
      format: teamFormat.format,
      sizing: { mode: sizing.mode, value: sizing.value },
      teams: result.data.teams.length,
      short: result.data.short,
      discarded: result.data.discarded,
    },
  });

  const sync = await followTeams(admin, eventId);

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
      rosters: await rostersOf(eventId),
      short: result.data.short,
      discarded: result.data.discarded,
      sync,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rosters by hand (UC-15 5, 6)                                       */
/* ------------------------------------------------------------------ */

export type RosterMove = {
  teamId: string;
  userId: string;
  price: number;
  isCaptain: boolean;
};

/** Every roster as it now stands, for the tab to adopt after a move. */
async function rostersOf(eventId: string): Promise<RosterMove[]> {
  const written = await getTeams(eventId);
  return written.flatMap((team) =>
    team.members.map((member) => ({
      teamId: member.teamId,
      userId: member.userId,
      price: member.price,
      isCaptain: member.isCaptain,
    }))
  );
}

/**
 * Put an accepted player on a team, or move them to it — UC-15 5.
 *
 * **The event is resolved from the team**, through `requireManagerOfChild`, and
 * an `eventId` from the browser is not accepted at all. `event-scope.ts` has
 * the hole that opens otherwise: pass the id of the event you host to satisfy
 * the guard, pass a team id from somebody else's event to the write, and the
 * guard has checked a fact that has nothing to do with what is about to happen.
 * The verified id is what reaches `placeOnRoster`, which re-reads the team
 * against it anyway.
 */
export async function placeOnRosterAction(
  teamId: string,
  userId: string
): Promise<DraftResult<{ rosters: RosterMove[]; sync: SyncResult | null }>> {
  const { user: admin, eventId } = await requireManagerOfChild(() => eventIdOfTeam(teamId));

  const result = await placeOnRoster(eventId, userId, teamId);
  if (!result.ok) return result;

  // Nothing to say when the player was already there — the idempotent answer
  // to a double-click, not a change (see `placeOnRoster`).
  if (result.data.fromTeamId !== result.data.toTeamId) {
    const names = await displayNamesFor([userId]);
    const teams = await getTeams(eventId);
    const nameOfTeam = (id: string | null) =>
      teams.find((team) => team.id === id)?.name ?? "a team";

    await recordAudit({
      action: "team.roster",
      actor: admin,
      eventId,
      summary:
        result.data.fromTeamId === null
          ? `Put ${names.get(userId) ?? "somebody"} on ${nameOfTeam(teamId)} by hand.`
          : `Moved ${names.get(userId) ?? "somebody"} from ${nameOfTeam(result.data.fromTeamId)} to ${nameOfTeam(teamId)} by hand.`,
      detail: { userId, from: result.data.fromTeamId, to: teamId },
    });
  }

  /*
   * The matches follow the teams from here too (R-73 / UC-18 9).
   *
   * A placement moves a player between rosters that already exist, so today it
   * cannot change what `generateStage` builds — the shape is a function of how
   * many teams there are and which of them holds each seed, not of who is on
   * them. It is called anyway, for two reasons: when the teams have *not*
   * moved the sync is one read that writes nothing, and it is also what clears
   * an out-of-date mark on a stage whose results have since been cleared. The
   * alternative is a list of team writes that happen not to matter, which the
   * next person to add one has to be told about.
   */
  const sync = await followTeams(admin, eventId);

  refresh(eventId);
  return { ok: true, data: { rosters: await rostersOf(eventId), sync } };
}

/**
 * Take a player off a team — the other half of UC-15 5.
 *
 * `teamId` names the roster the manager is looking at and is authorised on, and
 * `removeFromRoster` refuses if the player has since been moved off it rather
 * than taking them off whichever team they are on now.
 */
export async function removeFromRosterAction(
  teamId: string,
  userId: string
): Promise<DraftResult<{ rosters: RosterMove[]; sync: SyncResult | null }>> {
  const { user: admin, eventId } = await requireManagerOfChild(() => eventIdOfTeam(teamId));

  const result = await removeFromRoster(eventId, userId, teamId);
  if (!result.ok) return result;

  const names = await displayNamesFor([userId]);
  await recordAudit({
    action: "team.roster",
    actor: admin,
    eventId,
    summary: `Took ${names.get(userId) ?? "somebody"} off a roster by hand.`,
    detail: { userId, from: teamId, to: null },
  });

  // The other half of the hand placement, and the same reasoning — see above.
  const sync = await followTeams(admin, eventId);

  refresh(eventId);
  return { ok: true, data: { rosters: await rostersOf(eventId), sync } };
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
): Promise<
  DraftResult<{
    teams: Array<TeamFields & { id: string }>;
    removed: number;
    sync: SyncResult | null;
  }>
> {
  const admin = await requireEventManager(eventId);

  // The list is authoritative, so a team whose id is absent is being removed
  // — same foreign key, same release, handed to the write for the same
  // reason. `setTeams` works out which teams those are and calls this with
  // their ids. See `releaseBefore`.
  const result = await setTeams(
    eventId,
    input.map(toTeamInput),
    undefined,
    releaseBefore(eventId)
  );
  if (!result.ok) return result;

  await recordAudit({
    action: "team.set",
    actor: admin,
    eventId,
    summary:
      result.data.removed > 0
        ? `Saved ${result.data.teams.length} teams and removed ${result.data.removed}: ${result.data.teams.map((team) => team.name).join(", ")}.`
        : `Saved ${result.data.teams.length} teams: ${result.data.teams.map((team) => team.name).join(", ")}.`,
    detail: { teams: result.data.teams.length, removed: result.data.removed },
  });

  // A list that dropped a team, added one, or re-seeded them all changes which
  // team is in which slot, so the matches follow it (R-73 / UC-18 9).
  const sync = await followTeams(admin, eventId);

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
      sync,
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
  const admin = await requireEventManager(eventId);

  const result = await setCaptains(eventId, input);
  if (!result.ok) return result;

  // Names, not ids. A log line reading "Made 4c9f… captain of 8a21…" is a line
  // nobody can use, and looking the pair up later is exactly what a summary
  // written at the time exists to avoid.
  const names = await displayNamesFor(result.data.teams.map((team) => team.captainUserId));
  const led = result.data.teams
    .filter((team) => team.captainUserId)
    .map((team) => `${names.get(team.captainUserId as string) ?? "somebody"} → ${team.name}`);
  const empty = result.data.teams.filter((team) => !team.captainUserId).length;

  await recordAudit({
    action: "team.captains",
    actor: admin,
    eventId,
    summary:
      led.length > 0
        ? `Set captains: ${led.join(", ")}.${empty > 0 ? ` ${empty} still without one.` : ""}`
        : "Cleared every captain.",
    detail: { captains: led.length, without: empty },
  });

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
  const admin = await requireEventManager(eventId);

  const result = await setDraftConfig(eventId, patch);
  if (!result.ok) return result;

  await recordAudit({
    action: "draft.config",
    actor: admin,
    eventId,
    summary:
      result.data.rebalanced > 0
        ? `Changed the draft rules — ${result.data.config.defaultBalance} each, ${result.data.config.biddingMode} bidding, rosters of ${result.data.config.rosterTarget}. ${result.data.rebalanced} team balances were reset.`
        : `Changed the draft rules — ${result.data.config.defaultBalance} each, ${result.data.config.biddingMode} bidding, rosters of ${result.data.config.rosterTarget}.`,
    detail: {
      defaultBalance: result.data.config.defaultBalance,
      biddingMode: result.data.config.biddingMode,
      balanceMode: result.data.config.balanceMode,
      rosterTarget: result.data.config.rosterTarget,
      rebalanced: result.data.rebalanced,
    },
  });

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
  const admin = await requireEventManager(eventId);

  const result = await setDraftPool(eventId, input);
  if (!result.ok) return result;

  await recordAudit({
    action: "draft.pool",
    actor: admin,
    eventId,
    summary: `Re-seeded the draft pool — ${result.data.added.length} added, ${result.data.removed.length} taken out.`,
    detail: {
      added: result.data.added.length,
      removed: result.data.removed.length,
      fromAccepted: input.userIds === undefined,
    },
  });

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
  await requireEventManager(eventId);

  const config = await getDraftConfig(eventId);
  if (!config.reserveEnabled) {
    return { ok: false, error: "The reserve pool is switched off for this event." };
  }

  const moved = await setPoolKind(eventId, userId, to);
  if (!moved.ok) return moved;

  refresh(eventId);
  return { ok: true, data: { pool: await poolState(eventId) } };
}
