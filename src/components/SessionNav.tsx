/**
 * The session-aware half of the top bar (docs/platform-plan.md §4).
 *
 * Signed out, this is a single quiet link. Signed in, it is the account menu —
 * one control that opens everything §4 lists, rather than a row of buttons per
 * destination. The links themselves moved into `NavMenu`, which needs to be a
 * client component to open and close; this stays a server component because it
 * reads the session, and hands the menu a sign-out action to submit.
 *
 * Client headers take it as a prop (`<TournamentBoard nav={<SessionNav />} />`),
 * which works because a server component passed through a client boundary is
 * rendered before it gets there.
 */

import Link from "next/link";
import NavMenu from "./NavMenu";
import { signOut } from "@/lib/auth";
import { unreadCount } from "@/lib/notifications";
import { getCurrentUser, returnPathFromRequest } from "@/lib/session-guards";

export default async function SessionNav() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Link
        href="/signin"
        className="text-14 text-chalk/80 transition-colors hover:text-hot"
      >
        Sign in
      </Link>
    );
  }

  /*
   * UC-01 8: sign out and see the page you were on, as a visitor.
   *
   * The path is read inside the action rather than captured when the header
   * rendered, because this header is on every page and the action is what
   * knows which one it was submitted from — a server action arrives as a POST
   * to the current page, so its `Referer` is that page and nothing else.
   *
   * `?? "/"` is only for when there is nothing to read at all: a POST with no
   * `Referer` and no `next-url`, which is a client that strips the header, a
   * curl, or a test. It is not a check on whether the page is behind a guard.
   * Signing out of `/me` does return to `/me`, and that page's own
   * `requireUser` then sends them to `/signin?from=/me` — the sign-in page,
   * which is not the page they were on. That is deliberate rather than missed:
   * the alternative is a list of guarded prefixes maintained in the header,
   * duplicating every page's own guard and drifting silently the first time
   * somebody adds a guarded route without thinking of this file. The cost of
   * the current behaviour is one extra screen on the way out of a page they
   * could not have seen as a visitor anyway.
   */
  async function endSession() {
    "use server";
    await signOut({ redirectTo: (await returnPathFromRequest()) ?? "/" });
  }

  /*
   * Read here rather than inside `NavMenu`: the menu is a client component and
   * the count is a query. One read per header render on a site that is already
   * `force-dynamic` throughout.
   */
  const unread = await unreadCount(user.id);

  return (
    <NavMenu
      unread={unread}
      user={{
        displayName: user.displayName,
        name: user.name,
        handle: user.handle,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
      }}
      signOut={endSession}
    />
  );
}
