/**
 * The two rules the admin flag obeys, with no database (§4, §11).
 *
 * Split out of `src/lib/admin-users.ts` for the same reason `events-policy.ts`
 * is split out of `events.ts`: this half is a pure function over plain data, so
 * the screen can import it into the browser and disable a button *with the
 * reason next to it*, while the module that talks to Postgres stays on the
 * server. Importing `admin-users.ts` from a client component would drag every
 * Drizzle table — and PGlite behind them — into the browser bundle.
 *
 * It is one rule in two places, not two copies of one rule. The server still
 * decides: a browser's idea of how many admins there are is as old as its last
 * page load, and `revokeAdmin` re-reads the count before it acts.
 */

/** What a revoke needs to know about the world. */
export type RevokeContext = {
  /** The `users.id` of whoever is clicking. */
  actorId: string;
  /** The `users.id` of the member being demoted. */
  targetId: string;
  /** How many admins there are right now, the target included. */
  adminCount: number;
};

/**
 * Why this revoke must be refused, or `null` when it may proceed.
 *
 * The order matters. Somebody who is both the actor *and* the last admin is
 * told about the self-demotion first, because that is the one they can do
 * something about — ask another admin — whereas being told "you are the last
 * admin" would suggest promoting somebody else first, which does not actually
 * unlock the button for them.
 *
 * Granting has no counterpart here on purpose: going from one admin to two
 * takes nothing away from anybody, so there is nothing to refuse.
 */
export function revokeRefusal(context: RevokeContext): string | null {
  if (context.actorId === context.targetId) {
    return (
      "You cannot remove your own admin flag. Ask another admin to do it — " +
      "locking yourself out of the site takes a redeploy to undo."
    );
  }
  if (context.adminCount <= 1) {
    return (
      "This is the last admin. Removing the flag would leave the site with " +
      "nobody who can reach /admin, and the only way back would be editing " +
      "ADMIN_DISCORD_IDS and redeploying. Promote somebody else first."
    );
  }
  return null;
}

/** A note is a remark, not an essay. Enforced server-side, shown in the hint. */
export const NOTE_MAX = 2000;
