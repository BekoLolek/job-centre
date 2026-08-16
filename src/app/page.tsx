import SessionNav from "@/components/SessionNav";
import TournamentBoard from "@/components/tournament/TournamentBoard";

export const dynamic = "force-dynamic";

export default function Home() {
  // `SessionNav` is a server component handed to a client one as a prop: it is
  // rendered here, where the session cookie is readable, and arrives at the
  // board as finished output (plan §4).
  return <TournamentBoard nav={<SessionNav />} />;
}
