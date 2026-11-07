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
 * not this page's; the legal status moves are `EVENT_STATUS_FLOW`'s; every balance
 * and every roster count is `getTeams`'s, derived from the awarded lots rather
 * than stored. Nothing here re-derives a rule.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import { Page } from "@/components/ui";
import AdminNav from "@/components/admin/AdminNav";
import EventEditor from "@/components/admin/events/EventEditor";
import { type HeroListFact, type TabVisibility, landOn } from "@/components/admin/events/tabs";
import type {
  ChampionshipTabData,
  DealtHand,
  DraftTabData,
  FormatTabData,
  HandsTabData,
} from "@/components/admin/events/types";
import { loadAdminGames } from "@/lib/admin-games";
import { manualAnnouncementPanel } from "@/lib/discord";
import { championshipOfEvent, championshipsToAddTo } from "@/lib/championships";
import { eventParticipants, finishingOrderFor } from "@/lib/championship-results";
import {
  getDiscardedPlayers,
  getDraftConfig,
  getDraftHistory,
  getDraftPool,
  getRosterSizing,
  getTeams,
  getUnpooledApplicants,
  teamsFillOf,
} from "@/lib/draft";
import {
  type ApplicantView,
  MAX_EVENT_DAYS,
  MAX_EVENT_QUESTIONS,
  getApplicationsForEvent,
  getEventById,
} from "@/lib/events";
import { eventShapeFrom, privateDraftFrom, teamFormatFrom } from "@/lib/events-policy";
import { MAX_STAGES, formatFor, matchIdsFor, scheduleSettingsFrom } from "@/lib/format";
import { handSheet } from "@/lib/hands-sheet";
import { type StoredHand, handsFor } from "@/lib/hero-hands";
import { HERO_ROLES, hasHeroList } from "@/lib/heroes";
import { listRoundScores } from "@/lib/round-scores";
import { requireEventManager } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEventById(id);
  return { title: event ? `${event.title} · Admin` : "Event · Admin" };
}

export default async function AdminEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?tab=` — where `/admin`'s "what needs attention" lines land. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  /*
   * Admins reach every event; a host reaches the one they were given. The
   * guard needs the id, so it runs after the params rather than before — and
   * `requireEventManager` redirects a member who wanders here by id, so
   * nothing below runs for somebody who should not see it.
   */
  const manager = await requireEventManager(id);
  const { tab } = await searchParams;

  const event = await getEventById(id);
  if (!event) notFound();

  const [
    applicants,
    adminGames,
    teams,
    draftConfig,
    rosterSizing,
    pool,
    unpooled,
    discarded,
    lots,
    formatView,
    matchIds,
    counting,
    seasons,
    announcements,
    roundScores,
    hasHeroes,
    hands,
  ] = await Promise.all([
    getApplicationsForEvent(event.id),
    loadAdminGames(),
    getTeams(event.id),
    getDraftConfig(event.id),
    // R-248 / UC-49 2: the places on a team, from the Format panel through
    // the same read `getTeams` sized its rosters with.
    getRosterSizing(event.id),
    getDraftPool(event.id),
    getUnpooledApplicants(event.id),
    getDiscardedPlayers(event.id),
    getDraftHistory(event.id),
    formatFor(event.id),
    matchIdsFor(event.id),
    championshipOfEvent(event.id),
    /*
     * UC-32 1. Which seasons may be offered to *this* reader is
     * `championshipsToAddTo`'s rule, not this page's: an admin is offered the
     * hidden ones too, a host only the published (UC-31 2). The season this
     * event is already in comes across whatever its status, because the panel
     * has to be able to say what it is in.
     */
    championshipsToAddTo(manager),
    /*
     * UC-43 2. The five kinds that take an event, each with its switch, its
     * claim and whatever stops it being posted — read here because
     * `manualAnnouncementPanel` reaches Postgres and the Publish tab is a
     * client component (see `EventEditorProps.announcements`).
     */
    manualAnnouncementPanel(event.id),
    /*
     * UC-44 2b, 3a, 4d. The rows the Scoring panel counts before it refuses —
     * read here because `listRoundScores` reaches Postgres and the panel is a
     * client component (see `EventEditorProps.roundScores`).
     */
    listRoundScores(event.id),
    /*
     * UC-47 preconditions. Whether the game has a hero list decides whether
     * the Hands tab is drawn at all, and it is a fact about another table —
     * `events.config` cannot say — so it is read here and handed to the editor
     * (see `TabVisibility.heroList`). `false` for an event with no game: the
     * fact below then says so by the game's absence, and nothing is probed.
     */
    event.game ? hasHeroList(event.game.id) : false,
    /*
     * UC-47 2. Every hand dealt on this event — read here because `handsFor`
     * reaches Postgres and the Hands tab is a client component. An event with
     * no game, or one nobody has drawn on, is an empty record, so this costs
     * one query in the common case and is never a refusal.
     */
    handsFor(event.id),
  ]);

  /*
   * UC-33 2. Only for an event that is in a season: there is no finishing
   * order to record for one that counts towards nothing, and these two reads
   * would be two queries on every event editor for nothing. `eventParticipants`
   * decides teams-or-applicants, not this page, and `finishingOrderFor` decides
   * typed-order-or-table (UC-46 5) — the panel is told, never asked.
   */
  const result = counting
    ? await Promise.all([eventParticipants(event.id), finishingOrderFor(event.id)]).then(
        ([participants, order]) => ({ participants, order })
      )
    : null;

  const championship: ChampionshipTabData = { counting, seasons, result };

  /*
   * UC-47 1a, 1b. The game's name travels with the fact because the sentence
   * for an empty list has to name it — `HeroListFact` says why it is not a
   * boolean. `event.game` rather than `event.gameId`, the same read the probe
   * above used: a game row that has gone is an event with no game.
   */
  const heroList: HeroListFact = event.game
    ? { game: event.game.name, heroes: hasHeroes }
    : { game: null };

  /*
   * R-219 / UC-42 5, 5a; R-239 / UC-47 1a, 1b. Two of the three facts are one
   * key on `events.config` (`eventShapeFrom`) and cost no read of their own;
   * the third is the hero list read above. Together they decide whether the
   * tab the URL asked for is a tab this event has — and the same object goes
   * to the editor, so the rail and the landing cannot be reading two answers.
   */
  const visibility: TabVisibility = { ...eventShapeFrom(event.config), heroList };
  const landing = landOn(tab, visibility);

  // How a row names its member, for the players book and the hands sheet
  // alike. `playerName` has a fallback for the one case this cannot cover: an
  // account removed while the event is still standing.
  const nameOf = (member: ApplicantView["member"]) =>
    member.displayName ?? member.discordId ?? "Unknown member";

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
  // extra read.
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
    sizing: rosterSizing,
    pool: {
      main: pool.main.map((entry) => entry.userId),
      reserve: pool.reserve.map((entry) => entry.userId),
    },
    unpooled,
    discarded,
    players: Object.fromEntries(
      applicants.map((row) => [
        row.member.id,
        { displayName: nameOf(row.member), avatarUrl: row.member.avatarUrl },
      ])
    ),
    started: lots.some((lot) => lot.status === "awarded"),
    // R-215's stored choice. On `events.config` beside the schedule settings,
    // which is why Task 78 needed no migration — see `teamFormatFrom`.
    teamFormat: teamFormatFrom(event.config),
    // R-220 / UC-42 6a: over the rows already read above, so no extra query.
    fill: teamsFillOf(teams, event.config),
    // R-253 / UC-50: the same top-level key the room's door reads.
    privateDraft: privateDraftFrom(event.config),
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

  /*
   * UC-47 2-4, 2a, 3a, 4a. `handSheet` decides the rows from the applications
   * as the Applicants tab lists them and every hand read above; this maps each
   * hand down to what a card shows before it crosses to the browser —
   * `DealtHand` has the standard it follows. `HERO_ROLES` is read here rather
   * than in the panel because `src/lib/heroes.ts` reaches Postgres.
   */
  const dealt = (hand: StoredHand): DealtHand => ({
    roles: HERO_ROLES.map((role) => ({
      role,
      names: hand.heroes[role].map((hero) => hero.name),
    })),
    dealtAt: hand.dealtAt.toISOString(),
  });
  const sheet = handSheet(applicants, hands);
  const handsData: HandsTabData = {
    kind: sheet.kind,
    seats: sheet.seats.map((row) => ({
      userId: row.userId,
      name: nameOf(row.member),
      hand: row.hand ? dealt(row.hand) : null,
    })),
    former: sheet.former.map((row) => ({
      userId: row.userId,
      name: row.member ? nameOf(row.member) : null,
      hand: dealt(row.hand),
    })),
    drawn: sheet.drawn,
  };

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/*
        `wide`: the densest screen on the site. The applicants table is
        `min-w-[820px]`, the schedule and bracket tabs draw a grid per day, and
        the teams tab runs four `min-w-[11rem]` columns — all of them inside
        their own horizontal scrollers, and every pixel here is a pixel they do
        not have to scroll. The page header is `EventEditor`'s, because the
        title, the state and the counts are all its own `event`.
      */}
      <Page width="wide" className="space-y-6">
        <EventEditor
          event={event}
          /*
           * Admin, not manager. `requireEventManager` admits the event's own
           * host as well, and a host may run this one event without being able
           * to mint a template for every future one (R-22, UC-08 10a) - so the
           * editor is told who is reading rather than being left to assume.
           * `getCurrentUser` is server-only, and a server page handing the flag
           * down is how `NavMenu`, `PollList` and `SuggestionBox` all do it.
           */
          isAdmin={manager.isAdmin}
          /*
           * UC-42 5a. `?tab=` is read here, on the server, which is why the
           * decision about where it may land is `tabs.ts`'s and not the
           * editor's — see that module's docblock for the request-time failure
           * that rule exists to avoid. A link naming a tab this event does not
           * have lands on Setup → Format, the screen that would bring it back,
           * carrying the sentence that says why.
           */
          initialTab={landing.tab}
          initialSetup={landing.setup}
          tabNotice={landing.why}
          /*
           * UC-47. The same fact `landOn` just read, so the rail the editor
           * draws and the landing the page chose agree by construction; and
           * the sheet, mapped down above.
           */
          heroList={heroList}
          hands={handsData}
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
          championship={championship}
          roundScores={roundScores}
          announcements={announcements}
          maxDays={MAX_EVENT_DAYS}
          maxQuestions={MAX_EVENT_QUESTIONS}
          maxStages={MAX_STAGES}
        />
      </Page>
    </div>
  );
}
