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
 * ## The one place this file does arithmetic
 *
 * `previewStages` counts what regenerating a stage would erase. `generateMatches`
 * reports nothing beforehand — it either rewrites the stage or refuses it — and
 * a confirm dialog needs the number *before* the write, which is the same
 * problem `previewEventDays` solves for days. So this reads `formatFor` (the
 * same read the write itself uses) and counts. It decides nothing: whether a
 * regeneration is allowed at all is still `generateMatches`'s answer, and the
 * dialog says what it would cost rather than promising it will work.
 */

import { revalidatePath } from "next/cache";
import {
  type FormatResult,
  type FormatView,
  type GamePatch,
  type StageInput,
  applySchedule,
  formatFor,
  generateMatches,
  matchIdsFor,
  recordGames,
  scheduleSettingsFrom,
  setMatchSchedule,
  setStages,
  setWinnerOverride,
} from "@/lib/format";
import type { FormatTiming, StageConfig } from "@/lib/format-policy";
import { updateEvent } from "@/lib/events";
import { requireAdmin } from "@/lib/session-guards";

/** Both admin screens, plus the public event page once it exists. */
function refresh(eventId: string): void {
  revalidatePath("/admin/events");
  revalidatePath(`/admin/events/${eventId}`);
}

function fail<T>(error: string): FormatResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Reading the board                                                  */
/* ------------------------------------------------------------------ */

/** The whole resolved format, exactly as `formatFor` builds it. */
export async function loadFormatAction(eventId: string): Promise<FormatView | null> {
  await requireAdmin();
  return formatFor(eventId);
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
 * What a stage is carrying that a regeneration — or a change of shape, or a
 * removal — would erase.
 *
 * `blocked` mirrors `stageHasResults` exactly: a game ticked off, an admin's
 * winner override, or a recorded finish. A score typed in but never ticked is
 * not a result, which is the one state an admin may still change their mind
 * about, so it does not block anything and is counted separately.
 */
export type StageImpact = {
  stageId: string;
  name: string;
  /** Rows in the database — *not* the generated spec's length. See `impactOf`. */
  matches: number;
  playedGames: number;
  /** Series with a winner — the ones a regeneration would actually lose. */
  decided: number;
  overrides: number;
  finished: number;
  scheduled: number;
  /** Scores typed in but never ticked off. Not a result; not a blocker. */
  draftedScores: number;
  /** True when `generateMatches` and `setStages` will refuse outright. */
  blocked: boolean;
  /** The results themselves, so the dialog can name them rather than count them. */
  results: Array<{ slot: string; label: string; line: string }>;
};

/**
 * Count what one stage is carrying — over the matches that actually *exist*.
 *
 * `formatFor` resolves a stage's matches from its generated spec whether or not
 * a single row has been written, which is exactly what lets a bracket be
 * previewed before it exists. It also means `stage.matches.length` is never
 * zero and cannot answer "has this been generated yet". `matchIdsFor` can: a
 * slot with no row id has no row. Getting this wrong would put a confirm dialog
 * in front of the very first generate, warning about six matches that are not
 * there.
 */
function impactOf(
  stage: FormatView["stages"][number],
  ids: Record<string, string>
): StageImpact {
  const results: StageImpact["results"] = [];
  const stored = stage.matches.filter((match) => ids[match.slot]);
  let playedGames = 0;
  let overrides = 0;
  let finished = 0;
  let scheduled = 0;
  let decided = 0;
  let draftedScores = 0;

  for (const match of stored) {
    const played = match.games.filter((game) => game.played);
    playedGames += played.length;
    draftedScores += match.games.filter(
      (game) => !game.played && (game.scoreA > 0 || game.scoreB > 0)
    ).length;
    if (match.winnerOverrideId) overrides += 1;
    if (match.finishedAt) finished += 1;
    if (match.scheduledAt) scheduled += 1;
    if (match.status === "done") decided += 1;

    if (played.length > 0 || match.winnerOverrideId || match.finishedAt) {
      results.push({
        slot: match.slot,
        label: match.displayLabel,
        line: `${match.nameA} ${match.gamesWonA}–${match.gamesWonB} ${match.nameB}`,
      });
    }
  }

  return {
    stageId: stage.id,
    name: stage.name,
    matches: stored.length,
    playedGames,
    decided,
    overrides,
    finished,
    scheduled,
    draftedScores,
    blocked: playedGames > 0 || overrides > 0 || finished > 0,
    results,
  };
}

/**
 * What every stage of this event is currently carrying — asked *before* any
 * write, so the screen can say what changing the format costs.
 *
 * Read-only, and it decides nothing.
 */
export async function previewStagesAction(eventId: string): Promise<StageImpact[]> {
  await requireAdmin();
  const [view, ids] = await Promise.all([formatFor(eventId), matchIdsFor(eventId)]);
  return view ? view.stages.map((stage) => impactOf(stage, ids)) : [];
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
): Promise<FormatResult<{ stages: Array<StageFields & { id: string }> }>> {
  await requireAdmin();

  const stages: StageInput[] = input.map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    config: stage.config,
  }));

  const result = await setStages(eventId, stages);
  if (!result.ok) return result;

  refresh(eventId);
  return {
    ok: true,
    data: {
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
 * Generate — or regenerate — every match of one stage.
 *
 * Refused by `generateMatches` the moment a single game has been ticked off, so
 * the screen asks `previewStagesAction` first and says what would go.
 */
export async function generateStageAction(
  eventId: string,
  stageId: string
): Promise<FormatResult<{ created: number; view: FormatView | null }>> {
  await requireAdmin();

  const result = await generateMatches(stageId);
  if (!result.ok) return result;

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
  await requireAdmin();

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
  await requireAdmin();

  const saved = await saveScheduleSettingsAction(eventId, settings);
  if (!saved.ok) return saved;

  const result = await applySchedule(eventId, dayStarts);
  if (!result.ok) return result;

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
  eventId: string,
  matchId: string,
  fields: RecordFields
): Promise<FormatResult<{ view: FormatView | null }>> {
  await requireAdmin();

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
  return { ok: true, data: { view: await formatFor(eventId) } };
}

/**
 * Break a drawn series, or overturn one.
 *
 * `setWinnerOverride` resolves the slot before it believes the team id, so an
 * override naming somebody who is not in the match is refused with a sentence
 * rather than stored and then quietly ignored on read.
 */
export async function setWinnerOverrideAction(
  eventId: string,
  matchId: string,
  teamId: string | null
): Promise<FormatResult<{ view: FormatView | null }>> {
  await requireAdmin();

  const result = await setWinnerOverride(matchId, teamId);
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: { view: await formatFor(eventId) } };
}

/**
 * Wipe one series back to an unplayed card.
 *
 * The old board's "Clear", carried over: it is the only way back from a score
 * typed against the wrong match, and doing it as a patch — every game untick
 * and zeroed, the override dropped, the duration cleared — means it goes
 * through exactly the same validation and the same re-flow as recording one.
 */
export async function clearMatchAction(
  eventId: string,
  matchId: string,
  gameCount: number
): Promise<FormatResult<{ view: FormatView | null }>> {
  await requireAdmin();

  const cleared = await setWinnerOverride(matchId, null);
  if (!cleared.ok) return cleared;

  const result = await recordGames(
    matchId,
    Array.from({ length: Math.max(0, gameCount) }, (_, index) => ({
      index,
      map: "",
      referee: "",
      scoreA: 0,
      scoreB: 0,
      played: false,
    })),
    { durationMin: null }
  );
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: { view: await formatFor(eventId) } };
}
