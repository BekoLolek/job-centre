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
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  type AnnouncementSettings,
  normaliseAnnouncementSettings,
} from "@/lib/announce";
import { maskWebhook, resolveSiteOrigin, resolveWebhookUrl } from "@/lib/announce";
import { recordAudit } from "@/lib/audit";
import { getGateConfig, setGateConfig } from "@/lib/auth";
import { getIntegrationConfig, setIntegrationSetting } from "@/lib/discord";
import { SETTING_KEYS } from "@/db/schema";
import {
  type TemplateSaveResult,
  getAnnouncementSettings,
  setAnnouncementSettings,
  setAnnouncementTemplate,
} from "@/lib/discord";
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

/**
 * One kind's wording and mention choice (R-201, R-202 / UC-37 6, 7, 7a).
 *
 * Thin, like every other action here: the refusals, the version check, the
 * conflict's `current` row and both audit lines are `setAnnouncementTemplate`'s,
 * and nothing below re-decides any of them. What this adds is the two things an
 * action owes: `requireAdmin()`, because a server action is a public endpoint
 * whatever rendered the form, and a sceptical read of the payload.
 *
 * ## What is checked here, and what is deliberately not
 *
 * The **kind** is checked against `ANNOUNCEMENTS`, because it is the primary key
 * of the row being written and a kind that does not exist is not a refusal an
 * admin should have to read — it is a stale tab or somebody poking the endpoint.
 *
 * The **role ids are not cleaned**. `announcementTemplateFrom` would be the
 * obvious thing to run the payload through, and it is the wrong one: it *drops*
 * anything that is not a snowflake, so an admin who pasted a role name would
 * get a successful save with their mention silently missing. UC-37 wants them
 * told. So the strings are passed through as strings and
 * `announcementTemplateProblem` — asked first, inside
 * `setAnnouncementTemplate` — refuses them by name. The only coercion is to the
 * declared types, which is what stops a non-string reaching a regular
 * expression.
 */
export async function saveAnnouncementTemplateAction(input: {
  kind: string;
  body: string | null;
  everyone: boolean;
  roleIds: string[];
  /** The version the editor was opened at. `0` is a kind with no row. */
  expectedVersion: number;
}): Promise<TemplateSaveResult> {
  const admin = await requireAdmin();

  const kind = ANNOUNCEMENTS.find((spec) => spec.kind === input.kind)?.kind;
  if (!kind) {
    return { ok: false, error: "There is no announcement of that kind." };
  }

  const body = typeof input.body === "string" ? input.body : null;
  const roleIds = Array.isArray(input.roleIds)
    ? input.roleIds.filter((id): id is string => typeof id === "string")
    : [];
  const expectedVersion =
    Number.isInteger(input.expectedVersion) && input.expectedVersion >= 0
      ? input.expectedVersion
      : 0;

  const result = await setAnnouncementTemplate(
    kind satisfies AnnouncementKind,
    { body, mention: { everyone: input.everyone === true, roleIds } },
    { expectedVersion, actor: admin }
  );

  // Only on a save that happened. A refusal and a lost race both leave the row
  // as it was, and re-rendering the page under a conflict would replace the
  // admin's unsaved words with the ones that beat them.
  if (result.ok) revalidatePath("/admin/settings");
  return result;
}

/* ------------------------------------------------------------------ */
/* Who may sign in                                                    */
/* ------------------------------------------------------------------ */

export type ConfigResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Point sign-in at a different Discord server, or stop gating it.
 *
 * Two ways to lock everybody out, and the screen warns about both, but the
 * refusals here are what actually prevent them, because a warning is only as
 * good as the person reading it:
 *
 *  - **A guild id that is not a snowflake.** Gated against a server that does
 *    not exist, nobody's membership check can pass. Numeric-only, 17-20
 *    digits, which is what a Discord id is.
 *  - **The gate on with no server at all.** Refused outright — with the gate
 *    on and no id, `configured` is false and every sign-in fails closed.
 *
 * What is deliberately *not* refused is turning the gate off. That opens the
 * site to any Discord account in the world, which is a real decision an admin
 * is allowed to make; the screen says so in as many words first.
 */
export async function saveGuildGateAction(input: {
  enabled: boolean;
  guildId: string;
}): Promise<ConfigResult<{ enabled: boolean; guildId: string; source: string }>> {
  const admin = await requireAdmin();

  const guildId = input.guildId.trim();
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    return {
      ok: false,
      error:
        "A Discord server id is 17 to 20 digits and nothing else. Right-click the server → Copy Server ID, with Developer Mode on.",
    };
  }

  const before = await getGateConfig();
  if (input.enabled && !guildId && !before.guildId) {
    return {
      ok: false,
      error:
        "The gate is on and no server is set, here or in DISCORD_GUILD_ID. That would refuse everybody, including you.",
    };
  }

  const after = await setGateConfig({ enabled: input.enabled, guildId: guildId || null });

  await recordAudit({
    action: "settings.guild_gate",
    actor: admin,
    summary: after.enabled
      ? `Sign-in gated on server ${after.guildId || "(none)"}.`
      : "Sign-in opened to any Discord account.",
    detail: {
      enabled: after.enabled,
      guildId: after.guildId,
      was: { enabled: before.enabled, guildId: before.guildId },
    },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/signin");
  return {
    ok: true,
    data: { enabled: after.enabled, guildId: after.guildId, source: after.source.guildId },
  };
}

/* ------------------------------------------------------------------ */
/* Integrations                                                       */
/* ------------------------------------------------------------------ */

/**
 * The webhook and the site address.
 *
 * Both fields are "leave blank to keep what is there" rather than
 * "blank means clear", because the webhook is only ever shown masked — a form
 * that treated an untouched masked field as an instruction to clear would
 * delete it every time somebody edited the address next to it. Clearing is its
 * own explicit flag.
 *
 * Every field is checked before anything is written. A good webhook next to a
 * mistyped address is refused whole, so "That is not a URL" always means the
 * old values are still the ones in force — never half of a save.
 */
export async function saveIntegrationsAction(input: {
  webhookUrl?: string;
  clearWebhook?: boolean;
  siteOrigin?: string;
  clearSiteOrigin?: boolean;
}): Promise<ConfigResult<{ webhook: string | null; origin: string | null }>> {
  const admin = await requireAdmin();
  const changed: string[] = [];

  const webhook = input.clearWebhook ? "" : (input.webhookUrl ?? "").trim();
  if (webhook && !resolveWebhookUrl(webhook, {})) {
    return { ok: false, error: "That is not a URL. A webhook looks like https://discord.com/api/webhooks/…" };
  }

  const rawOrigin = input.clearSiteOrigin ? "" : (input.siteOrigin ?? "").trim();
  // Stored as an origin, so a pasted link with a path on it does not put
  // /admin/settings in front of every announcement link forever.
  const origin = rawOrigin ? resolveSiteOrigin(rawOrigin, {}) : null;
  if (rawOrigin && !origin) {
    return { ok: false, error: "That is not a URL. It should look like https://jobcentre.vercel.app" };
  }

  if (input.clearWebhook) {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
    changed.push("webhook cleared");
  } else if (webhook) {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, webhook);
    changed.push("webhook set");
  }

  if (input.clearSiteOrigin) {
    await setIntegrationSetting(SETTING_KEYS.siteOrigin, null);
    changed.push("address cleared");
  } else if (origin) {
    await setIntegrationSetting(SETTING_KEYS.siteOrigin, origin);
    changed.push("address set");
  }

  const after = await getIntegrationConfig();

  if (changed.length > 0) {
    await recordAudit({
      action: "settings.integrations",
      actor: admin,
      summary: `Integrations changed — ${changed.join(", ")}.`,
      // The webhook is never written to the audit log in full: the log is a
      // screen an admin can read, and this is a credential.
      detail: {
        changed,
        origin: after.origin,
        webhookConfigured: Boolean(after.webhook),
        // Read by the admin home: a webhook set or cleared is what clears the
        // failed announcements listed there. A flag, not the wording above.
        webhookChanged: Boolean(input.clearWebhook || webhook),
      },
    });
  }

  revalidatePath("/admin/settings");
  return { ok: true, data: { webhook: maskWebhook(after.webhook), origin: after.origin } };
}
