/**
 * `/events/[slug]/draft` — the live draft room (docs/platform-plan.md §9, §11).
 *
 * The highest-stakes screen on the site: it runs live, in front of everybody,
 * and a mistake made on it cannot be taken back gracefully. Everything it shows
 * is derived on the server and redacted by `redactDraft` before it leaves —
 * this page assembles nothing by hand.
 *
 * ## Who may open it
 *
 * Anyone, signed out included (§11's "watch the live draft" row) — **unless
 * the draft is private** (R-253 / UC-50), in which case its captains and its
 * managers and nobody else. Two gates, answering two different questions:
 *
 *  - The event itself. A `draft` event does not exist as far as anybody but
 *    its managers (an admin, or a host of that event) are concerned, so it
 *    answers 404 rather than 403 — exactly as `/events/[slug]` does, and for
 *    the same reason. Members must not be able to learn that an unpublished
 *    event exists by knocking on its draft room.
 *  - The draft's privacy. A published event whose draft is private is not a
 *    secret — its page, its teams and its rosters are public (UC-50 4) — so
 *    somebody turned away is **told** the draft is private (2a) rather than
 *    404'd or shown an empty room. The words are `./PrivateDraft.tsx`'s,
 *    exported from there so the test asserts the sentence a member reads.
 *
 * ## The guard is this page's own, and it is also the payload's
 *
 * "A hidden link is not an authorisation" (UC-50 2a): the event page's "Watch
 * the draft room" button is not the door, this is — and `loadRoom` in
 * `./room.ts` is the door again for the poll, which a browser can call without
 * ever rendering this page. The two ask the same pair of questions
 * (`privateDraftFrom`, then `mayWatchPrivateDraft`) so they cannot disagree
 * about who is let in; this page asks them first only because it has a
 * sentence to choose. The repo's own note in
 * `src/components/admin/events/tabs.ts` is the standard: render-time gating is
 * not a security boundary, so nothing about this is left to what the rail or
 * the room happens to draw.
 *
 * ## Why the first paint comes from here
 *
 * The room polls (§3.4: ~1s for a live draft), but a page that renders empty
 * and fills in a second later is a page that flickers on every projector in the
 * room. So the payload is fetched server-side and handed to the client as its
 * initial state; the poll only ever replaces it.
 */

import { notFound } from "next/navigation";
import SessionNav from "@/components/SessionNav";
import { viewerFor } from "@/lib/draft";
import { mayWatchPrivateDraft } from "@/lib/draft-policy";
import { getEventBySlug } from "@/lib/events";
import { privateDraftFrom } from "@/lib/events-policy";
import { canSeeEvent } from "@/lib/hosting";
import { getCurrentUser } from "@/lib/session-guards";
import DraftRoom from "./DraftRoom";
import PrivateDraft from "./PrivateDraft";
import { loadRoom } from "./room";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  if (!event || event.status === "draft") return { title: "Draft · Job Centre Events" };
  return { title: `Draft · ${event.title}` };
}

export default async function DraftRoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const now = new Date();

  const [event, user] = await Promise.all([getEventBySlug(slug, { now }), getCurrentUser()]);
  if (!event) notFound();
  if (!(await canSeeEvent(user, event))) notFound();

  /*
   * UC-50 2, 2a, 2b. The role is read only when the flag is on, because for a
   * public draft it is `loadRoom`'s to read and reading it twice on every
   * public page load would buy nothing. For a private one the second read is
   * the price of a sentence rather than a blank, and it is two indexed rows.
   */
  if (privateDraftFrom(event.config)) {
    const viewer = await viewerFor(event.id, user?.id ?? null, user?.isAdmin ?? false);
    if (!mayWatchPrivateDraft(viewer)) {
      return <PrivateDraft slug={event.slug} title={event.title} signedIn={Boolean(user)} />;
    }
  }

  const payload = await loadRoom(event.id, user, now);
  // `loadRoom` only returns null when the event has gone, which cannot happen
  // between the two reads above without the row being deleted mid-request —
  // its other reason for null was answered above, with a sentence.
  if (!payload) notFound();

  return (
    <DraftRoom
      event={{ id: event.id, slug: event.slug, title: event.title }}
      initial={payload}
      signedIn={Boolean(user)}
      nav={<SessionNav />}
    />
  );
}
