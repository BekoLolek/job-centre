/**
 * What moved — the visible half of §10's live re-flow.
 *
 * A block is over when its *slowest* match finishes, so recording one result
 * shifts every later block of that day. That is the behaviour the old board was
 * built around and it is right, but it happens somewhere else on the screen
 * from where the admin was typing, and a schedule that quietly rearranges
 * itself is a schedule nobody trusts. So the two boards are compared and the
 * change is stated.
 *
 * Pure, and it decides nothing: both sides are boards the server already
 * resolved, and this only subtracts one from the other.
 */

import type { ResolvedMatch } from "@/lib/format-resolve";

export type ScheduleShift = {
  slot: string;
  label: string;
  /** The instant it used to start. Null when it had no time at all. */
  from: string | null;
  to: string | null;
  /** Signed minutes. Positive is later. */
  deltaMin: number | null;
};

type BoardLike = { stages: Array<{ matches: ResolvedMatch[] }> };

function flatten(board: BoardLike): Map<string, ResolvedMatch> {
  const out = new Map<string, ResolvedMatch>();
  for (const stage of board.stages) {
    for (const match of stage.matches) out.set(match.slot, match);
  }
  return out;
}

/**
 * Every match whose start time changed between two boards.
 *
 * The match that was *edited* is excluded by the caller rather than here: it is
 * the one move the admin already knows about, and listing it would bury the
 * ones they do not.
 */
export function scheduleShifts(before: BoardLike, after: BoardLike): ScheduleShift[] {
  const was = flatten(before);
  const now = flatten(after);
  const out: ScheduleShift[] = [];

  for (const [slot, match] of now) {
    const previous = was.get(slot);
    if (!previous) continue;
    if (previous.scheduledAt === match.scheduledAt) continue;

    out.push({
      slot,
      label: match.displayLabel,
      from: previous.scheduledAt,
      to: match.scheduledAt,
      deltaMin:
        previous.scheduledAt && match.scheduledAt
          ? Math.round(
              (Date.parse(match.scheduledAt) - Date.parse(previous.scheduledAt)) / 60_000
            )
          : null,
    });
  }

  return out;
}

/** "12 minutes later", "5 minutes earlier", "now scheduled". */
export function shiftText(shift: ScheduleShift): string {
  if (shift.deltaMin === null) {
    return shift.to ? "now scheduled" : "no longer scheduled";
  }
  if (shift.deltaMin === 0) return "unchanged";
  const minutes = Math.abs(shift.deltaMin);
  const unit = minutes === 1 ? "minute" : "minutes";
  return `${minutes} ${unit} ${shift.deltaMin > 0 ? "later" : "earlier"}`;
}
