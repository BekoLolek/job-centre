/**
 * `/admin/events/[id]` — the tabbed event editor (plan §6.3).
 *
 * One read builds the whole screen, and every tab saves itself. That is the
 * shape §6.3 asks for and it is also the only shape that survives an event
 * being edited over a fortnight: a page-wide submit means an admin who came
 * back to fix the capacity has to re-save the questions too, and re-saving
 * questions is not free — it re-validates every stored answer.
 *
 * Everything on screen comes from `src/lib/events.ts`. The eligibility column
 * in the applicants table is `getApplicationsForEvent`'s, not this page's;
 * the legal status moves are `nextStatuses`'s. Nothing here re-derives a rule.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import EventEditor from "@/components/admin/events/EventEditor";
import { loadAdminGames } from "@/lib/admin-games";
import {
  MAX_EVENT_DAYS,
  MAX_EVENT_QUESTIONS,
  getApplicationsForEvent,
  getEventById,
} from "@/lib/events";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEventById(id);
  return { title: event ? `${event.title} · Admin` : "Event · Admin" };
}

export default async function AdminEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const event = await getEventById(id);
  if (!event) notFound();

  const [applicants, adminGames] = await Promise.all([
    getApplicationsForEvent(event.id),
    loadAdminGames(),
  ]);

  // What a question on this event may prefill from: its game's profile fields
  // plus the global ones. A field belonging to another game would prefill an
  // answer the member gave about a different game entirely — `setEventQuestions`
  // refuses those, so the picker must not offer them.
  const gameFields = event.gameId
    ? (adminGames.games.find((game) => game.id === event.gameId)?.fields ?? [])
    : [];

  const linkableFields = [
    ...adminGames.globalFields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options,
      required: field.required,
      scope: "Everyone",
    })),
    ...gameFields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options,
      required: field.required,
      scope: event.game?.name ?? "This game",
    })),
  ];

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-8 sm:px-6">
        <EventEditor
          event={event}
          applicants={applicants}
          games={adminGames.games.map((game) => ({
            id: game.id,
            name: game.name,
            isActive: game.isActive,
            rankLadder: game.rankLadder,
          }))}
          linkableFields={linkableFields}
          maxDays={MAX_EVENT_DAYS}
          maxQuestions={MAX_EVENT_QUESTIONS}
        />
      </main>
    </div>
  );
}
