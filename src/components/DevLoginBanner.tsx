/**
 * The "this is not a real session" bar.
 *
 * Rendered from the root layout, so it appears on **every page the development
 * sign-in can affect** — the boards included, since the session it mints is a
 * real one that every guard on the site will honour. Anything that convincing
 * has to announce itself.
 *
 * When the escape hatch is off — which is always, outside a developer's own
 * machine — this returns `null` before touching cookies or the database, so it
 * costs a deployment nothing and never forces a page to render dynamically.
 */

import { DEV_LOGIN_PATH, devLoginConfig, devLoginEnabled } from "@/lib/dev-login";
import { getCurrentUser } from "@/lib/session-guards";

export default async function DevLoginBanner() {
  // First and cheapest: two environment reads, no I/O.
  if (!devLoginEnabled()) return null;

  const config = devLoginConfig();
  const user = await getCurrentUser();
  const signedIn = Boolean(user);

  return (
    <>
      {/* Keeps the last line of any page clear of the fixed bar below. */}
      <div aria-hidden className="h-11" />

      <div
        role="status"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-ember/60 bg-ember/15 backdrop-blur"
      >
        <div className="mx-auto flex h-11 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-ember live-dot" />

          <span className="eyebrow truncate text-ember">
            Development sign-in active — not a real session
          </span>

          <span className="hidden truncate text-xs text-chalk/70 sm:inline">
            {signedIn
              ? `Signed in as ${user?.displayName ?? "the dev user"}${user?.isAdmin ? " · admin" : " · not an admin"}`
              : "No session yet"}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2">
            {/* A link to the page, never an action: signing in and out are
                state changes and belong behind the buttons there. */}
            <a href={DEV_LOGIN_PATH} className="btn border-ember/50 px-3 py-1.5 text-ember">
              {signedIn
                ? "End dev session"
                : config.isAdmin
                  ? "Dev sign in (admin)"
                  : "Dev sign in"}
            </a>
          </span>
        </div>
      </div>
    </>
  );
}
