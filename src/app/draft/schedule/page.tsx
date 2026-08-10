import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import TournamentBoard from "@/components/tournament/TournamentBoard";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Captains and the observer get the public board; results entry is the admin's alone.
  if (session.role !== "admin") redirect("/");
  return <TournamentBoard admin />;
}
