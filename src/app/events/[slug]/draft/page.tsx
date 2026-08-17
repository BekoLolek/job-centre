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
 * Anyone, signed out included (§11's "watch the live draft" row). The only gate
 * is the event itself: a `draft` event does not exist as far as anybody but an
 * admin is concerned, so it answers 404 rather than 403 — exactly as
 * `/events/[slug]` does, and for the same reason. Members must not be able to
 * learn that an unpublished event exists by knocking on its draft room.
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
import { getEventBySlug } from "@/lib/events";
import { getCurrentUser } from "@/lib/session-guards";
import DraftRoom from "./DraftRoom";
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
  if (event.status === "draft" && !user?.isAdmin) notFound();

  const payload = await loadRoom(event.id, user, now);
  // `loadRoom` only returns null when the event has gone, which cannot happen
  // between the two reads above without the row being deleted mid-request.
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
