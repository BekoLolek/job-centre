/**
 * The screen a member who may not watch a private draft gets (R-253 / UC-50 2a).
 *
 * Shaped like the draw page's refusals rather than like the room: the site's
 * own header, one column, a title, the sentence, and the way out. A signed-out
 * visitor is offered sign-in, because a captain who arrives signed out is an
 * observer until the cookie says otherwise, and "sign in" is the one thing
 * that could change the answer. Returning to the room afterwards is the `from`
 * the sign-in carries, so a captain lands back on it.
 *
 * Nothing about the draft itself is here — not the pool size, not who is on
 * the block, not how many lots have settled — because every one of those is
 * what the flag withholds. The decision to show this is the route's
 * (`./page.tsx`), made with `privateDraftFrom` and `mayWatchPrivateDraft`;
 * this file only says the words.
 *
 * Its own file rather than a function in the route, because the route hands
 * its header to `DraftRoom` and a page has one header owner
 * (`page-header.test.ts`'s `DELEGATES`): the route now hands off to one of
 * two components, and each draws its own `<PageHeader>`.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { Button, Eyebrow, Page, PageHeader, Panel } from "@/components/ui";
import { signInHref } from "@/lib/session-guards";

/** What a member turned away from a private draft reads (UC-50 2a). */
export const PRIVATE_DRAFT_TITLE = "This draft is private";
export const PRIVATE_DRAFT_SENTENCE =
  "Only its captains and the people running the event can watch it. The teams and their rosters are still on the event page.";

export default function PrivateDraft({
  slug,
  title,
  signedIn,
}: {
  slug: string;
  title: string;
  signedIn: boolean;
}) {
  return (
    <div className="min-h-screen">
      <AppHeader />

      <Page width="reading" className="space-y-6">
        <nav className="text-12 text-muted">
          <Link href={`/events/${slug}`} className="hover:text-union">
            ← {title}
          </Link>
        </nav>

        <PageHeader eyebrow="Draft room" title={title} />

        <Panel as="section">
          <Eyebrow className="mb-3">Captains and managers only</Eyebrow>
          <h2 className="font-display text-30 leading-none">{PRIVATE_DRAFT_TITLE}</h2>
          <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
            {PRIVATE_DRAFT_SENTENCE}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button href={`/events/${slug}?tab=teams`} variant="union">
              See the teams
            </Button>
            {!signedIn && (
              <Button href={signInHref({ from: `/events/${slug}/draft` })}>
                Sign in
              </Button>
            )}
          </div>
        </Panel>
      </Page>
    </div>
  );
}
