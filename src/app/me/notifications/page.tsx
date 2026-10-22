/**
 * `/me/notifications` — what the site has told you, and what you would rather
 * it did not.
 *
 * The list and the switches share a screen deliberately. The moment somebody
 * wants to mute something is the moment they are reading one they did not
 * want; making them hunt for a settings page is how the mute button goes
 * unused and the whole integration gets muted at the Discord end instead.
 *
 * **Paging is in the address, not in the component** (UC-25 4). `?before=` is
 * one row's keyset cursor, which makes every page a plain server render with a
 * link to the next: shareable, reloadable, in the back button, and — the part
 * that matters — not a window into a list that shifts under it. See
 * `NotificationCursor`. An `?before=` that does not parse is not an error
 * page; it is the newest page, which is what somebody who mangled the address
 * was looking at anyway.
 */

import AppHeader from "@/components/AppHeader";
import NotificationList from "@/components/me/NotificationList";
import { Page, PageHeader, Section } from "@/components/ui";
import { directMessagesConfigured } from "@/lib/discord-dm";
import {
  encodeNotificationCursor,
  getPrefs,
  notificationPage,
  parseNotificationCursor,
  unreadCount,
} from "@/lib/notifications";
import { allChannels } from "@/lib/notify-policy";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Notifications · Job Centre Events",
};

/** `/me/notifications?before=<cursor>`, for the link to the page after this one. */
function pageHref(cursor: string | null): string {
  return cursor
    ? `/me/notifications?before=${encodeURIComponent(cursor)}`
    : "/me/notifications";
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const after = parseNotificationCursor((await searchParams).before);

  const [page, overrides, unread] = await Promise.all([
    notificationPage(user.id, { after, isAdmin: user.isAdmin }),
    getPrefs(user.id),
    unreadCount(user.id),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader />

      {/*
        `reading`: one column of notifications, and a switch table whose two
        4.5rem columns beside a label need nothing like a page to sit in.
      */}
      <Page width="reading" className="space-y-6">
        <PageHeader
          eyebrow="Job Centre · You"
          title="Notifications"
          intro="New events, changes to things you applied to, and the day before something you have a seat at. Every one of them can be switched off below — except the answer to your own application, which is the reply rather than the news."
        />

        <Section
          first
          icon="clock"
          title={unread > 0 ? `${unread} unread` : "Everything"}
          description="Newest first. Following one marks it read."
        >
          <NotificationList
            initial={page.rows}
            unread={unread}
            olderHref={page.next ? pageHref(encodeNotificationCursor(page.next)) : null}
            newestHref={after ? pageHref(null) : null}
            prefs={allChannels(overrides)}
            discordAvailable={directMessagesConfigured()}
            hasDiscordAccount={Boolean(user.discordId)}
          />
        </Section>
      </Page>
    </div>
  );
}
