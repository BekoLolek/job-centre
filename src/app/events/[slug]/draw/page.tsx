/**
 * `/events/[slug]/draw` — the one screen a player actually sees of section K
 * (R-211, R-213 / UC-39).
 *
 * One click, nine cards turning about a second apart, then the hand grouped by
 * role. Everything *about* that is decided before the page renders: `loadDraw`
 * answers which of five screens this is, and on the one screen that has a
 * button, the nine either already exist in the database or do not exist at all.
 *
 * ## The hand is server-decided, and this file is where that is visible
 *
 * `HandReveal` is handed `initialHand` — the nine already stored against this
 * player and this event, read out of Postgres on this request — and `draw`, the
 * server action. It is handed **no pool**. There is nothing in its props it
 * could deal from, which is how R-212 is kept by shape: the reveal can only
 * uncover a hand that was written down before the first card turned, and a
 * player who closes the tab mid-animation holds exactly those nine.
 *
 * The action is bound to the slug here (`drawAction.bind(null, slug)`) rather
 * than imported by the client component, which is the pattern Next's own forms
 * guide gives. It also keeps `src/lib/hero-hands.ts` out of the browser's
 * module graph entirely.
 *
 * ## Why signing in is required, and why a non-participant gets a sentence
 *
 * A hand belongs to one person, so unlike `/events/[slug]` and the draft room
 * there is nothing here to read signed out — `requireUser`, as the apply page
 * does, and for the same reason.
 *
 * Past that, the gate is the event (404 for an event this viewer cannot see, so
 * a draft event does not announce itself) and then the seat. Somebody with no
 * seat is **told so** rather than shown an empty draw (UC-39 1a): a blank set
 * of nine slots and a dead button is the screen that makes people ask an admin
 * what is wrong with the site.
 *
 * Note that an admin who is not playing is a non-participant here, deliberately
 * and not by oversight. The draw deals a hand to each person holding a seat,
 * and an admin's own hand is not among them; nor is anybody else's hand theirs
 * to open — `handFor` is asked for this user's, only ever.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import { EventStatusPill, eventTypeLabel } from "@/components/events";
import { Badge, Button, Eyebrow, Page, PageHeader, Panel } from "@/components/ui";
import { getEventBySlug } from "@/lib/events";
import { handFor } from "@/lib/hero-hands";
import { canSeeEvent } from "@/lib/hosting";
import { requireUser } from "@/lib/session-guards";
import { drawAction } from "./actions";
import { loadDraw } from "./draw";
import HandReveal from "./HandReveal";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  return { title: event ? `Draw · ${event.title}` : "Draw · Job Centre Events" };
}

export default async function DrawPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();

  const now = new Date();
  const event = await getEventBySlug(slug, { now });
  if (!event) notFound();
  if (!(await canSeeEvent(user, event))) notFound();

  const payload = await loadDraw(event, user.id, handFor);

  return (
    <div className="min-h-screen">
      <AppHeader />

      {/* `reading`: one column of cards and the sentences around them. */}
      <Page width="reading" className="space-y-6">
        <nav className="text-12 text-muted">
          <Link href={`/events/${event.slug}`} className="hover:text-union">
            ← {event.title}
          </Link>
        </nav>

        <PageHeader
          eyebrow="Your draw"
          title={event.title}
          intro={
            <span className="flex flex-wrap items-center gap-2">
              <EventStatusPill status={event.status} />
              <Badge>{eventTypeLabel(event.type)}</Badge>
              {event.game && <Badge tone="union">{event.game.name}</Badge>}
            </span>
          }
        />

        {payload.kind === "ready" ? (
          <HandReveal
            initialHand={payload.hand}
            format={payload.format}
            roles={payload.roles}
            perRole={payload.perRole}
            draw={drawAction.bind(null, slug)}
          />
        ) : (
          <Panel as="section">
            <Eyebrow className="mb-3">{HEADINGS[payload.kind].eyebrow}</Eyebrow>
            <h2 className="font-display text-30 leading-none">
              {/*
                * Both of the game's own screens name it. A player who cannot
                * draw needs to know *which* list is the problem, because the
                * person who can fix it will ask.
                */}
              {payload.kind === "no_heroes"
                ? `${payload.game} has no hero list yet`
                : payload.kind === "too_thin"
                  ? `${payload.game}'s hero list is too thin to deal from`
                  : HEADINGS[payload.kind].title}
            </h2>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              {payload.kind === "too_thin" ? payload.refusal : HEADINGS[payload.kind].body}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href={`/events/${event.slug}`} variant="union">
                Back to the event
              </Button>
              {payload.kind === "no_seat" && <Button href="/me/events">My events</Button>}
            </div>
          </Panel>
        )}
      </Page>
    </div>
  );
}

/**
 * The four screens that are not a draw, each with its own sentence.
 *
 * Separate wording for each rather than one "you cannot draw" page, because
 * they are four different problems belonging to three different people: a seat
 * is the member's own application, an empty hero list is an admin's job on the
 * game screen, and an event with no game at all is a manager's on the event
 * editor. A shared sentence would send all three to the same dead end.
 *
 * `too_thin`'s body is not here: it is `drawHand`'s own refusal, naming every
 * role that is short and how many it holds (UC-39 2a), and a second sentence
 * written beside it would be the page disagreeing with the rule.
 */
const HEADINGS = {
  no_seat: {
    eyebrow: "Not your draw",
    title: "You do not hold a seat at this one",
    body:
      "The draw deals a hand to each person playing, so there is nothing here to turn " +
      "over for somebody who is not. If you have applied and are waiting on a decision, " +
      "or are sitting in the queue, your application is on My events — and if you think " +
      "you should be in, an admin can accept you from the applicant list at any time.",
  },
  no_game: {
    eyebrow: "Nothing to draw from",
    title: "This event has no game",
    body:
      "A hand is dealt from a game's hero list, and this event has not been given a " +
      "game — so there is no list to deal from. A manager can set one on the event's " +
      "Basics tab.",
  },
  no_heroes: {
    eyebrow: "Nothing to draw from",
    // Overridden above, because this one names the game.
    title: "This game has no hero list yet",
    body:
      "A hand is dealt from this game's heroes and the list is empty, so there is " +
      "nothing here to turn over. An admin can add them on the game's screen, and the " +
      "draw works the moment there are three in each role.",
  },
  too_thin: {
    eyebrow: "Nothing to draw yet",
    // Both overridden above: the title names the game, the body is `drawHand`'s
    // own refusal.
    title: "This hero list is too thin to deal from",
    body: "",
  },
} as const;
