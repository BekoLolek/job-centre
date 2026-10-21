"use server";

/**
 * The server actions behind the Format, Schedule and Results tabs.
 *
 * As thin as `./actions.ts` and `./draft-actions.ts`, and for the same reason:
 * every rule — how a bracket is built for five teams, which half a Bo5 applies
 * to, when a block ends, whether a drawn series is finished — lives in
 * `src/lib/bracket.ts`, `src/lib/format-policy.ts`, `src/lib/format-resolve.ts`
 * and `src/lib/format-schedule.ts`, is fronted by `src/lib/format.ts` and is
 * tested exhaustively. A second copy of any of them here is a second copy that
 * drifts, and a bracket that disagrees with itself is a tournament nobody can
 * finish.
 *
 * `requireAdmin()` runs inside every action rather than being trusted from the
 * page that rendered the button, because a server action is a public endpoint.
 *
 * ## Why the whole board comes back from a write
 *
 * Recording a result moves things a long way from the match that was edited:
 * the slot above it resolves, the standings change, and every later block that
 * day shifts (§10). Returning the re-read board rather than an acknowledgement
 * is what lets the Results tab *show* that rather than quietly repaint — the
 * screen diffs the board it already had against the one it just got back, and
 * says which matches moved.
 *
 * ## It does no arithmetic at all any more
 *
 * It used to count what regenerating a stage would erase, because the library
 * had no function for it. That count is now `stageClearings` in
 * `src/lib/format.ts`, beside the `rebuildStage` that consumes it — and the
 * move is not tidying. The dialog's numbers and the write's refusal have to
 * come from one read, or a dialog can promise a rebuild the write then declines
 * and a manager learns what their format costs from an error message.
 *
 * ## The matches are kept in step here, not on a screen
 *
 * `saveStagesAction` calls `syncStages` in the same action that wrote the
 * stages, and `./draft-actions.ts` calls it in the same action that wrote the
 * teams. The Format tab used to do it in an effect, which meant it only
 * happened while somebody had that tab open (R-73 / UC-18 8, 9).
 */

import { revalidatePath } from "next/cache";
import {
  type FormatResult,
  type FormatView,
  type GamePatch,
  type StageClearing,
  type StageInput,
  type SyncResult,
  applySchedule,
  auditStageSync,
  clearMatch,
  formatFor,
  generateMatches,
  matchIdsFor,
  rebuildStage,
  recordGames,
  reflipMatch,
  scheduleSettingsFrom,
  setMatchSchedule,
  setStages,
  setWinnerOverride,
  stageClearings,
  syncStages,
} from "@/lib/format";
import type { FormatTiming, MatchSlot, StageConfig } from "@/lib/format-policy";
import { updateEvent } from "@/lib/events";
import { recordAudit } from "@/lib/audit";
import { announceMatchResult } from "@/lib/discord";
import { eventIdOfMatch, eventIdOfStage } from "@/lib/event-scope";
import {
  requireAdmin,
  requireEventManager,
  requireManagerOfChild,
} from "@/lib/session-guards";

/** Both admin screens, plus the public event page once it exists. */
function refresh(eventId: string): void {
  revalidatePath("/admin/events");
  revalidatePath(`/admin/events/${eventId}`);
}

function fail<T>(error: string): FormatResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Stages                                                             */
/* ------------------------------------------------------------------ */

export type StageFields = {
  /** Pass an existing stage's id back to keep it — and its matches. */
  id?: string;
  name: string;
  kind: string;
  config: Partial<StageConfig>;
};

/**
 * What every stage of this event is currently carrying — asked *before* any
 * write, so the screen can say what changing the format costs (R-162 /
 * UC-18 E6).
 *
 * Read-only, and it decides nothing. Every number in it, and the `confirm`
 * token `rebuildStageAction` demands back, comes from `stageClearings`.
 */
export async function previewStagesAction(eventId: string): Promise<StageClearing[]> {
  await requireEventManager(eventId);
  return stageClearings(eventId);
}

/**
 * Replace the event's stage list.
 *
 * The written rows come back **with their ids** and the tab adopts them, for
 * the same reason the days do in `./actions.ts`: a stage is kept rather than
 * replaced only when its id is passed back, so a tab still holding "two new
 * stages" after a successful save would delete those two rows on the next one —
 * and take every match in them along.
 */
export async function saveStagesAction(
  eventId: string,
  input: StageFields[]
): Promise<
  FormatResult<{ stages: Array<StageFields & { id: string }>; sync: SyncResult | null }>
> {
  const admin = await requireEventManager(eventId);

  const stages: StageInput[] = input.map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    config: stage.config,
  }));

  const result = await setStages(eventId, stages);
  if (!result.ok) return result;

  /*
   * The matches follow the settings, in the same action that changed them
   * (R-73 / UC-18 5). This is one of the two halves of the effect that used to
   * live in the Format tab; the other is the team writes in `./draft-actions.ts`.
   *
   * After the write rather than inside it, and deliberately: `setStages` owns
   * whether the list may change at all, and a sync that refused a stage must
   * not roll back a stage list the manager has been told was saved.
   */
  const sync = await syncStages(eventId);

  await recordAudit({
    action: "format.stages",
    actor: admin,
    eventId,
    summary: `Set the format to ${result.data.map((stage) => `${stage.name ?? stage.kind} (${stage.kind})`).join(" then ")}.`,
    detail: { stages: result.data.length },
  });
  await auditStageSync(admin, eventId, sync);

  refresh(eventId);
  return {
    ok: true,
    data: {
      sync: sync.ok ? sync.data : null,
      stages: result.data.map((stage) => ({
        id: stage.id,
        name: stage.name ?? "",
        kind: stage.kind,
        // The stored config is the *normalised* one, which may not be what was
        // sent — a bracket reset outside a double elimination is dropped, and a
        // bronze mode is read into whatever the bracket can actually express.
        // The tab adopts this so the screen never disagrees with the database.
        config: stage.config as unknown as Partial<StageConfig>,
      })),
    },
  };
}

/**
 * **Rebuild one stage over the top of what it is carrying** — UC-18 9a's
 * "rebuild anyway", and the only path on the site that can delete a recorded
 * result along with the match it belongs to.
 *
 * `confirm` is the `StageClearing.confirm` the dialog was built from.
 * `rebuildStage` recomputes it inside its own transaction under the event's row
 * lock and refuses if it has moved, so a result recorded in another tab while
 * the dialog was open stops the rebuild rather than disappearing into it. The
 * screen's job is to show what will go; this action's job is to prove that is
 * still what would go.
 */
export async function rebuildStageAction(
  stageId: string,
  confirm: string
): Promise<FormatResult<{ created: number; cleared: StageClearing; view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own stage.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfStage(stageId)
  );

  const result = await rebuildStage(stageId, confirm);
  if (!result.ok) return result;

  const { cleared } = result.data;
  // What went, named, because afterwards there is no way to find out.
  const lost = cleared.results.map((row) => `${row.label}: ${row.line}`);
  await recordAudit({
    action: "format.generated",
    actor: admin,
    eventId,
    subject: stageId,
    summary:
      lost.length > 0
        ? `Rebuilt “${cleared.name}” over ${lost.length} recorded ${lost.length === 1 ? "result" : "results"} — ${lost.join("; ")} — and generated ${result.data.created} matches.`
        : `Rebuilt “${cleared.name}” — ${cleared.matches} ${cleared.matches === 1 ? "match" : "matches"} replaced by ${result.data.created}.`,
    detail: {
      created: result.data.created,
      cleared: cleared.matches,
      playedGames: cleared.playedGames,
      decided: cleared.decided,
      overrides: cleared.overrides,
      draftedScores: cleared.draftedScores,
    },
  });

  refresh(eventId);
  return { ok: true, data: { ...result.data, view: await formatFor(eventId) } };
}

/**
 * Generate — or regenerate — every match of one stage.
 *
 * Refused by `generateMatches` the moment a single game has been ticked off, so
 * the screen asks `previewStagesAction` first and says what would go — and
 * `rebuildStageAction` is the way through that refusal once it has.
 */
export async function generateStageAction(
  stageId: string
): Promise<FormatResult<{ created: number; view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own stage.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfStage(stageId)
  );

  const result = await generateMatches(stageId);
  if (!result.ok) return result;

  await recordAudit({
    action: "format.generated",
    actor: admin,
    eventId,
    subject: stageId,
    summary: `Generated ${result.data.created} matches.`,
    detail: { created: result.data.created },
  });

  refresh(eventId);
  return { ok: true, data: { created: result.data.created, view: await formatFor(eventId) } };
}

/* ------------------------------------------------------------------ */
/* Schedule settings (§10)                                            */
/* ------------------------------------------------------------------ */

export type ScheduleSettingsFields = {
  timing: FormatTiming;
  concurrentLobbies: number;
  days: number;
  /** The day each block runs on, 1-based and in block order. Null balances them. */
  blockDays: number[] | null;
};

/**
 * Save the three numbers and the list §10 turns into a running order.
 *
 * They live on `events.config.format` rather than in a table of their own —
 * `scheduleSettingsFrom` is the reader, and it is what every schedule screen
 * and every re-flow already goes through. Writing them through `updateEvent`
 * keeps the event's single write path, and reading them back through
 * `scheduleSettingsFrom` means the screen shows what was *stored*, clamps and
 * all, rather than what was typed.
 */
export async function saveScheduleSettingsAction(
  eventId: string,
  fields: ScheduleSettingsFields
): Promise<FormatResult<{ settings: ScheduleSettingsFields }>> {
  await requireEventManager(eventId);

  const result = await updateEvent(eventId, {
    config: {
      format: {
        timing: fields.timing,
        concurrentLobbies: fields.concurrentLobbies,
        days: fields.days,
        blockDays: fields.blockDays,
      },
    },
  });
  if (!result.ok) return fail(result.error);

  refresh(eventId);
  const stored = scheduleSettingsFrom(result.data.config);
  return {
    ok: true,
    data: {
      settings: {
        timing: stored.timing,
        concurrentLobbies: stored.concurrentLobbies,
        days: stored.days,
        blockDays: stored.blockDays,
      },
    },
  };
}

/**
 * Save the settings, then lay the running order out from a start time per day.
 *
 * One action rather than two calls from the screen, because the plan the fill
 * uses is built from the settings: filling with one set of numbers and storing
 * another would put times on the board that the next re-flow disagrees with.
 * A day left blank is skipped by `autoSchedule` rather than guessed at.
 */
export async function applyScheduleAction(
  eventId: string,
  dayStarts: Array<string | null>,
  settings: ScheduleSettingsFields
): Promise<FormatResult<{ scheduled: number; view: FormatView | null }>> {
  const admin = await requireEventManager(eventId);

  const saved = await saveScheduleSettingsAction(eventId, settings);
  if (!saved.ok) return saved;

  const result = await applySchedule(eventId, dayStarts);
  if (!result.ok) return result;

  await recordAudit({
    action: "schedule.applied",
    actor: admin,
    eventId,
    summary: `Rebuilt the running order — ${result.data.scheduled} matches given a start time across ${settings.days} days.`,
    detail: { scheduled: result.data.scheduled, days: settings.days },
  });

  refresh(eventId);
  return { ok: true, data: { scheduled: result.data.scheduled, view: await formatFor(eventId) } };
}

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

export type RecordFields = {
  games: GamePatch[];
  /** Absent leaves the stored duration alone; null clears it. */
  durationMin?: number | null;
  /** An ISO instant, or null to unschedule. Absent leaves it alone. */
  scheduledAt?: string | null;
};

/**
 * Record part of a series, and the times around it.
 *
 * The start is written first and separately because it is a different kind of
 * fact — where the match sat in the day — and `recordGames` derives the
 * duration from it. Both re-flow the rest of the day inside their own
 * transaction, so the board that comes back at the end is consistent whichever
 * of the two the admin actually changed.
 */
export async function recordGamesAction(
  matchId: string,
  fields: RecordFields
): Promise<FormatResult<{ view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own match.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfMatch(matchId)
  );

  if (fields.scheduledAt !== undefined) {
    const moved = await setMatchSchedule(matchId, fields.scheduledAt);
    if (!moved.ok) return moved;
  }

  const result = await recordGames(
    matchId,
    fields.games,
    "durationMin" in fields ? { durationMin: fields.durationMin ?? null } : {}
  );
  if (!result.ok) return result;

  refresh(eventId);
  const view = await formatFor(eventId);

  // The board is re-read anyway, so the line the log stores is the scoreline
  // the screen is about to show — no third description of the same series.
  const line = matchLine(view, matchId, await matchIdsFor(eventId));
  await recordAudit({
    action: "result.recorded",
    actor: admin,
    eventId,
    subject: matchId,
    summary: line ? `Recorded ${line}.` : "Recorded a result.",
    detail: { games: fields.games.length },
  });

  // Only a decided series is announced; `announceMatchResult` re-reads the
  // board and returns without posting for a card that is half filled in.
  announceMatchResult(matchId);

  return { ok: true, data: { view } };
}

/**
 * One match as a sentence — "Upper semi-final: Rivals Red 2–1 Rivals Blue".
 *
 * Built from the resolved board rather than from the patch, because a patch
 * says what changed and a log line has to say where the series *ended up*.
 * Returns `null` when the match is not on the board any more, which is the one
 * case where a generic line is the honest one.
 */
function matchLine(
  view: FormatView | null,
  matchId: string,
  ids: Record<string, string>
): string | null {
  const slot = Object.entries(ids).find(([, id]) => id === matchId)?.[0];
  if (!view || !slot) return null;
  const match = view.stages.flatMap((stage) => stage.matches).find((row) => row.slot === slot);
  if (!match) return null;
  return `${match.displayLabel}: ${match.nameA} ${match.gamesWonA}–${match.gamesWonB} ${match.nameB}`;
}

/**
 * Break a drawn series, or overturn one.
 *
 * `setWinnerOverride` resolves the slot before it believes the team id, so an
 * override naming somebody who is not in the match is refused with a sentence
 * rather than stored and then quietly ignored on read.
 */
export async function setWinnerOverrideAction(
  matchId: string,
  teamId: string | null
): Promise<FormatResult<{ view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own match.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfMatch(matchId)
  );

  const result = await setWinnerOverride(matchId, teamId);
  if (!result.ok) return result;

  refresh(eventId);
  const view = await formatFor(eventId);
  const ids = await matchIdsFor(eventId);
  const line = matchLine(view, matchId, ids);
  const named = teamId
    ? (view?.teams.find((team) => team.id === teamId)?.name ?? "a team")
    : null;

  await recordAudit({
    action: "result.override",
    actor: admin,
    eventId,
    subject: matchId,
    summary: named
      ? `Called ${line ?? "a series"} for ${named}.`
      : `Dropped the winner override on ${line ?? "a series"}.`,
    detail: { teamId },
  });

  // An override is what settles a drawn series, so it is a result like any
  // other — and the one the room has actually been waiting for.
  announceMatchResult(matchId);

  return { ok: true, data: { view } };
}

/**
 * Re-flip a match's coin, or hand the side choice to a named slot.
 *
 * §8.4's rule is that one team chooses attack or defence and the other chooses
 * the map, swapping every game, with a coin deciding who starts. `reflipMatch`
 * owns both refusals — a finished event, and a series that has already started
 * — for the same reason `clearMatch` owns its own: a rule enforced by the
 * action rather than by the library is a rule the next caller skips.
 *
 * The log line names the team rather than the slot, because "Rivals Blue now
 * picks the side in game 1" is a sentence somebody can check against what
 * happened in the room, and "first_side_choice is now b" is not.
 */
export async function reflipMatchAction(
  matchId: string,
  slot: MatchSlot | null = null
): Promise<FormatResult<{ firstSideChoice: MatchSlot; view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own match.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfMatch(matchId)
  );

  const result = await reflipMatch(matchId, slot);
  if (!result.ok) return result;

  refresh(eventId);
  const view = await formatFor(eventId);
  const ids = await matchIdsFor(eventId);
  const resolvedSlot = Object.entries(ids).find(([, id]) => id === matchId)?.[0];
  const match = resolvedSlot
    ? view?.stages.flatMap((stage) => stage.matches).find((row) => row.slot === resolvedSlot)
    : undefined;
  const chooser = match?.choices[0]?.sideName ?? (result.data.firstSideChoice === "a" ? "Side A" : "Side B");

  await recordAudit({
    action: "match.reflip",
    actor: admin,
    eventId,
    subject: matchId,
    summary: `${slot ? "Set" : "Re-flipped"} the coin on ${match?.displayLabel ?? "a match"} — ${chooser} picks the side in game 1.`,
    detail: { firstSideChoice: result.data.firstSideChoice, tossed: slot === null },
  });

  return { ok: true, data: { firstSideChoice: result.data.firstSideChoice, view } };
}

/**
 * Wipe one series back to an unplayed card.
 *
 * The composition that used to live here — clear the override, then patch every
 * game back to nothing — has moved into `clearMatch` in `src/lib/format.ts`,
 * and the move is the whole point. Assembling the site's most destructive
 * operation out of two library calls put it *outside* every rule the library
 * enforces about that operation: it reached both writes without ever asking
 * whether the event was finished. An action that composes is an action that has
 * business logic in it, and this file says it must not.
 *
 * What is left is the same shape as everything else here: guard, delegate, log.
 */
export async function clearMatchAction(
  matchId: string,
  gameCount: number
): Promise<FormatResult<{ view: FormatView | null }>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` argument: one sent by the browser would let a host of one event
   * read another's board by passing a foreign id beside their own match.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfMatch(matchId)
  );

  // The line is read *before* the wipe: afterwards there is nothing left to
  // describe, and "cleared a match" is not a log entry anybody can act on.
  const before = matchLine(await formatFor(eventId), matchId, await matchIdsFor(eventId));

  const result = await clearMatch(matchId, gameCount);
  if (!result.ok) return result;

  await recordAudit({
    action: "result.cleared",
    actor: admin,
    eventId,
    subject: matchId,
    summary: before ? `Cleared ${before} back to an unplayed card.` : "Cleared a series.",
    detail: { games: gameCount },
  });

  refresh(eventId);
  return { ok: true, data: { view: await formatFor(eventId) } };
}
