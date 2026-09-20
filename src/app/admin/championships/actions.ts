"use server";

/**
 * The server actions behind `/admin/championships`.
 *
 * Thin on purpose, exactly like `/admin/events`' and `/admin/templates`': prove
 * the caller is an admin, hand the arguments to `src/lib/championships.ts` —
 * which owns every rule and is tested against real Postgres — and revalidate
 * the pages whose content just changed. There is no business logic here and
 * there must not be: a second copy of "may this season be published" is a
 * second copy that drifts.
 *
 * `requireAdmin()` runs inside every action rather than being trusted from the
 * page that rendered the button. A server action is a public endpoint; the
 * page's guard proves nothing about who is calling it five minutes later, and
 * the statuses below arrive from the browser and are checked against the enum
 * before they can reach a write or a log line.
 *
 * ## The log lives here, and only here
 *
 * `recordAudit` needs to know *who* is acting, and `requireAdmin()`'s return
 * value is the only place that is known — `src/lib/championships.ts` takes a
 * `Database` and is called by tests and seeds. The reopen gets its own line
 * naming the person (UC-35 2a), because it is the one move that unlocks a
 * finished record.
 */

import { revalidatePath } from "next/cache";
import { type ChampionshipStatusValue, championshipStatus } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import {
  type ChampionshipFields,
  type ChampionshipResult,
  type StatusMoveOptions,
  createChampionship,
  setChampionshipStatus,
  updateChampionship,
} from "@/lib/championships";
import { requireAdmin } from "@/lib/session-guards";

/** This list, the one season's editor, and the log that just gained a line. */
function refresh(championshipId?: string): void {
  revalidatePath("/admin/championships");
  if (championshipId) revalidatePath(`/admin/championships/${championshipId}`);
  revalidatePath("/admin/audit");
}

/* ------------------------------------------------------------------ */
/* Creating                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create a season (UC-31 1). Name, description and months only — the points
 * table is the editor's job, which is why a new season is hidden and therefore
 * invisible to everybody but an admin (UC-31 2).
 */
export async function createChampionshipAction(
  input: Pick<ChampionshipFields, "description" | "runsFrom" | "runsTo"> & { name: string }
): Promise<ChampionshipResult<{ id: string; slug: string }>> {
  const admin = await requireAdmin();

  const result = await createChampionship({ ...input, createdBy: admin.id });
  if (!result.ok) return result;

  await recordAudit({
    action: "championship.created",
    actor: admin,
    subject: result.data.id,
    summary: `Created the championship "${result.data.name}".`,
    detail: { slug: result.data.slug },
  });

  refresh(result.data.id);
  return { ok: true, data: { id: result.data.id, slug: result.data.slug } };
}

/* ------------------------------------------------------------------ */
/* Editing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Save the editor: the season's identity and its scoring rules (UC-31 1, 3, 4).
 *
 * One save rather than a panel each, because unlike an event's tabs these four
 * numbers are argued about together — a shorter table and a lower
 * participation value are one decision, and saving half of it is the one way
 * to trip UC-31 4a on your own settings.
 */
export async function saveChampionshipAction(
  championshipId: string,
  fields: ChampionshipFields
): Promise<ChampionshipResult<{ name: string }>> {
  const admin = await requireAdmin();

  const result = await updateChampionship(championshipId, fields);
  if (!result.ok) return result;

  await recordAudit({
    action: "championship.updated",
    actor: admin,
    subject: championshipId,
    summary: `Changed the championship "${result.data.name}".`,
    detail: {
      places: result.data.pointsTable.length,
      participation: result.data.participationPoints,
      countBest: result.data.countBest,
    },
  });

  refresh(championshipId);
  return { ok: true, data: { name: result.data.name } };
}

/* ------------------------------------------------------------------ */
/* The lifecycle                                                      */
/* ------------------------------------------------------------------ */

/**
 * Publish, unpublish, close or reopen (UC-31 5, UC-35 1, 2a).
 *
 * `from` is the status the control was rendered with; the move lands only if
 * the season still holds it, so a stale page or a second admin acting at the
 * same moment is refused — and a refused move logs nothing.
 *
 * Closing a season with a counting event nobody has scored comes back as a
 * refusal carrying their names (UC-35 1a). The screen asks, and calls again
 * with `confirm`.
 */
export async function setChampionshipStatusAction(
  championshipId: string,
  from: ChampionshipStatusValue,
  status: ChampionshipStatusValue,
  options: StatusMoveOptions = {}
): Promise<ChampionshipResult<{ status: ChampionshipStatusValue }>> {
  // Both arrive from the browser; anything that is not a status is refused
  // before it can reach a write or a log line.
  const statuses: readonly string[] = championshipStatus.enumValues;
  if (!statuses.includes(from) || !statuses.includes(status)) {
    return { ok: false, error: "That is not a championship status." };
  }
  const admin = await requireAdmin();

  const result = await setChampionshipStatus(championshipId, from, status, {
    confirm: options.confirm === true,
  });
  if (!result.ok) return result;

  const reopened = from === "closed" && status === "published";
  await recordAudit(
    reopened
      ? {
          action: "championship.reopened",
          actor: admin,
          subject: championshipId,
          summary: `${admin.displayName ?? admin.name ?? "An admin"} reopened "${result.data.name}".`,
          detail: { from: "closed", status: "published" },
        }
      : {
          action: "championship.status",
          actor: admin,
          subject: championshipId,
          summary: `Moved "${result.data.name}" to ${result.data.status}.`,
          detail: { status: result.data.status, confirmed: options.confirm === true },
        }
  );

  refresh(championshipId);
  return { ok: true, data: { status: result.data.status } };
}
