/**
 * Which announcement kinds the site actually posts — a fact both sides need.
 *
 * ## Why this is its own module
 *
 * `AnnouncementSettings.tsx` is a `"use client"` module, and **everything it
 * exports is a client reference**. A server component that imports a function
 * from it does not get the function: it gets a marker that React can render as
 * a component or pass as a prop, and calling it throws
 *
 *     Error: Attempted to call posted() from the server but posted is on the
 *     client. It's not possible to invoke a client function from the server…
 *
 * which is a *runtime* failure on the deployed page. It is invisible to
 * everything that guards this repo: `tsc` sees two ordinary exports, `next
 * build` compiles both sides happily, and the suite renders components directly
 * in a node environment where no server/client boundary exists at all. The
 * first thing that knew was production.
 *
 * So the rule this file exists to keep: **a value a server component calls must
 * not live in a `"use client"` module**, however pure it is. `posted` is one
 * line and has no state, which is exactly what makes the mistake easy — purity
 * is not the test, the directive at the top of the file is.
 *
 * This is the second time the boundary has bitten in this repo. The first was a
 * constant imported from `@/lib/profile` that dragged `node:fs` into a client
 * chunk; the answer then was the same one as here — move the shared value into a
 * module with no directive, so both sides may import it.
 */

import type { AnnouncementKind } from "@/lib/announce";

/**
 * Kinds nothing in the site posts yet.
 *
 * Empty today, and deliberately kept rather than deleted: a kind can lose a
 * trigger as easily as gain one, and "is this announcement actually live" is a
 * question the settings screen should always be able to answer.
 *
 * Declared here rather than on `AnnouncementSpec` because it is a fact about
 * the *site*, not about the setting — `ANNOUNCEMENTS` is the vocabulary, and a
 * `wired: false` field on it would be a second thing to forget when the trigger
 * is wired up. `announcement-wording.test.ts` holds the list against the
 * builders `src/lib/discord.ts` actually imports, so wiring one and leaving
 * this behind fails the suite, which is the point of it.
 */
export const NOT_POSTED_YET: readonly AnnouncementKind[] = [];

/**
 * Whether anything in the site posts this kind today.
 *
 * The set is an argument with the constant as its default, rather than only the
 * constant, because the screen's job is to *say* what it is told and the fact
 * belongs to the deployment. It also keeps the saying testable when the list
 * happens to be empty: the warning on the screen is the whole reason this
 * exists, and a branch that can only be reached by editing a constant is a
 * branch nobody can prove still works.
 */
export function posted(
  kind: AnnouncementKind,
  notPosted: readonly AnnouncementKind[] = NOT_POSTED_YET
): boolean {
  return !notPosted.includes(kind);
}
