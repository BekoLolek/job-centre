import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "@/lib/notifications";
import { allChannels } from "@/lib/notify-policy";

/*
 * The notifications list as a member reads it (UC-25 4-5).
 *
 * Three things the library tests cannot see, because they are about what is on
 * the screen rather than what the query returned:
 *
 *  - **A notification with nowhere to go is still a notification.** The link is
 *    optional — a poll that has since closed, an event a member may no longer
 *    see — and a list that quietly dropped those rows would lose news nobody
 *    can get back. The row must render; only the anchor goes.
 *  - **The way to the rest of the list.** Paging is `?before=` in the address,
 *    so the only thing the component owes it is the link, and a page that
 *    stops at thirty with no way onwards is the bug this task was written for.
 *  - **The unread count is the server's, across every page (R-103).** Worked
 *    out from the rows on screen it reads "All caught up" on page two while
 *    page one is full of unread ones.
 *
 * `useRouter` and the action module are mocked for the reason
 * `attendance-lock.test.ts` mocks them: importing the actions would drag the
 * database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

vi.mock("@/app/me/notification-actions", () => ({
  markAllReadAction: vi.fn(),
  markReadAction: vi.fn(),
  setNotificationPrefAction: vi.fn(),
}));

const { default: NotificationList } = await import("../NotificationList");

type Props = {
  initial: Notification[];
  unread: number;
  olderHref?: string | null;
  newestHref?: string | null;
};

function markup(over: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(NotificationList, {
      initial: [],
      unread: 0,
      prefs: allChannels(null),
      discordAvailable: false,
      hasDiscordAccount: false,
      ...over,
    })
  );
}

function row(over: Partial<Notification> = {}): Notification {
  return {
    id: "notification-1",
    kind: "event_published",
    title: "Spring LAN",
    body: "A new event is up.",
    href: "/events/spring-lan",
    eventId: "event-1",
    readAt: null,
    createdAt: new Date("2026-05-01T17:00:00.000Z"),
    ...over,
  };
}

describe("following a notification", () => {
  it("links the one about an event to the event", () => {
    expect(markup({ initial: [row()], unread: 1 })).toContain('href="/events/spring-lan"');
  });

  it("renders one with nowhere to go, without a link", () => {
    const rendered = markup({
      initial: [row({ href: null, eventId: null, title: "There's a new poll" })],
      unread: 1,
    });

    expect(rendered).toContain("There&#x27;s a new poll");
    expect(rendered).not.toContain("<a ");
  });

  it("drops only the link, keeping the row, for an event the reader may not see", () => {
    // What `destinationFor` hands over for a draft event (R-32): the sentence
    // is still news, and it is the only copy of it the member gets.
    const rendered = markup({
      initial: [row({ href: null, title: "Pulled back to a draft" })],
      unread: 1,
    });

    expect(rendered).toContain("Pulled back to a draft");
    expect(rendered).not.toContain("<a ");
  });
});

describe("the way to the rest of the list", () => {
  it("offers the page after this one", () => {
    const rendered = markup({
      initial: [row()],
      unread: 1,
      olderHref: "/me/notifications?before=cursor",
    });

    expect(rendered).toContain("Older");
    expect(rendered).toContain("before=cursor");
  });

  it("offers nothing onwards when this is the whole list", () => {
    const rendered = markup({ initial: [row()], unread: 1 });

    expect(rendered).not.toContain("Older");
    expect(rendered).not.toContain("Back to the newest");
  });

  it("offers the way back from a later page", () => {
    const rendered = markup({
      initial: [row()],
      unread: 1,
      newestHref: "/me/notifications",
    });

    expect(rendered).toContain("Back to the newest");
  });
});

describe("the unread count", () => {
  it("is the server's count, not the rows on screen (R-103)", () => {
    // Page two: every row here has been read, and seven elsewhere have not.
    const rendered = markup({
      initial: [row({ readAt: new Date("2026-05-02T09:00:00.000Z") })],
      unread: 7,
    });

    expect(rendered).toContain("7 unread");
    expect(rendered).not.toContain("All caught up");
  });

  it("says so when there is genuinely nothing unread anywhere", () => {
    const rendered = markup({
      initial: [row({ readAt: new Date("2026-05-02T09:00:00.000Z") })],
      unread: 0,
    });

    expect(rendered).toContain("All caught up");
    expect(rendered).not.toContain("Mark all read");
  });
});
