/**
 * The session-aware half of the top bar (docs/platform-plan.md §4).
 *
 * "Signed-in members get **Profile**, admins get an extra **Admin** link."
 * That is the whole remit, and this stays that small on purpose — the boards
 * each have their own header full of board-specific controls, and the point of
 * §4 is that the *identity* links look the same wherever they appear rather
 * than that every header gets rebuilt.
 *
 * A server component, because it reads the session. Client headers take it as a
 * prop (`<TournamentBoard nav={<SessionNav />} />`), which works because a
 * server component passed through a client boundary is rendered before it gets
 * there.
 */

import { Button } from "@/components/ui";
import { getCurrentUser } from "@/lib/session-guards";

export default async function SessionNav() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Button href="/signin" size="sm">
        Sign in
      </Button>
    );
  }

  return (
    <>
      <Button href="/me/profile" size="sm">
        Profile
      </Button>
      {user.isAdmin && (
        <Button href="/admin/games" size="sm">
          Admin
        </Button>
      )}
    </>
  );
}
