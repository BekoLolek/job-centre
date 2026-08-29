/**
 * `/me/notifications` — what the site has told you, and what you would rather
 * it did not.
 *
 * The list and the switches share a screen deliberately. The moment somebody
 * wants to mute something is the moment they are reading one they did not
 * want; making them hunt for a settings page is how the mute button goes
 * unused and the whole integration gets muted at the Discord end instead.
 */

import AppHeader from "@/components/AppHeader";
import NotificationList from "@/components/me/NotificationList";
import { Eyebrow, Section } from "@/components/ui";
import { directMessagesConfigured } from "@/lib/discord-dm";
import { getPrefs, listNotifications, unreadCount } from "@/lib/notifications";
import { allChannels } from "@/lib/notify-policy";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Notifications · Job Centre Events",
};

export default async function NotificationsPage() {
  const user = await requireUser();
  const [rows, overrides, unread] = await Promise.all([
    listNotifications(user.id),
    getPrefs(user.id),
    unreadCount(user.id),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader section="Notifications" />

      <main className="mx-auto max-w-[880px] px-4 py-8 sm:px-6">
        <header className="mb-2">
          <Eyebrow className="mb-2">Job Centre · You</Eyebrow>
          <h1 className="text-4xl">Notifications</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            New events, changes to things you applied to, and the day before something you
            have a seat at. Every one of them can be switched off below — except the answer
            to your own application, which is the reply rather than the news.
          </p>
        </header>

        <Section
          first
          icon="clock"
          title={unread > 0 ? `${unread} unread` : "Everything"}
          description="Newest first. Following one marks it read."
        >
          <NotificationList
            initial={rows}
            prefs={allChannels(overrides)}
            discordAvailable={directMessagesConfigured()}
            hasDiscordAccount={Boolean(user.discordId)}
          />
        </Section>
      </main>
    </div>
  );
}
