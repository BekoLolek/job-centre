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
import { getCurrentUser } from "@/lib/session-guards";

export default async function SessionNav() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Link
        href="/signin"
        className="text-sm text-chalk/80 transition-colors hover:text-hot"
      >
        Sign in
      </Link>
    );
  }

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/" });
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
