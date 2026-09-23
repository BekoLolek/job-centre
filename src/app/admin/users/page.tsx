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
 * Revoking here is permanent, and the screen says so rather than leaving it to
 * be discovered. It used to be the other way round: `shouldBeAdmin` granted the
 * flag on every sign-in by anybody named in `ADMIN_DISCORD_IDS`, so revoking
 * one of those came straight back the next morning. `revokeAdmin` now bars the
 * id in the same transaction as the demotion, and `resolveAdminFlag` reads that
 * row and answers `false` whatever the variable says (R-05, R-141 / UC-29 2a).
 * The variable is the bootstrap only — it decides for an id the allowlist has
 * no row for, which is how the first admin gets in — and a deployment that has
 * locked itself out is rescued by `forgetAdmin` dropping the row, not by the
 * variable overriding it. That is why the allowlist is on this screen above the
 * members list: the undo has to be somewhere an admin can find it.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import AdminAllowlist from "@/components/admin/AdminAllowlist";
import UsersManager from "@/components/admin/UsersManager";
import { Eyebrow, Page, Section, StatTile } from "@/components/ui";
import { getAllowlist } from "@/lib/admin-allowlist";
import { loadAdminUsers } from "@/lib/admin-users";
import { parseAdminIds } from "@/lib/auth-policy";
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
  const allowlist = await getAllowlist();
  // Shown so the screen can point at ids that still work but are managed
  // nowhere visible — the state this list exists to end.
  const envAdminIds = parseAdminIds(process.env.ADMIN_DISCORD_IDS);

  const seen = view.users.filter((row) => row.lastSeenAt !== null).length;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      <Page className="space-y-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Members</Eyebrow>
            <h1 className="font-display text-36 leading-none">Members</h1>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
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
              valueClassName={view.admins > 1 ? "text-union" : "text-flare"}
            />
            <StatTile label="Signed in" value={`${seen}/${view.total}`} />
          </div>
        </header>

        <Section
          first
          icon="shield"
          title="Who gets to be an admin"
          description="Named by Discord id, so somebody can be an admin before they have ever signed in — and stay removed after they have."
        >
          <AdminAllowlist rows={allowlist} envIds={envAdminIds} />
        </Section>

        <Section icon="people" title="Members" description="Everyone who has ever signed in.">
          <UsersManager view={view} currentUserId={admin.id} />
        </Section>

        <p className="pb-4 text-center text-12 text-muted">
          Nothing on this page deletes a member. Notes are append-only, like the audit log —
          a note is a record of what somebody thought at the time.
        </p>
      </Page>
    </div>
  );
}
