/**
 * `/board` — the Marvel Rivals tournament board.
 *
 * This page used to be `/`. Phase 2 gives the site a hub, and the hub is what a
 * visitor who has never heard of the draft should land on — so the board moved
 * here unchanged and the hub links to it. Nothing inside it was touched: same
 * component, same storage, same behaviour, one link away.
 */

import SessionNav from "@/components/SessionNav";
import TournamentBoard from "@/components/tournament/TournamentBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tournament board · Job Centre Events",
};

export default function BoardPage() {
  // `SessionNav` is a server component handed to a client one as a prop: it is
  // rendered here, where the session cookie is readable, and arrives at the
  // board as finished output (plan §4).
  return <TournamentBoard nav={<SessionNav />} />;
}
