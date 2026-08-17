/**
 * `/admin/events/[id]` — the tabbed event editor (plan §6.3).
 *
 * One read builds the whole screen, and every tab saves itself. That is the
 * shape §6.3 asks for and it is also the only shape that survives an event
 * being edited over a fortnight: a page-wide submit means an admin who came
 * back to fix the capacity has to re-save the questions too, and re-saving
 * questions is not free — it re-validates every stored answer.
 *
 * Everything on screen comes from `src/lib/events.ts` and `src/lib/draft.ts`.
 * The eligibility column in the applicants table is `getApplicationsForEvent`'s,
 * not this page's; the legal status moves are `nextStatuses`'s; every balance
 * and every roster count is `getTeams`'s, derived from the awarded lots rather
 * than stored. Nothing here re-derives a rule.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import EventEditor from "@/components/admin/events/EventEditor";
import type { DraftTabData, FormatTabData } from "@/components/admin/events/types";
import { loadAdminGames } from "@/lib/admin-games";
import {
  getDiscardedPlayers,
  getDraftConfig,
  getDraftHistory,
  getDraftPool,
  getTeams,
  getUnpooledApplicants,
} from "@/lib/draft";
import {
  MAX_EVENT_DAYS,
  MAX_EVENT_QUESTIONS,
  getApplicationsForEvent,
  getEventById,
} from "@/lib/events";
import { MAX_STAGES, formatFor, matchIdsFor, scheduleSettingsFrom } from "@/lib/format";
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

  const [
    applicants,
    adminGames,
    teams,
    draftConfig,
    pool,
    unpooled,
    discarded,
    lots,
    formatView,
    matchIds,
  ] = await Promise.all([
    getApplicationsForEvent(event.id),
    loadAdminGames(),
    getTeams(event.id),
    getDraftConfig(event.id),
    getDraftPool(event.id),
    getUnpooledApplicants(event.id),
    getDiscardedPlayers(event.id),
    getDraftHistory(event.id),
    formatFor(event.id),
    matchIdsFor(event.id),
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

  // Everyone the three draft tabs might name. Applications cover the whole
  // cast — a captain, a pool entry and a drafted player are all applicants to
  // this event — and the display name is already on the row, so this costs no
  // extra read. `playerName` has a fallback for the one case it cannot cover:
  // an account removed while the event is still standing.
  const draft: DraftTabData = {
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      seed: team.seed,
      captainUserId: team.captainUserId,
      balanceStart: team.balanceStart,
      balance: team.balance,
      roster: team.roster,
      members: team.members.map((member) => ({
        teamId: member.teamId,
        userId: member.userId,
        price: member.price,
        isCaptain: member.isCaptain,
      })),
    })),
    config: draftConfig,
    pool: {
      main: pool.main.map((entry) => entry.userId),
      reserve: pool.reserve.map((entry) => entry.userId),
    },
    unpooled,
    discarded,
    players: Object.fromEntries(
      applicants.map((row) => [
        row.member.id,
        {
          displayName: row.member.displayName ?? row.member.discordId ?? "Unknown member",
          avatarUrl: row.member.avatarUrl,
        },
      ])
    ),
    started: lots.some((lot) => lot.status === "awarded"),
  };

  // One `formatFor` for all three format tabs. It cannot be null here — the
  // event was just read — but the type says it can, because an event deleted
  // between the two reads is a real thing rather than an impossible one.
  const format: FormatTabData = {
    view: formatView ?? {
      eventId: event.id,
      teams: [],
      stages: [],
      blocks: [],
      dayMinutes: [],
      timing: scheduleSettingsFrom(event.config).timing,
      concurrentLobbies: scheduleSettingsFrom(event.config).concurrentLobbies,
      days: scheduleSettingsFrom(event.config).days,
    },
    settings: scheduleSettingsFrom(event.config),
    matchIds,
  };

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
          draft={draft}
          format={format}
          maxDays={MAX_EVENT_DAYS}
          maxQuestions={MAX_EVENT_QUESTIONS}
          maxStages={MAX_STAGES}
        />
      </main>
    </div>
  );
}
