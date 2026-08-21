/**
 * `/admin/settings` — the switches that are not about one event.
 *
 * Today that is the Discord announcements and nothing else, which is exactly
 * why they are here rather than on the event editor: which kinds fire is a
 * decision about the whole server, and putting a server-wide switch inside one
 * event's tab strip is how somebody ends up believing they turned it off for
 * everything.
 *
 * `webhookUrl()` is called on the server and only its *presence* crosses to the
 * client. A webhook URL is a credential — anybody holding it can post into the
 * channel as the site — so the page says whether one is configured and never
 * what it is.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import AnnouncementSettings from "@/components/admin/AnnouncementSettings";
import { Eyebrow, Section, StatTile } from "@/components/ui";
import { ANNOUNCEMENTS, webhookUrl } from "@/lib/announce";
import { getAnnouncementSettings } from "@/lib/discord";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings · Job Centre Events",
};

export default async function AdminSettingsPage() {
  await requireAdmin();

  const saved = await getAnnouncementSettings();
  const configured = Boolean(webhookUrl());
  const on = ANNOUNCEMENTS.filter((spec) => saved[spec.kind]).length;

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[900px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Settings</Eyebrow>
            <h1 className="font-display text-4xl leading-none tracking-wide">SETTINGS</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Switches that apply to the whole server rather than to one event. Every
              change is written to the audit log.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile
              label="Announcing"
              value={`${on}/${ANNOUNCEMENTS.length}`}
              valueClassName={configured && on > 0 ? "text-signal" : "text-muted"}
            />
            <StatTile
              label="Webhook"
              value={configured ? "Set" : "None"}
              valueClassName={configured ? "text-signal" : "text-muted"}
            />
          </div>
        </header>

        <div>
          <AnnouncementSettings
            specs={ANNOUNCEMENTS}
            saved={saved}
            configured={configured}
          />

          <Section
            icon="shield"
            title="What an announcement cannot do"
            description="Why a webhook that is slow, deleted or rate-limited can never break the thing that triggered it."
          >
            <p className="text-sm leading-relaxed text-muted">
              It cannot fail anything. A message is built and posted <em>after</em> the
              response has gone out, so a webhook that is slow, deleted or rate-limited
              never delays or reverses the thing that triggered it — the member&rsquo;s
              application succeeded whether or not Discord heard about it. When a post
              does fail it is written to the audit log as{" "}
              <span className="text-chalk">Announcement failed</span>, with the reason,
              rather than disappearing.
            </p>
          </Section>
        </div>

        <p className="pb-4 text-center text-xs text-muted">
          The guild gate&rsquo;s own settings live in the database too, but have no screen
          yet — they are read from <code>DISCORD_GUILD_ID</code> until one exists.
        </p>
      </main>
    </div>
  );
}
