/**
 * `/admin/hands` — every hand one player has ever been dealt (R-244 to R-247
 * / UC-48).
 *
 * The per-event sheet on `/admin/events/[id]?tab=hands` shows one night's
 * hands; this shows one player's across every night, so an admin can answer
 * "have they had this hero three weeks running" from the rows rather than
 * from memory. The picker is the members who have actually drawn (R-246), the
 * chosen one comes from `?player=`, and what is shown is their hands newest
 * first with how many nights each hero has come up (R-244, R-245).
 *
 * ## Admin, not manager (R-247 / UC-48 1a)
 *
 * Guarded by `requireAdmin()`, the line `/admin/users` and `/admin/audit`
 * already draw, and deliberately narrower than the per-event sheet, which is
 * `requireEventManager` because it is about the one event that host runs.
 * This page spans events, so it is not one host's: a host who manages Friday
 * must not see what was dealt on every other night. The guard sends a
 * signed-in non-admin to `/signin?error=admin-only` rather than to the `/me`
 * a stranger to an event gets, and `player-hands.test.ts` asserts that
 * destination for a host specifically — a downgrade to `requireEventManager`
 * or `requireUser` would admit them.
 *
 * ## The chosen player is in the URL
 *
 * `?player=` rather than client state, so a link to one player's history is a
 * link somebody can send and the page stays a server component with nothing
 * to lose on a refresh — the same reason the audit page keeps its filter in
 * the URL. **Nobody is picked by default** (UC-48 3a): whose history is being
 * read is not a thing to guess at, so with no `?player=` the page shows the
 * list and asks, and names nobody's hands.
 *
 * An id that names nobody in the list — a member who has never drawn, or no
 * member at all — reads no hand and says so (`/admin/audit`'s rule for an id
 * that names no event): the list is the authority on who has a history, and
 * `handsOfPlayer` is only asked about somebody on it, so a wrong link cannot
 * show another player's hands and cannot throw.
 *
 * **No instant is formatted here.** `dealtAt` crosses as ISO and goes through
 * `LocalTime`, which prints in the reader's own zone.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import PlayerHands, {
  type PlayerHandsData,
  type PlayerHandsView,
  type PlayerNight,
} from "@/components/admin/PlayerHands";
import { ZoneNote } from "@/components/format";
import { Page, PageHeader, StatTile } from "@/components/ui";
import { heroNights } from "@/lib/hand-history";
import { type PlayerHand, handsOfPlayer, playersWithHands } from "@/lib/hero-hands";
import { HERO_ROLES } from "@/lib/heroes";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hands · Job Centre Events",
};

export default async function AdminHandsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const raw = Array.isArray(params.player) ? params.player[0] : params.player;

  /*
   * UC-48 2. The list first, whatever the URL says: it is both the picker and
   * the only authority on whose history exists. `playersWithHands` is one
   * grouped statement and lists nobody without a hand, which is what lets the
   * lookup below stand in for "has this member ever drawn" with no second read.
   */
  const players = await playersWithHands();
  const chosen = raw ? (players.find((player) => player.userId === raw) ?? null) : null;

  /*
   * UC-48 4, 5. Only for somebody on the list — an id naming nobody reads
   * nothing, so the wrong link is a sentence and never another player's hands.
   * `handsOfPlayer` orders newest first in the query; this page keeps that
   * order and maps each hand down to what a card shows before it crosses to
   * the browser — `PlayerNight` has the standard it follows. The tally is
   * `heroNights` over the full hands, since it counts by id and the ids do not
   * cross; `HERO_ROLES` is read here rather than in the panel because
   * `src/lib/heroes.ts` reaches Postgres.
   */
  const hands = chosen ? await handsOfPlayer(chosen.userId) : [];

  const dealt = (hand: PlayerHand): PlayerNight => ({
    event: { id: hand.event.id, title: hand.event.title },
    roles: HERO_ROLES.map((role) => ({
      role,
      names: hand.heroes[role].map((hero) => hero.name),
    })),
    dealtAt: hand.dealtAt.toISOString(),
  });

  const view: PlayerHandsView = chosen
    ? {
        kind: "player",
        player: chosen,
        hands: hands.map(dealt),
        tally: heroNights(hands).map((entry) => ({ name: entry.hero.name, nights: entry.nights })),
      }
    : raw
      ? { kind: "unknown" }
      : { kind: "pick" };

  const data: PlayerHandsData = { players, view };

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/*
        `standard`, not `wide`: a hand is three short columns and the tally is
        a list of names, neither of which has anything to do with a wider
        page. The per-event sheet is `wide` for the applicants table beside
        it, which is not here.
      */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Hands"
          title="Hands"
          intro="Every hand one player has been dealt, event by event, and on how many nights each hero has come up for them. The draw happens once and stands: there is nothing here to reroll, clear or keep out of a next draw."
          aside={
            <>
              <StatTile label="Have drawn" value={players.length} />
              {chosen && <StatTile label="Nights" value={chosen.hands} />}
            </>
          }
        />

        <PlayerHands data={data} />

        <p className="pb-4 text-center text-12 text-muted">
          <ZoneNote /> Nothing on this page changes a hand. What was dealt was dealt, and a
          hero that has since been retired or renamed is shown as the roster names it now.
        </p>
      </Page>
    </div>
  );
}
