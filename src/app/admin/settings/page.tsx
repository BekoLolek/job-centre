/**
 * `/admin/settings` — the switches that are not about one event.
 *
 * Today that is the Discord announcements and nothing else, which is exactly
 * why they are here rather than on the event editor: which kinds fire is a
 * decision about the whole server, and putting a server-wide switch inside one
 * event's tab strip is how somebody ends up believing they turned it off for
 * everything.
 *
 * The webhook is resolved on the server — this screen's setting first, the
 * deployment second, exactly as `deliver` resolves it — and only its presence
 * and a masked copy cross to the client. A webhook URL is a credential: anybody
 * holding it can post into the channel as the site. Reading the environment
 * alone here once told an admin "No webhook" about the one they had just saved.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import AnnouncementSettings, { NOT_POSTED_YET, posted } from "@/components/admin/AnnouncementSettings";
import ServerSettings from "@/components/admin/ServerSettings";
import { Page, PageHeader, Section, StatTile } from "@/components/ui";
import { ANNOUNCEMENTS, type AnnouncementKind } from "@/lib/announce";
import { maskWebhook } from "@/lib/announce";
import { getGateConfig } from "@/lib/auth";
import {
  getAnnouncementSettings,
  getAnnouncementTemplates,
  getIntegrationConfig,
} from "@/lib/discord";
import { getGuildRoles } from "@/lib/discord-roles";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings · Job Centre Events",
};

export default async function AdminSettingsPage({
  searchParams,
}: {
  /*
   * Optional, and defaulted below. `?kind=` is a convenience — a link straight
   * to one announcement's editor — and a page whose only job is to render eight
   * switches must not refuse to render because nobody passed it a query.
   */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  await requireAdmin();

  const params = (await searchParams) ?? {};
  const asked = Array.isArray(params.kind) ? params.kind[0] : params.kind;
  // Through `ANNOUNCEMENTS` rather than cast: a query string is anybody's, and
  // the prop is a `AnnouncementKind`.
  const openKind: AnnouncementKind | null =
    ANNOUNCEMENTS.find((spec) => spec.kind === asked)?.kind ?? null;

  const saved = await getAnnouncementSettings();
  const templates = await getAnnouncementTemplates();
  const gate = await getGateConfig();
  const integrations = await getIntegrationConfig();
  const configured = Boolean(integrations.webhook);
  /*
   * The server's roles for the mention picker (R-203 / UC-37 4a, 4b).
   *
   * **`gate.guildId`, not `DISCORD_GUILD_ID` and not the settings row.**
   * `getGateConfig` has already resolved the two in the right order — the stored
   * setting first, the environment variable second — so this is the one value
   * that is right for both kinds of deployment. Reading the row directly would
   * make an install configured purely by `DISCORD_GUILD_ID` look to this feature
   * like no server had been set at all, and a new variable would be a third
   * place to keep in step with the sign-in gate.
   *
   * Cached in `@/lib/discord-roles` for a few minutes, so this is not a request
   * to Discord per page view, and it answers `{ roles: null, problem }` rather
   * than throwing on an install with no bot token — which is most of them. The
   * token itself stays in that module: what crosses to the browser below is an
   * id, a name and a position per role.
   */
  const roles = await getGuildRoles(gate.guildId);
  /*
   * Counted over the kinds something actually posts. A tile reading
   * "Announcing 5/8" that includes a kind with no trigger is the page telling
   * an admin a message is going out when none is; the eighth is accounted for
   * on its own row, which says so in as many words (R-205, Task 68).
   */
  const live = ANNOUNCEMENTS.filter((spec) => posted(spec.kind, NOT_POSTED_YET));
  const on = live.filter((spec) => saved[spec.kind]).length;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/*
        `standard`: switches and prose, but the integration fields below run two
        `min-w-[18rem]` columns wide and the announcement list is a table of
        channels, so a reading column would put both into a scroller.
      */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Settings"
          title="Settings"
          intro="Switches that apply to the whole server rather than to one event. Every change is written to the audit log."
          aside={
            <>
              <StatTile
                label="Announcing"
                value={`${on}/${live.length}`}
                valueClassName={configured && on > 0 ? "text-success" : "text-muted"}
              />
              <StatTile
                label="Webhook"
                value={configured ? "Set" : "None"}
                valueClassName={configured ? "text-success" : "text-muted"}
              />
            </>
          }
        />

        <div>
          <AnnouncementSettings
            specs={ANNOUNCEMENTS}
            saved={saved}
            configured={configured}
            templates={templates}
            /*
             * The site address, so a preview carries the link the post will.
             * The webhook is a credential and stays on the server (see above);
             * the address is on every page of the site already.
             */
            origin={integrations.origin}
            openKind={openKind}
            /*
             * Named at the call site rather than left to the component's
             * default, so the one place that decides which kinds have a
             * trigger is the one place that reads it for the tile above.
             */
            notPosted={NOT_POSTED_YET}
            /*
             * The role list, or why there is none. Not the bot token, which
             * never leaves `@/lib/discord-roles` — the same rule the webhook
             * above follows, and the Constraint both answer to.
             */
            roles={roles}
          />

          <Section
            icon="shield"
            title="What an announcement cannot do"
            description="Why a webhook that is slow, deleted or rate-limited can never break the thing that triggered it."
          >
            <p className="text-14 leading-relaxed text-muted">
              It cannot fail anything. A message is built and posted <em>after</em> the
              response has gone out, so a webhook that is slow, deleted or rate-limited
              never delays or reverses the thing that triggered it — the member&rsquo;s
              application succeeded whether or not Discord heard about it. When a post
              does fail it is written to the audit log as{" "}
              <span className="text-chalk">Announcement failed</span>, with the reason,
              rather than disappearing.
            </p>
          </Section>

          <ServerSettings
            gate={{ enabled: gate.enabled, guildId: gate.guildId, source: gate.source.guildId }}
            integrations={{
              /*
               * Masked on the server. The real webhook never reaches the
               * browser — not as a prop, not in the RSC payload, nowhere. A
               * screen that showed it would be a screen that hands out a
               * credential to anybody who can open dev tools on an admin's
               * machine.
               */
              webhook: maskWebhook(integrations.webhook),
              origin: integrations.origin,
              source: integrations.source,
            }}
            deployTime={{
              clientId: Boolean(process.env.DISCORD_CLIENT_ID),
              clientSecret: Boolean(process.env.DISCORD_CLIENT_SECRET),
              authSecret: Boolean(process.env.AUTH_SECRET),
              database: Boolean(process.env.DATABASE_URL),
            }}
          />
        </div>

      </Page>
    </div>
  );
}
