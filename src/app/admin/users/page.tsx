/**
 * `/admin/users` — members, admin flags, notes (docs/platform-plan.md §4, §7).
 *
 * The screen §4 promised and nothing built. Until it existed the only way to
 * make somebody an admin was to edit `ADMIN_DISCORD_IDS` and redeploy, which
 * meant the site's permission model lived in an environment variable that
 * nobody could read from inside the site.
 *
 * Two rules hold, both in `src/lib/admin-users.ts` as pure functions so the
 * button and the server refuse for the same reason: an admin cannot revoke
 * their own flag, and the site can never reach zero admins.
 *
 * The allowlist still wins on sign-in — `shouldBeAdmin` grants the flag every
 * time somebody named in `ADMIN_DISCORD_IDS` signs in — so revoking one of
 * those comes straight back. That is said on the screen rather than left to be
 * discovered, because a silent regrant reads as a bug.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import UsersManager from "@/components/admin/UsersManager";
import { Eyebrow, StatTile } from "@/components/ui";
import { loadAdminUsers } from "@/lib/admin-users";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Members · Job Centre Events",
};

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  // Unfiltered: the search and the admins filter are client-side, because the
  // whole list is already here and an admin flipping a filter should not wait
  // for a round trip to hide four rows.
  const view = await loadAdminUsers();

  const seen = view.users.filter((row) => row.lastSeenAt !== null).length;

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Members</Eyebrow>
            <h1 className="font-display text-4xl leading-none">Members</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Everyone who has ever signed in. Grant and revoke the admin flag here rather
              than by editing an environment variable and redeploying, and keep private
              notes about a member that nothing public ever shows.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Members" value={view.total} />
            <StatTile
              label="Admins"
              value={view.admins}
              valueClassName={view.admins > 1 ? "text-gold" : "text-ember"}
            />
            <StatTile label="Signed in" value={`${seen}/${view.total}`} />
          </div>
        </header>

        <UsersManager view={view} currentUserId={admin.id} />

        <p className="pb-4 text-center text-xs text-muted">
          Nothing on this page deletes a member. Notes are append-only, like the audit log —
          a note is a record of what somebody thought at the time.
        </p>
      </main>
    </div>
  );
}
