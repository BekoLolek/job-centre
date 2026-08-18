"use server";

/**
 * The server actions behind `/admin/settings`.
 *
 * As thin as every other action file here: the shape of the setting and its
 * defaults are `src/lib/announce.ts`'s, the write is `setAnnouncementSettings`'s,
 * and nothing below re-decides either. `requireAdmin()` runs inside the action
 * rather than being trusted from the page that rendered the switch, because a
 * server action is a public endpoint.
 *
 * The change is audited. Which announcements fire is a decision about what the
 * whole server sees, so "who turned the result announcements off, and when" is
 * exactly the sort of question the log exists to answer.
 */

import { revalidatePath } from "next/cache";
import { type AnnouncementSettings, normaliseAnnouncementSettings } from "@/lib/announce";
import { recordAudit } from "@/lib/audit";
import { getAnnouncementSettings, setAnnouncementSettings } from "@/lib/discord";
import type { EventResult } from "@/lib/events";
import { requireAdmin } from "@/lib/session-guards";

export async function saveAnnouncementSettingsAction(
  patch: Record<string, boolean>
): Promise<EventResult<{ settings: AnnouncementSettings }>> {
  const admin = await requireAdmin();

  // Normalised rather than trusted: a payload from a stale tab may name a kind
  // that no longer exists, and one from anywhere else may not be booleans at
  // all. `normaliseAnnouncementSettings` keeps the known kinds and fills the
  // rest from the defaults, so what is stored is always a complete object.
  const before = await getAnnouncementSettings();
  const next = normaliseAnnouncementSettings(patch);
  const stored = await setAnnouncementSettings(next);

  const changed = (Object.keys(stored) as Array<keyof AnnouncementSettings>).filter(
    (kind) => before[kind] !== stored[kind]
  );

  if (changed.length > 0) {
    await recordAudit({
      action: "settings.announcements",
      actor: admin,
      summary: `Discord announcements: ${changed
        .map((kind) => `${kind} ${stored[kind] ? "on" : "off"}`)
        .join(", ")}.`,
      detail: { ...stored },
    });
  }

  revalidatePath("/admin/settings");
  return { ok: true, data: { settings: stored } };
}
