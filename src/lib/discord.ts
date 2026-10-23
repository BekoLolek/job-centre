/**
 * Posting the announcements (docs/platform-plan.md §14, checklist.md F2).
 *
 * `./announce` decides what a message *says*; this is the only place that talks
 * to the outside world, and it exists as its own module so that the sentences
 * can be tested exhaustively without a single test ever making a request.
 *
 * ## The non-negotiable
 *
 * **A missing or broken webhook must never fail the action that triggered it.**
 * The member's application succeeded whether or not Discord heard about it, and
 * a lot that was awarded stays awarded if the channel has been deleted. Three
 * separate things enforce that:
 *
 *  1. {@link announce} is `void`, not `Promise<void>`. There is nothing to
 *     await, so no caller can accidentally make the response wait on a network
 *     round trip — and no caller can accidentally propagate a rejection either.
 *  2. The work is handed to Next's `after()`, which runs it once the response
 *     has been sent. The request is finished before the `fetch` starts.
 *  3. Every path inside {@link deliver} is inside a `try`. A DNS failure, a 404
 *     from a deleted webhook, a 429, a timeout and a malformed URL all end in
 *     the same place: a console line and a row in the audit log.
 *
 * ## …and the failure is visible
 *
 * Swallowing an error silently is the other way to get this wrong. A failure
 * writes `announcement.failed` to the audit log with the status code and the
 * kind, so `/admin/audit` shows "Announcement failed — event published, 404"
 * next to everything else that happened that night. The console line is for
 * whoever is watching the server; the audit row is for whoever is not.
 *
 * ## Switched off by default
 *
 * The webhook resolves from the settings screen first and `DISCORD_WEBHOOK_URL`
 * second (`getIntegrationConfig`). With neither set, `deliver` finds nowhere to
 * post and returns before it reads a switch or makes a request — nothing is
 * sent and nothing is logged as failed. The whole feature is an inert no-op,
 * exactly as blank Discord credentials are on `/signin`.
 */

import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  type Database,
  SETTING_KEYS,
  announcementClaims,
  announcementTemplates,
  applications,
  db as defaultDb,
  draftLots,
  events,
  matches,
  settings,
  teams,
  users,
} from "@/db";
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  type AnnouncementSettings,
  type AnnouncementTemplate,
  type DiscordMessage,
  NO_MENTION,
  announcementSettingsFrom,
  announcementSettingsValue,
  announcementTemplateFrom,
  announcementTemplateProblem,
  applicationDecidedMessage,
  eventPublishedMessage,
  eventStartingSoonMessage,
  lotSoldMessage,
  matchResultMessage,
  mentionLine,
  signupsClosingSoonMessage,
  signupsOpenMessage,
  stamp,
  standingsMessage,
  type AnnounceEnv,
  resolveSiteOrigin,
  resolveWebhookUrl,
  siteOrigin,
} from "./announce";
import {
  MANUAL_ANNOUNCEMENT_NAMES,
  MANUAL_REFUSALS,
  type ManualAnnouncementFacts,
  type ManualAnnouncementKind,
  failedNote,
  manualAnnouncementDetail,
  manualPostRefusal,
  offeredManualKinds,
} from "./announce-manual";
import { dueScheduledAnnouncements } from "./announce-schedule";
import { type Movement, topOfTheTable } from "./championship-policy";
import { seasonOfEvent, seasonPage } from "./championship-season";
import { recordAudit } from "./audit";
import { eventIdOfApplication, eventIdOfMatch } from "./event-scope";
import { readDatesFor } from "./events";
import { capacityState } from "./events-policy";
import { formatFor } from "./format";

/* ------------------------------------------------------------------ */
/* The setting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which announcements are switched on.
 *
 * Never throws: a database that is down at the moment a lot is awarded must not
 * take the award with it, and "we could not read the setting" is not a reason
 * to post something nobody asked for either — so a failed read falls back to
 * the defaults with a logged line.
 */
export async function getAnnouncementSettings(
  database: Database = defaultDb
): Promise<AnnouncementSettings> {
  try {
    const [row] = await database
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTING_KEYS.announcements))
      .limit(1);
    return announcementSettingsFrom(row?.value);
  } catch (error) {
    console.error("[discord] could not read the announcement settings", error);
    return announcementSettingsFrom(undefined);
  }
}

/**
 * The webhook and the site address, settings first and environment second.
 *
 * Returned resolved rather than raw, so no caller ever has to remember the
 * precedence — the same bargain `loadGateConfig` makes for the guild gate.
 * `source` is what lets the settings screen say *where* a value came from,
 * which is the difference between "configured" and "configured, and here is
 * the one that is actually in force".
 */
export type IntegrationConfig = {
  webhook: string | null;
  origin: string | null;
  source: { webhook: "settings" | "env" | "none"; origin: "settings" | "env" | "none" };
};

export async function getIntegrationConfig(
  database: Database = defaultDb,
  env: AnnounceEnv = process.env as AnnounceEnv
): Promise<IntegrationConfig> {
  let storedWebhook: string | null = null;
  let storedOrigin: string | null = null;

  try {
    const rows = await database
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [SETTING_KEYS.webhookUrl, SETTING_KEYS.siteOrigin]));
    for (const row of rows) {
      const value = typeof row.value === "string" ? row.value : null;
      if (row.key === SETTING_KEYS.webhookUrl) storedWebhook = value;
      if (row.key === SETTING_KEYS.siteOrigin) storedOrigin = value;
    }
  } catch (error) {
    // Same rule as everywhere else here: a database that is down must not take
    // announcements down with it. The environment still knows what to do.
    console.error("[discord] could not read the integration settings", error);
  }

  const webhook = resolveWebhookUrl(storedWebhook, env);
  const origin = resolveSiteOrigin(storedOrigin, env);

  return {
    webhook,
    origin,
    source: {
      webhook: !webhook ? "none" : resolveWebhookUrl(storedWebhook, {}) ? "settings" : "env",
      origin: !origin ? "none" : resolveSiteOrigin(storedOrigin, {}) ? "settings" : "env",
    },
  };
}

/**
 * Write one integration setting. `null` clears it, which drops the value back
 * to whatever the environment says rather than switching the feature off — a
 * cleared override is an absence of opinion, not an instruction.
 */
export async function setIntegrationSetting(
  key: typeof SETTING_KEYS.webhookUrl | typeof SETTING_KEYS.siteOrigin,
  value: string | null,
  database: Database = defaultDb
): Promise<void> {
  if (value === null) {
    await database.delete(settings).where(eq(settings.key, key));
    return;
  }
  await database
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** Write the whole toggle set. The admin screen sends every switch together. */
export async function setAnnouncementSettings(
  next: AnnouncementSettings,
  database: Database = defaultDb
): Promise<AnnouncementSettings> {
  const value = announcementSettingsValue(next);
  await database
    .insert(settings)
    .values({ key: SETTING_KEYS.announcements, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
  return announcementSettingsFrom(value);
}

/* ------------------------------------------------------------------ */
/* The wording (R-201, R-202 / UC-37)                                 */
/* ------------------------------------------------------------------ */

/**
 * A stored override, with the bookkeeping a screen needs around it.
 *
 * `version` is what an editor is opened at and saved against (UC-37 7a), and
 * `0` is the version of a kind with no row — "nobody has touched this", which
 * is the state every kind starts in and the reason drizzle/0029 has no
 * backfill.
 */
export type StoredAnnouncementTemplate = AnnouncementTemplate & {
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

/** The default a kind has until somebody edits it: the compiled copy, no mention. */
export function unedited(): StoredAnnouncementTemplate {
  return { body: null, mention: NO_MENTION, version: 0, updatedAt: null, updatedBy: null };
}

function storedFrom(row: {
  body: string | null;
  mentionEveryone: boolean;
  mentionRoleIds: string[];
  version: number;
  updatedAt: Date;
  updatedBy: string | null;
}): StoredAnnouncementTemplate {
  /*
   * Through `announcementTemplateFrom` rather than straight off the row, so the
   * one reader that decides what a stored shape means is the one in
   * `./announce` — including the rule that a role id which is not a snowflake
   * is not a role id, and that only a real `true` is "everyone". A row written
   * by an older screen is a normal thing to meet (`announcementSettingsFrom`).
   */
  const clean = announcementTemplateFrom({
    body: row.body,
    everyone: row.mentionEveryone,
    roleIds: row.mentionRoleIds,
  });
  return {
    ...clean,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

const TEMPLATE_COLUMNS = {
  kind: announcementTemplates.kind,
  body: announcementTemplates.body,
  mentionEveryone: announcementTemplates.mentionEveryone,
  mentionRoleIds: announcementTemplates.mentionRoleIds,
  version: announcementTemplates.version,
  updatedAt: announcementTemplates.updatedAt,
  updatedBy: announcementTemplates.updatedBy,
} as const;

/**
 * Every kind's wording, edited or not — one row per kind in `ANNOUNCEMENTS`.
 *
 * Never throws, for the reason `getAnnouncementSettings` does not: a database
 * that is down at the moment a lot is awarded must not take the award with it,
 * and "we could not read the wording" is emphatically not a reason to post
 * something other than the compiled copy. A failed read therefore answers
 * "nobody has edited anything", which is the one answer that cannot surprise
 * anybody — and in particular cannot mention anyone.
 */
export async function getAnnouncementTemplates(
  database: Database = defaultDb
): Promise<Record<AnnouncementKind, StoredAnnouncementTemplate>> {
  const out = {} as Record<AnnouncementKind, StoredAnnouncementTemplate>;
  for (const spec of ANNOUNCEMENTS) out[spec.kind] = unedited();

  try {
    const rows = await database.select(TEMPLATE_COLUMNS).from(announcementTemplates);
    for (const row of rows) {
      // A row naming a kind that no longer exists is simply not read — the same
      // way a stale key in the switches object is already dropped.
      if (row.kind in out) out[row.kind as AnnouncementKind] = storedFrom(row);
    }
  } catch (error) {
    console.error("[discord] could not read the announcement wording", error);
  }

  return out;
}

/** One kind's wording. The compiled copy when there is no row, or no database. */
export async function getAnnouncementTemplate(
  kind: AnnouncementKind,
  database: Database = defaultDb
): Promise<StoredAnnouncementTemplate> {
  try {
    const [row] = await database
      .select(TEMPLATE_COLUMNS)
      .from(announcementTemplates)
      .where(eq(announcementTemplates.kind, kind))
      .limit(1);
    return row ? storedFrom(row) : unedited();
  } catch (error) {
    console.error(`[discord] could not read the "${kind}" announcement wording`, error);
    return unedited();
  }
}

export type TemplateSaveResult =
  | { ok: true; data: StoredAnnouncementTemplate }
  | { ok: false; error: string; current?: StoredAnnouncementTemplate };

/**
 * Store one kind's wording and mention choice.
 *
 * ## Refused before anything is written
 *
 * Every refusal is `announcementTemplateProblem`'s, asked **first**, so a
 * wording with a placeholder the kind does not offer, an empty one, one over
 * Discord's limit, or a role "id" that is really a role name, leaves the
 * database exactly as it was (UC-37 3a, 3b, 3c). None of them is a failed post
 * discovered in a quiet channel.
 *
 * ## Two admins at once (UC-37 7a)
 *
 * `expectedVersion` is the version the editor was opened at. The write is
 * conditional on it, in one statement, so the database decides the winner:
 *
 *  - **A kind with no row** is saved with an INSERT that does nothing on a
 *    primary-key conflict. If somebody else created the row in between, no row
 *    comes back and this save is the loser.
 *  - **A kind with a row** is saved with an UPDATE matching on both the kind
 *    *and* the version. The second of two saves matches nothing.
 *
 * The loser is told the wording moved and handed the current row, which is what
 * the screen shows them — rather than having their words silently win or
 * silently vanish. Read-then-write would have both saves read version 3 and
 * both write version 4; the condition is in the statement precisely so there is
 * no gap between the read and the write for the other admin to land in.
 */
export async function setAnnouncementTemplate(
  kind: AnnouncementKind,
  template: AnnouncementTemplate,
  options: {
    expectedVersion: number;
    actor?: { id: string; displayName?: string | null; name?: string | null } | null;
  },
  database: Database = defaultDb
): Promise<TemplateSaveResult> {
  const problem = announcementTemplateProblem(kind, template);
  if (problem) return { ok: false, error: problem };

  const moved = async (): Promise<TemplateSaveResult> => ({
    ok: false,
    error: "Somebody else changed this announcement while you were editing it.",
    current: await getAnnouncementTemplate(kind, database),
  });

  const body = template.body;
  const values = {
    kind,
    body,
    mentionEveryone: template.mention.everyone,
    mentionRoleIds: [...template.mention.roleIds],
    updatedAt: new Date(),
    updatedBy: options.actor?.id ?? null,
  };

  const before =
    options.expectedVersion > 0 ? await getAnnouncementTemplate(kind, database) : unedited();

  let saved: StoredAnnouncementTemplate | null = null;

  if (options.expectedVersion <= 0) {
    const [row] = await database
      .insert(announcementTemplates)
      .values({ ...values, version: 1 })
      .onConflictDoNothing({ target: announcementTemplates.kind })
      .returning(TEMPLATE_COLUMNS);
    saved = row ? storedFrom(row) : null;
  } else {
    const [row] = await database
      .update(announcementTemplates)
      .set({ ...values, version: options.expectedVersion + 1 })
      .where(
        and(
          eq(announcementTemplates.kind, kind),
          eq(announcementTemplates.version, options.expectedVersion)
        )
      )
      .returning(TEMPLATE_COLUMNS);
    saved = row ? storedFrom(row) : null;
  }

  if (!saved) return moved();

  /*
   * The log, after the write. `recordAudit` never throws (its own comment says
   * why), so a full log cannot turn a saved wording into a failed save.
   */
  const line = mentionLine(saved.mention);
  await recordAudit({
    action: "announcement.wording_changed",
    summary: `The “${kind}” announcement was edited${line ? ` and now mentions ${line}` : ""}.`,
    actor: options.actor ?? null,
    subject: kind,
    detail: {
      kind,
      edited: saved.body !== null,
      everyone: saved.mention.everyone,
      roleIds: [...saved.mention.roleIds],
      version: saved.version,
    },
  });

  /*
   * And a line of its own the first time a kind is set to ping the whole server
   * (UC-37 4c). A second row rather than a flag buried in the one above,
   * because "who made an announcement ping four hundred people" is a question
   * somebody asks of the audit log by scanning it, and `everyone: true` inside
   * a detail blob is not something a scan finds. Only on the transition, so
   * editing the wording of an already-pinging announcement does not re-raise
   * it every time.
   */
  if (saved.mention.everyone && !before.mention.everyone) {
    await recordAudit({
      action: "announcement.pings_everyone",
      summary: `The “${kind}” announcement now pings the whole server.`,
      actor: options.actor ?? null,
      subject: kind,
      detail: { kind, version: saved.version },
    });
  }

  return { ok: true, data: saved };
}

/* ------------------------------------------------------------------ */
/* Posting                                                            */
/* ------------------------------------------------------------------ */

/** How long a webhook gets before we give up on it. */
const TIMEOUT_MS = 5_000;

export type AnnounceContext = {
  /** So a failure shows up under the right event on `/admin/audit`. */
  eventId?: string | null;
};

/**
 * Post one announcement, after the response has gone out.
 *
 * Returns nothing, synchronously. Read the module comment before changing that:
 * the signature *is* the guarantee.
 */
export function announce(
  kind: AnnouncementKind,
  message: DiscordMessage,
  context: AnnounceContext = {}
): void {
  /*
   * There used to be a synchronous environment-only webhook check here, to avoid
   * scheduling work on an install with no webhook. It read the environment
   * only, so once the webhook could also come from the settings table it
   * became a guard that silently dropped every announcement on any install
   * configured through the screen rather than through Vercel.
   *
   * `deliver` makes the same check with the full answer. What that costs is a
   * deferred function that reads one row and returns — after the response has
   * already gone out.
   */
  defer(() => deliver(kind, message, context));
}

/**
 * As {@link announce}, but the message is *gathered* after the response too.
 *
 * The four announcers below need a name, a team, a title and a slug that the
 * action does not have to hand, and reading them before returning would put
 * three queries in front of the member's "you're in" — for a message they are
 * not waiting for. So the whole job, reads included, happens in `after()`, and
 * the action hands over an id.
 *
 * A builder that returns `null` means "on reflection, do not post": a part-
 * recorded series, a lot that turned out not to be an award, a row that has
 * been changed again since. That is a decision the gathered data makes, so it
 * belongs here rather than in the action.
 *
 * A builder that returns something says which kind it turned out to be and
 * which event it was about. The kind, because an application decision is not
 * accepted, waitlisted or declined until its row has been read — so `kinds`
 * lists everything it *could* be, the reads are skipped only when all of those
 * are off, and the switch that decides is the one `deliver` checks for the
 * kind that came back. The event, because the action only had a lot or a match
 * id, and a failure not filed under its event is a failure nobody filtering the
 * audit log by that event will ever see.
 *
 * A build that *throws* has returned no event, so `about` says how to find it
 * anyway: the id the announcement was called with, and how to look up its
 * event from that.
 */
type Gathered = { kind: AnnouncementKind; message: DiscordMessage; eventId: string };

type About = { subject: Record<string, string>; eventOf: () => Promise<string | null> };

function announceGathered(
  kinds: readonly AnnouncementKind[],
  build: () => Promise<Gathered | null>,
  about: About
): void {
  // Checked in `deliver`, with the settings included — see `announce` above.
  defer(async () => {
    let gathered: Gathered | null = null;
    try {
      const enabled = await getAnnouncementSettings();
      if (!kinds.some((kind) => enabled[kind])) return;
      gathered = await build();
    } catch (error) {
      const { eventId, detail } = await whereItFailed(about);
      await noteFailure(
        // The kind itself when the caller's is fixed; every kind a decision
        // could have been when the row that says which was never read.
        kinds.join(" / "),
        { eventId },
        error instanceof Error
          ? `it could not be built (${error.message})`
          : "it could not be built",
        detail
      );
      return;
    }
    if (gathered) {
      await deliver(gathered.kind, gathered.message, { eventId: gathered.eventId });
    }
  });
}

/**
 * The event a failed build belongs to, for its audit row.
 *
 * When even that lookup fails — the database is the likeliest reason the build
 * threw in the first place — the row goes in without an event, carrying the id
 * the announcement was called with so it can still be traced by hand.
 */
async function whereItFailed(
  about: About
): Promise<{ eventId: string | null; detail: Record<string, string> }> {
  try {
    const eventId = await about.eventOf();
    if (eventId) return { eventId, detail: {} };
  } catch (error) {
    console.error("[discord] could not find the event of a failed announcement", error);
  }
  return { eventId: null, detail: about.subject };
}

/**
 * Run something once the response is sent.
 *
 * `after()` is the correct home for this on a deployment: it keeps the work
 * inside the request's lifetime so a serverless function is not frozen halfway
 * through the `fetch`, without the response waiting for it. Outside a request
 * scope — a script, a test, a background job — `after()` throws, and there a
 * detached promise is both available and fine.
 */
function defer(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    void work().catch((error: unknown) => {
      console.error("[discord] announcement failed outside a request scope", error);
    });
  }
}

/**
 * The origin links in a message point at, resolved the same way the webhook is.
 *
 * Called per message rather than threaded through, because every one of these
 * runs inside `after()` — one extra row read on a job the reader is not
 * waiting for is not worth the argument it would otherwise have to carry
 * through four builders.
 */
async function announceOrigin(): Promise<string | null> {
  return (await getIntegrationConfig()).origin;
}

/**
 * The admin's wording for a kind, read at post time rather than at trigger time.
 *
 * Per message and inside `after()`, for the same reason `announceOrigin` is: one
 * extra row read on a job nobody is waiting for is cheaper than an argument
 * threaded through five builders. Reading it at post time is also the correct
 * answer rather than the convenient one — an admin who fixes a typo in the
 * seconds between a lot being awarded and the callback running should have the
 * fixed sentence posted, not the one that was stored when the hammer fell.
 */
async function wordingFor(
  kind: AnnouncementKind,
  database: Database
): Promise<AnnouncementTemplate> {
  // The caller's database, not the default one: an announcer takes a `database`
  // so a test can hand it one, and a read that ignored it would be reading a
  // different database from the one the row it is announcing came out of.
  return getAnnouncementTemplate(kind, database);
}

async function deliver(
  kind: AnnouncementKind,
  message: DiscordMessage,
  context: AnnounceContext
): Promise<void> {
  /*
   * Taken before the webhook is read, and used as the failure's timestamp. The
   * admin home stops listing failures older than the latest webhook save, so a
   * post that set off against the old webhook and was refused after somebody
   * replaced it must be stamped from before the save — it failed against the
   * webhook that save replaced, not the new one.
   */
  const startedAt = new Date();
  const { webhook: url } = await getIntegrationConfig();
  if (!url) return;

  const enabled = await getAnnouncementSettings();
  if (!enabled[kind]) return;

  const sent = await sendToDiscord(url, message);
  if (!sent.ok) await noteFailure(kind, context, sent.reason, sent.detail, startedAt);
}

/**
 * What came of one request to the webhook. Never throws.
 *
 * The request itself, separated from what is done about it, because there are
 * now two callers that want the same request and *different* answers to it:
 * {@link deliver} swallows the outcome into an audit row, because nobody is
 * waiting for it, and {@link postAnnouncementByHand} has an admin watching who
 * must not be told it worked (UC-43 5a). A single function that did both would
 * have to decide that for its callers.
 *
 * Both failure sentences are the ones `deliver` has always written, moved rather
 * than reworded: they are what `/admin/audit` reads, and the admin home filters
 * on the rows they are in.
 */
type Delivery =
  | { ok: true }
  | { ok: false; reason: string; detail: Record<string, string | number> };

async function sendToDiscord(url: string, message: DiscordMessage): Promise<Delivery> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never cached, never deduplicated: two awards for the same price at the
      // same second are two announcements.
      cache: "no-store",
    });

    if (response.ok) return { ok: true };
    return {
      ok: false,
      reason: `Discord answered ${response.status}.`,
      detail: { status: response.status },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The request did not complete.",
      detail: {},
    };
  }
}

/**
 * Take the once-per-event claim for one (kind, event), and say whether **this**
 * call got it.
 *
 * `announcement_claims` is keyed `(kind, event_id)`, the insert does nothing on
 * a conflict, and the row that comes back is the whole of the answer: a caller
 * that gets no row did not win, and must not post on the strength of having
 * tried. Shared by the scheduler and by the by-hand path rather than written
 * twice, because "did I get it" is exactly the question two copies would
 * eventually answer differently.
 */
async function claimAnnouncement(
  kind: AnnouncementKind,
  eventId: string,
  database: Database
): Promise<boolean> {
  const rows = await database
    .insert(announcementClaims)
    .values({ kind, eventId })
    .onConflictDoNothing({
      target: [announcementClaims.kind, announcementClaims.eventId],
    })
    .returning({ kind: announcementClaims.kind });
  return rows.length === 1;
}

/**
 * Record that an announcement did not go out.
 *
 * Itself wrapped, because the whole point of this module is that nothing it
 * does can throw into a caller — and `after()`'s callback rejecting would be a
 * logged unhandled rejection in production for no benefit.
 */
async function noteFailure(
  // A kind, or the kinds a build that failed before its read could have been.
  kind: string,
  context: AnnounceContext,
  reason: string,
  detail: Record<string, string | number>,
  // When the attempt began; see `deliver`. A build failure is stamped now.
  at: Date = new Date()
): Promise<void> {
  console.error(`[discord] the "${kind}" announcement failed: ${reason}`);
  try {
    await recordAudit({
      action: "announcement.failed",
      summary: `The "${kind}" announcement did not go out — ${reason}`,
      eventId: context.eventId ?? null,
      subject: kind,
      detail: { kind, reason, ...detail },
      now: at,
    });
  } catch (error) {
    console.error("[discord] could not record the announcement failure either", error);
  }
}

/* ------------------------------------------------------------------ */
/* The five announcers                                                */
/* ------------------------------------------------------------------ */

/**
 * Every one of these takes an **id** and returns nothing, synchronously.
 *
 * An id rather than a built message, because the alternative is an action
 * assembling a Discord payload — which would put the wording of an announcement
 * in the one layer that is supposed to guard and delegate, and would let two
 * call sites describe the same event differently. An id is also the only thing
 * an action reliably has: `recordGames` hands back a finish time, not a
 * scoreline.
 */

/**
 * An event went public.
 *
 * The "Starts" field is the event's **derived** start — its first dated day's
 * (R-24) — read with `readDatesFor` rather than off the event row. There is no
 * start on the event row to read: Task 12 stopped reading `events.starts_at`
 * and `events.ends_at`, drizzle/0020 moved every event's date into
 * `event_days`, and drizzle/0026 dropped both columns (Task 50). Taking the
 * start off the row would not compile, and before the drop it was worse than
 * that — it compiled, answered `null`, and `eventPublishedMessage` drops the
 * field when it is null, so the channel message went out missing the one fact a
 * reader needs before deciding whether to apply (R-107 / UC-26 4).
 *
 * The extra read is the days, which is the only place the answer exists.
 *
 * The **signup window's start and the instant this is happening at** are the
 * other pair the message cannot be built without (R-205 / UC-38 2): an event
 * published a week ahead of its window must not be announced as one taking
 * applications, and `eventPublishedMessage` can only tell the two apart if this
 * call site says when each is. Both come from here rather than from the
 * builder: `signup_opens_at` is a stored column, and the clock is this module's
 * to read — `announce.ts` is pure, which is what makes its two sentences
 * testable without a fake clock.
 */
export function announceEventPublished(eventId: string, database: Database = defaultDb): void {
  announceGathered(
    ["event_published"],
    async () => {
      const [event] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
      // Only ever announce something that is actually published — a status that
      // moved on again between the click and the callback is not news. Checked
      // before the days are read, so nothing is read for a non-announcement.
      if (!event || event.status !== "published") return null;

      const dates = await readDatesFor(database, [eventId]);

      return {
        kind: "event_published",
        eventId,
        message: eventPublishedMessage(
          {
            title: event.title,
            slug: event.slug,
            type: event.type,
            description: event.description,
            capacity: event.capacity,
            startsAt: dates.get(eventId)?.startsAt ?? null,
            signupOpensAt: event.signupOpensAt,
            /*
             * Now, not a stored publish instant: `events` has no `published_at`
             * column, and the moment is knowable only while it is happening
             * (see `publishingOpensSignups`). `announceGathered` defers this
             * build until after the response, so "now" is a moment or two after
             * the status moved — which cannot change the answer, because a
             * window either opened before the click or opens on a later day.
             */
            publishedAt: new Date(),
            signupClosesAt: event.signupClosesAt,
            origin: await announceOrigin(),
          },
          await wordingFor("event_published", database)
        ),
      };
    },
    { subject: { eventId }, eventOf: async () => eventId }
  );
}

/**
 * Somebody was accepted, waitlisted or declined.
 *
 * Each has its own switch, and the one that decides is the one matching the
 * row as it reads now — so "accepted off, waitlisted on" still posts a
 * waitlisting. Declined defaults off: being turned down is somebody's
 * afternoon, so it is posted only when an admin has asked for it. `withdrawn`
 * and `pending` are never announced; a member changing their mind, and an
 * application nobody has looked at yet, are nobody else's news.
 */
export function announceApplicationDecision(
  applicationId: string,
  database: Database = defaultDb
): void {
  const kinds = {
    accepted: "application_accepted",
    waitlisted: "application_waitlisted",
    declined: "application_declined",
  } as const;

  announceGathered(
    Object.values(kinds),
    async () => {
      const [row] = await database
        .select({
          status: applications.status,
          waitlistPosition: applications.waitlistPosition,
          eventId: applications.eventId,
          member: users.displayName,
          fallbackName: users.name,
          eventTitle: events.title,
          slug: events.slug,
        })
        .from(applications)
        .innerJoin(users, eq(applications.userId, users.id))
        .innerJoin(events, eq(applications.eventId, events.id))
        .where(eq(applications.id, applicationId))
        .limit(1);

      // `withdrawn` is the member changing their mind, and `pending` is an
      // approval event's application still waiting for a manager (R-27).
      // Neither is a decision, so neither is anybody else's news.
      if (!row || row.status === "withdrawn" || row.status === "pending") return null;

      // This kind's own switch is checked in `deliver`.
      const kind = kinds[row.status];
      return {
        kind,
        eventId: row.eventId,
        message: applicationDecidedMessage(
          kind,
          {
            member: row.member ?? row.fallbackName ?? "A member",
            eventTitle: row.eventTitle,
            slug: row.slug,
            waitlistPosition: row.waitlistPosition,
            origin: await announceOrigin(),
          },
          // The kind the row turned out to be, so an admin who edited the
          // waitlist wording does not also change what an acceptance says.
          await wordingFor(kind, database)
        ),
      };
    },
    {
      subject: { applicationId },
      eventOf: () => eventIdOfApplication(applicationId, database),
    }
  );
}

/** A lot settled with a winner and a price. */
export function announceLotSold(lotId: string, database: Database = defaultDb): void {
  announceGathered(
    ["draft_lot_sold"],
    async () => {
      const [row] = await database
        .select({
          status: draftLots.status,
          price: draftLots.price,
          eventId: draftLots.eventId,
          player: users.displayName,
          fallbackName: users.name,
          team: teams.name,
          eventTitle: events.title,
          slug: events.slug,
        })
        .from(draftLots)
        .innerJoin(users, eq(draftLots.playerUserId, users.id))
        .innerJoin(teams, eq(draftLots.winnerTeamId, teams.id))
        .innerJoin(events, eq(draftLots.eventId, events.id))
        .where(eq(draftLots.id, lotId))
        .limit(1);

      // A lot voided in the seconds between the award and the callback must not
      // be announced as a sale — the undo is the whole reason lots are rows.
      if (!row || row.status !== "awarded") return null;

      return {
        kind: "draft_lot_sold",
        eventId: row.eventId,
        message: lotSoldMessage(
          {
            player: row.player ?? row.fallbackName ?? "A player",
            team: row.team,
            price: row.price ?? 0,
            eventTitle: row.eventTitle,
            slug: row.slug,
            origin: await announceOrigin(),
          },
          await wordingFor("draft_lot_sold", database)
        ),
      };
    },
    {
      subject: { lotId },
      eventOf: async () => {
        const [lot] = await database
          .select({ eventId: draftLots.eventId })
          .from(draftLots)
          .where(eq(draftLots.id, lotId))
          .limit(1);
        return lot?.eventId ?? null;
      },
    }
  );
}

/**
 * A series was decided.
 *
 * Nothing is posted for a card that is half filled in. `recordGames` is called
 * on every keystroke-sized save the results screen makes, and a channel that
 * says "0–0" four times before a match starts is a channel switched off within
 * the hour — so the announcement waits for `status === "done"`, which is
 * `format-resolve`'s own answer to "is this settled".
 */
export function announceMatchResult(matchId: string, database: Database = defaultDb): void {
  announceGathered(
    ["match_result"],
    async () => {
      const [match] = await database
        .select({ eventId: matches.eventId, slot: matches.slot })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!match) return null;

      const [event] = await database
        .select({ title: events.title, slug: events.slug })
        .from(events)
        .where(eq(events.id, match.eventId))
        .limit(1);
      if (!event) return null;

      const view = await formatFor(match.eventId, database);
      const resolved = view?.stages
        .flatMap((stage) => stage.matches)
        .find((row) => row.slot === match.slot);
      if (!resolved || resolved.status !== "done") return null;

      const named = new Map((view?.teams ?? []).map((team) => [team.id, team.name]));

      return {
        kind: "match_result",
        eventId: match.eventId,
        message: matchResultMessage(
          {
            label: resolved.displayLabel,
            teamA: resolved.nameA,
            teamB: resolved.nameB,
            gamesWonA: resolved.gamesWonA,
            gamesWonB: resolved.gamesWonB,
            winner: resolved.winner ? (named.get(resolved.winner) ?? null) : null,
            eventTitle: event.title,
            slug: event.slug,
            origin: await announceOrigin(),
          },
          await wordingFor("match_result", database)
        ),
      };
    },
    { subject: { matchId }, eventOf: () => eventIdOfMatch(matchId, database) }
  );
}

/**
 * A counting event was scored, so here is the new top of the table
 * (R-197, UC-36 3).
 *
 * Gathered after the response like the other four, and for a better reason
 * than any of them: the standings are not stored anywhere, so the message is a
 * re-score of the whole season from its recorded places. That is several reads
 * and some arithmetic, and the host who clicked "save" is not waiting for it.
 *
 * ## What it refuses to post
 *
 *  - **An event that counts towards nothing.** There is no table.
 *  - **A season that is not published.** A hidden season is an admin's draft
 *    (R-189), and announcing it to the channel is the loudest possible way to
 *    publish something nobody has published. A closed season cannot reach here:
 *    `setPlacements` refuses the write that triggers it.
 *  - **An event with no finishing order on it.** Clearing an order is an admin
 *    undoing a mistake, and `seasonPage` has already decided that such an
 *    event has not counted — so there is nothing to announce about it.
 *  - **A season nobody has scored in yet**, which cannot happen alongside the
 *    check above but is cheap to be sure of rather than post an embed with no
 *    names in it.
 *
 * The switch is `standings_changed` and it is off by default (`./announce`),
 * and a missing webhook stops this exactly where it stops every other
 * announcement — inside `deliver`, before anything is posted or logged.
 */
export function announceStandings(eventId: string, database: Database = defaultDb): void {
  announceGathered(
    ["standings_changed"],
    async () => {
      const season = await seasonOfEvent(eventId, database);
      if (!season || season.status !== "published") return null;

      const page = await seasonPage(season, database);
      const scored = page.counted.find((event) => event.eventId === eventId);
      if (!scored || page.standings.length === 0) return null;

      /*
       * Whether the movement figures say anything about *this* event. They are
       * measured at the last event played (`seasonPage`), which is the event
       * just scored on any ordinary night and is not it when a host records an
       * old result late. Deciding that here, where both ids are to hand, keeps
       * `topOfTheTable` a statement about a table rather than about a schedule.
       */
      const movement: Movement =
        page.movedAt === null
          ? "none"
          : page.movedAt.eventId === eventId
            ? "here"
            : "elsewhere";

      return {
        kind: "standings_changed",
        eventId,
        message: standingsMessage(
          {
            seasonName: season.name,
            slug: season.slug,
            eventTitle: scored.title,
            top: topOfTheTable(page.standings, { movement }),
            origin: await announceOrigin(),
          },
          await wordingFor("standings_changed", database)
        ),
      };
    },
    { subject: { eventId }, eventOf: async () => eventId }
  );
}

/* ------------------------------------------------------------------ */
/* The three the clock announces (R-205, R-206, R-207 / UC-38)        */
/* ------------------------------------------------------------------ */

/** One announcement that went out, named rather than counted. */
export type PostedAnnouncement = { kind: AnnouncementKind; eventId: string };

/**
 * Post whatever the clock says is due, once per event, ever.
 *
 * ## Why this one is `async` when the five above are `void`
 *
 * Every announcer above returns nothing synchronously and hands its work to
 * `after()`, because each is called from inside an action that must not wait on
 * Discord (see the module comment). This one is called from
 * `/api/cron/reminders`, where the opposite is true: there is no member waiting
 * for a response, and the response *is* the only report anybody gets of whether
 * the schedule is working. So it is awaited and it says what it posted —
 * `sendDueReminders` next door makes the same trade for the same reason.
 *
 * ## Claim, then post, and in that order
 *
 * {@link dueScheduledAnnouncements} decides dueness with a **window**, not an
 * instant, because a scheduler wakes when it wakes. A window a day wide is one
 * the quarter-hour schedule wakes inside ninety-odd times, so "due" is true
 * over and over, and the claim row is the whole of what makes the announcement
 * happen once (UC-38 5a). `announcement_claims` is keyed `(kind, event_id)`;
 * the insert is `onConflictDoNothing` and this run only posts for the rows it
 * actually wrote, so two overlapping runs cannot both win the insert and
 * therefore cannot both post.
 *
 * The price is the same bargain `claimForDiscord` in `./notifications` strikes
 * and states: **a post that fails after its claim is never retried.** It is
 * logged and audited as `announcement.failed` (R-208 / UC-38 5c) and the claim
 * stays taken. A missed announcement is the better failure than one the channel
 * gets twice, and the audit row is what stops it being a silent one.
 *
 * ## Nothing is claimed that could not have been posted
 *
 * The switch and the webhook are both read **before** any claim, and a kind
 * that is off or an install with no webhook claims nothing at all. That is
 * load-bearing rather than tidy: a claim taken while the feature was switched
 * off could never be released, so an admin who turned the switch on next week
 * would get silence for every event already in flight. Same reason
 * `claimForDiscord` claims nobody while there is no bot token.
 */
export async function postDueAnnouncements(
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<{ posted: PostedAnnouncement[] }> {
  const posted: PostedAnnouncement[] = [];

  /*
   * Read once for the whole run rather than per candidate. A settings object
   * that changed halfway through would be a run that posted about some of its
   * events and not others, for no reason a reader of the channel could see.
   */
  const enabled = await getAnnouncementSettings(database);
  /*
   * One read for the webhook *and* the origin, through the caller's database
   * rather than `announceOrigin`'s default handle. The five announcers above
   * call `announceOrigin()` per message because they run one at a time inside
   * `after()`; this runs three lists in a loop, and taking the pair together
   * also means the links in these messages come out of the same database the
   * events did (the gap `wordingFor`'s comment names).
   */
  const { webhook, origin } = await getIntegrationConfig(database);
  // Nowhere to post. Nothing is claimed, so nothing is burnt — see above.
  if (!webhook) return { posted };

  const kinds = ["signups_open", "signups_closing_soon", "event_starting_soon"] as const;
  /*
   * Not an optimisation: `dueScheduledAnnouncements` reads every event and then
   * their days, and that is not work to do every quarter hour on behalf of
   * three switches that are all off — which is the default for all three.
   */
  if (!kinds.some((kind) => enabled[kind])) return { posted };

  const due = await dueScheduledAnnouncements(now, database);

  /**
   * One candidate: switched on, not already claimed, then built and posted.
   *
   * `build` is a callback rather than a built message, so no payload is ever
   * assembled for an announcement that is not going out — and the wording is
   * read *inside* it, at post time, exactly as every other announcer reads it
   * (see {@link wordingFor}).
   */
  const post = async (
    kind: AnnouncementKind,
    eventId: string,
    build: (template: AnnouncementTemplate) => DiscordMessage
  ): Promise<void> => {
    if (!enabled[kind]) return;
    if (!(await claimAnnouncement(kind, eventId, database))) return;
    await deliver(kind, build(await wordingFor(kind, database)), { eventId });
    posted.push({ kind, eventId });
  };

  for (const event of due.signupsOpen) {
    await post("signups_open", event.eventId, (template) =>
      signupsOpenMessage(
        {
          title: event.title,
          slug: event.slug,
          capacity: event.capacity,
          startsAt: event.startsAt,
          signupClosesAt: event.signupClosesAt,
          origin,
        },
        template
      )
    );
  }

  for (const event of due.closingSoon) {
    await post("signups_closing_soon", event.eventId, (template) =>
      signupsClosingSoonMessage(
        {
          title: event.title,
          slug: event.slug,
          // Already `<t:unix:R>`: the scheduler rendered it, and nothing here
          // turns an instant into text (README, "Times").
          closes: event.stamp,
          capacity: event.capacity,
          full: event.full,
          origin,
        },
        template
      )
    );
  }

  for (const event of due.startingSoon) {
    await post("event_starting_soon", event.eventId, (template) =>
      eventStartingSoonMessage(
        { title: event.title, slug: event.slug, starts: event.stamp, origin },
        template
      )
    );
  }

  return { posted };
}

/* ------------------------------------------------------------------ */
/* The five, posted by hand (R-221 to R-223 / UC-43)                  */
/* ------------------------------------------------------------------ */

/**
 * One kind on one event, as the Publish tab shows it.
 *
 * `enabled` is the automatic switch and is shown rather than obeyed: the button
 * posts either way (R-223 / UC-43 2a), and saying it is off is what keeps that
 * from being a surprise. `postedAt` is the claim row's `claimed_at` — which
 * until now nothing read, and which is the only record of when an announcement
 * went out (see the column's comment in `src/db/schema.ts`).
 */
export type ManualAnnouncementRow = {
  kind: ManualAnnouncementKind;
  /** The button's word, and the footer the channel will show. */
  name: string;
  /** What that post would contain, from `ANNOUNCEMENTS`. */
  detail: string;
  enabled: boolean;
  postedAt: Date | null;
  /** Why it cannot be posted for this event, or null (UC-43 4a). */
  refusal: string | null;
};

/**
 * The whole panel: whether there is anywhere to post, and the kinds offered.
 *
 * `webhook` is a fact about the install rather than about the event, so it is
 * here rather than repeated as a refusal on all five rows — the screen says it
 * once (UC-43 3b).
 */
export type ManualAnnouncementPanel = {
  webhook: boolean;
  rows: ManualAnnouncementRow[];
};

/**
 * Read everything the Publish tab's announcement panel shows.
 *
 * One function rather than five reads in a page, because every row needs the
 * same four answers and `offeredManualKinds` needs the season before it knows
 * how many rows there are. It is read on the server and handed down as props:
 * everything in this module reaches Postgres, so a client component that called
 * into it would drag Drizzle and PGlite into the browser bundle — the pure half
 * the screen also needs is in `./announce-manual`.
 */
export async function manualAnnouncementPanel(
  eventId: string,
  database: Database = defaultDb
): Promise<ManualAnnouncementPanel> {
  const [[event], enabled, config, claims, dates, season] = await Promise.all([
    database
      .select({ signupClosesAt: events.signupClosesAt })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1),
    getAnnouncementSettings(database),
    getIntegrationConfig(database),
    database
      .select({ kind: announcementClaims.kind, claimedAt: announcementClaims.claimedAt })
      .from(announcementClaims)
      .where(eq(announcementClaims.eventId, eventId)),
    readDatesFor(database, [eventId]),
    seasonOfEvent(eventId, database),
  ]);

  const facts: ManualAnnouncementFacts = {
    // The derived start, not a column — see `ManualAnnouncementFacts`.
    startsAt: dates.get(eventId)?.startsAt ?? null,
    signupClosesAt: event?.signupClosesAt ?? null,
    inChampionship: season !== null,
  };

  const postedAt = new Map(claims.map((row) => [row.kind, row.claimedAt]));

  return {
    webhook: config.webhook !== null,
    rows: offeredManualKinds(facts).map((kind) => ({
      kind,
      name: MANUAL_ANNOUNCEMENT_NAMES[kind],
      detail: manualAnnouncementDetail(kind),
      enabled: enabled[kind],
      postedAt: postedAt.get(kind) ?? null,
      refusal: manualPostRefusal(kind, facts),
    })),
  };
}

/**
 * When this kind last went out for this event, or null (R-222 / UC-43 3a).
 *
 * The claim row's own timestamp. Its own reader rather than a second query in
 * the action, because the action layer owns no SQL — and because the panel's
 * `postedAt` and this are the same fact: a screen rendered before somebody else
 * posted is exactly the stale answer the confirm gate is a backstop for.
 */
export async function announcementPostedAt(
  kind: AnnouncementKind,
  eventId: string,
  database: Database = defaultDb
): Promise<Date | null> {
  const [row] = await database
    .select({ claimedAt: announcementClaims.claimedAt })
    .from(announcementClaims)
    .where(and(eq(announcementClaims.kind, kind), eq(announcementClaims.eventId, eventId)))
    .limit(1);
  return row?.claimedAt ?? null;
}

export type ManualPostResult =
  | {
      ok: true;
      /** Whether this post took the once-per-event claim (UC-43 4b, 4c). */
      claimed: boolean;
      name: string;
      title: string;
    }
  | { ok: false; error: string };

/** The event as the five messages are built from it, read once. */
type ManualEvent = {
  id: string;
  title: string;
  slug: string;
  type: string | null;
  description: string | null;
  capacity: number | null;
  signupOpensAt: Date | null;
  signupClosesAt: Date | null;
};

/**
 * Post one of the five now, for this event, and say what happened
 * (R-221 to R-223 / UC-43).
 *
 * ## Awaited, unlike every other announcer in this file
 *
 * The five above return `void` and hand their work to `after()`, because each is
 * called from inside an action a member is waiting on and a webhook that is
 * down must not fail the thing that triggered it. Here the announcement **is**
 * the thing that was asked for: an admin pressed a button to post it, and the
 * only report they will ever get is this return value. `postDueAnnouncements`
 * makes the same trade for the same reason.
 *
 * ## The switch is read nowhere in here
 *
 * Deliberately, and it is the one line somebody will add back. `deliver` checks
 * `enabled[kind]` and returns silently when a kind is off, which is correct for
 * everything that posts on its own — so this path does not go through it. The
 * switch governs what posts *automatically*; a button is an explicit decision
 * (R-223 / UC-43 2a), and the screen says the kind is off beside the button it
 * is offering.
 *
 * ## Post, then claim — in that order, unlike the scheduler
 *
 * `postDueAnnouncements` claims first, because a window a day wide is one the
 * scheduler wakes inside ninety times and the claim is the only thing stopping
 * ninety posts; it pays for that with a post that fails after its claim never
 * being retried. Here the opposite order is right, and for the reason this
 * feature exists at all: the case it was built for is Discord having eaten the
 * first post. A claim taken before a failed request would burn the scheduler's
 * remaining chance to post something that never reached the channel — so the
 * claim is taken only once Discord has accepted it (UC-43 4c), and a refusal
 * leaves the claim free. The race that order opens is two posts in the
 * milliseconds between the request and the insert, which needs a scheduler wake
 * inside that gap on the one event an admin is posting by hand; the race it
 * closes is the hour-later duplicate the use case actually names.
 *
 * An already-taken claim writes nothing (UC-43 4b): the insert does nothing on
 * conflict, so `claimed` comes back false and the post still went out.
 */
export async function postAnnouncementByHand(
  kind: ManualAnnouncementKind,
  eventId: string,
  database: Database = defaultDb
): Promise<ManualPostResult> {
  /*
   * Taken before the webhook is read and used as a failure's timestamp, for the
   * reason `deliver` takes one: the admin home stops listing failures older
   * than the latest webhook save.
   */
  const startedAt = new Date();

  const [event] = await database
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      type: events.type,
      description: events.description,
      capacity: events.capacity,
      signupOpensAt: events.signupOpensAt,
      signupClosesAt: events.signupClosesAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) return { ok: false, error: MANUAL_REFUSALS.noEvent };

  // The caller's database for both, not the default handle: the links in this
  // message must point at the same install the event came out of.
  const { webhook: url, origin } = await getIntegrationConfig(database);
  if (!url) return { ok: false, error: MANUAL_REFUSALS.noWebhook };

  const [dates, season] = await Promise.all([
    readDatesFor(database, [eventId]),
    seasonOfEvent(eventId, database),
  ]);
  const startsAt = dates.get(eventId)?.startsAt ?? null;

  const refusal = manualPostRefusal(kind, {
    startsAt,
    signupClosesAt: event.signupClosesAt,
    inChampionship: season !== null,
  });
  if (refusal) return { ok: false, error: refusal };

  const built = await buildByHand(kind, event, { startsAt, season, origin }, database);
  if (!built.ok) return built;

  const sent = await sendToDiscord(url, built.message);
  if (!sent.ok) {
    /*
     * Exactly as an automatic one is (UC-43 5a): the same action, the same
     * sentence, filed against the same event, so `/admin/audit` and the admin
     * home's failure list cannot tell a by-hand failure from a scheduled one —
     * which is the point, because what an operator needs to know is that the
     * webhook is broken.
     */
    await noteFailure(kind, { eventId }, sent.reason, sent.detail, startedAt);
    return { ok: false, error: failedNote(sent.reason) };
  }

  return {
    ok: true,
    claimed: await claimAnnouncement(kind, eventId, database),
    name: MANUAL_ANNOUNCEMENT_NAMES[kind],
    title: event.title,
  };
}

/**
 * Build one of the five from the event as it stands now, or refuse by name.
 *
 * The wording is read per kind at build time, exactly as every other announcer
 * reads it ({@link wordingFor}) — an admin who fixes a typo seconds before
 * pressing the button gets the fixed sentence.
 *
 * The three standings refusals are here rather than in `./announce-manual`
 * because they are only knowable once the season has been read, and reading it
 * is what the panel deliberately does not do for every event editor page load.
 * They are `announceStandings`' own three conditions, said out loud instead of
 * returning null: an automatic announcement that declines to post is right to do
 * so silently, and a button that did the same would be the button that silently
 * does nothing.
 *
 * ## Three of its guards repeat `manualPostRefusal`, on purpose
 *
 * `starts`, `closes` and the season are **non-nullable** on the builders that
 * take them, and the compiler cannot see that the caller's `manualPostRefusal`
 * has already refused a null one — so the narrowing has to happen here as well.
 * They answer with the same `MANUAL_REFUSALS` sentence rather than a second
 * wording, which is what keeps the duplication harmless: whichever of the two
 * refuses, the admin reads the same thing.
 *
 * It is also a duplication with a known cost, recorded rather than hidden:
 * deleting the caller's `if (refusal)` line is a mutation this suite cannot
 * kill, because these three say the same thing one read later. Neither copy is
 * dead code — delete *these* and the two builders stop compiling; delete that
 * one and the panel and the post path stop sharing a decision.
 */
async function buildByHand(
  kind: ManualAnnouncementKind,
  event: ManualEvent,
  context: { startsAt: Date | null; season: Awaited<ReturnType<typeof seasonOfEvent>>; origin: string | null },
  database: Database
): Promise<{ ok: true; message: DiscordMessage } | { ok: false; error: string }> {
  const { startsAt, season, origin } = context;
  const wording = await wordingFor(kind, database);

  if (kind === "event_published") {
    return {
      ok: true,
      message: eventPublishedMessage(
        {
          title: event.title,
          slug: event.slug,
          type: event.type,
          description: event.description,
          capacity: event.capacity,
          startsAt,
          signupOpensAt: event.signupOpensAt,
          /*
           * Now, which is what this publication *is* from the reader's point of
           * view: a post going out at this instant. It decides which of the two
           * sentences `eventPublishedMessage` has — "applications are open" or
           * "applications open <when>" — and judging that against now is the
           * only honest answer for a post being made now.
           */
          publishedAt: new Date(),
          signupClosesAt: event.signupClosesAt,
          origin,
        },
        wording
      ),
    };
  }

  if (kind === "signups_open") {
    return {
      ok: true,
      message: signupsOpenMessage(
        {
          title: event.title,
          slug: event.slug,
          capacity: event.capacity,
          startsAt,
          signupClosesAt: event.signupClosesAt,
          origin,
        },
        wording
      ),
    };
  }

  if (kind === "signups_closing_soon") {
    // `manualPostRefusal` has already refused an event with no closing time,
    // which is what makes this non-null — `closes` is a required string on the
    // builder, so the compiler holds the claim rather than a fallback.
    const closesAt = event.signupClosesAt;
    if (!closesAt) return { ok: false, error: MANUAL_REFUSALS.noClosingTime };

    const seats = await database
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.eventId, event.id));

    return {
      ok: true,
      message: signupsClosingSoonMessage(
        {
          title: event.title,
          slug: event.slug,
          // A countdown, as markup — no instant is formatted on the server.
          closes: stamp(closesAt, "R"),
          capacity: event.capacity,
          // UC-38 4c's sentence: a full event still gets this, and says so.
          full: capacityState({ capacity: event.capacity }, seats).full,
          origin,
        },
        wording
      ),
    };
  }

  if (kind === "event_starting_soon") {
    if (!startsAt) return { ok: false, error: MANUAL_REFUSALS.noDatedDay };
    return {
      ok: true,
      message: eventStartingSoonMessage(
        { title: event.title, slug: event.slug, starts: stamp(startsAt, "F"), origin },
        wording
      ),
    };
  }

  // `standings_changed`, the only one left and the only one with reads of its
  // own. An event in no championship was refused before this was called.
  if (!season) return { ok: false, error: MANUAL_REFUSALS.noChampionship };
  if (season.status !== "published") {
    return { ok: false, error: MANUAL_REFUSALS.seasonNotPublished };
  }

  const page = await seasonPage(season, database);
  const scored = page.counted.find((counted) => counted.eventId === event.id);
  if (!scored) return { ok: false, error: MANUAL_REFUSALS.noFinishingOrder };
  if (page.standings.length === 0) return { ok: false, error: MANUAL_REFUSALS.noStandings };

  // `announceStandings`' rule, unchanged: the movement figures are measured at
  // the last event played, so they say something about *this* event only when
  // this is it.
  const movement: Movement =
    page.movedAt === null ? "none" : page.movedAt.eventId === event.id ? "here" : "elsewhere";

  return {
    ok: true,
    message: standingsMessage(
      {
        seasonName: season.name,
        slug: season.slug,
        eventTitle: scored.title,
        top: topOfTheTable(page.standings, { movement }),
        origin,
      },
      wording
    ),
  };
}
