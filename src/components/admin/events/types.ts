import type { PlayerBook, TeamLike } from "@/components/draft";
import type {
  ChampionshipStatusValue,
  EventStatus,
  HeroRole,
  ProfileFieldOption,
  ProfileFieldType,
} from "@/db/schema";
import type {
  EventParticipants,
  FinishingOrder,
} from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import type { TeamsFill } from "@/lib/draft";
import type { DraftConfig } from "@/lib/draft-policy";
import type { RosterSizing, RoundScoring, TeamFormat } from "@/lib/events-policy";
import type { FormatView, ScheduleSettings } from "@/lib/format";
import type { HandSheet } from "@/lib/hands-sheet";
import type { RoundScoreRow } from "@/lib/round-scoring";

/**
 * The props the event editor's tabs share.
 *
 * Kept out of the components so a tab can be read without following an import
 * chain through five files, and so the server page has one place to look when
 * it builds them.
 */

/** A game the event can belong to, with the ladder its rank gates read. */
export type GameOption = {
  id: string;
  name: string;
  isActive: boolean;
  rankLadder: string[];
};

/**
 * A profile field this event's questions may prefill from — the event's game's,
 * plus the global ones. `setEventQuestions` refuses anything else, so the
 * picker must not offer anything else either.
 */
export type LinkableField = {
  id: string;
  key: string;
  label: string;
  type: ProfileFieldType;
  options: ProfileFieldOption[];
  required: boolean;
  /** "Everyone", or the game's name. Shown so the admin knows what they linked. */
  scope: string;
};

/**
 * Everything the Teams, Captains and Draft tabs read, in one bundle.
 *
 * One server read builds it and all three tabs share it, because they are three
 * views of one thing: a team's roster is what the Captains tab fills and what
 * the Draft tab prices, and a screen that fetched them separately could show a
 * captain who is not yet on the roster the balance was computed from.
 *
 * The team shape is `TeamLike` — the structural subset `src/components/draft/`
 * asks for, which `TeamWithRoster` already satisfies — so the server page maps
 * once and nothing downstream needs the database types.
 */
export type DraftTabData = {
  teams: TeamLike[];
  /** As stored, or `DEFAULT_DRAFT_CONFIG` when the tab has never been saved. */
  config: DraftConfig;
  /**
   * The places on a team, as the Format panel implies them (R-248 / UC-49 2)
   * — `getRosterSizing`, the same read the public card and the draft room
   * make, so the three tabs print the figure those screens enforce.
   *
   * Carried beside `teams` rather than read off `teams[0].roster`, because
   * the Captains tab states the figure before any team exists. `cap` is what
   * every tab prints and counts against; `target` is set only under "players
   * on a team", when the figure is the admin's own number.
   */
  sizing: RosterSizing;
  /** User ids, in wheel order. */
  pool: { main: string[]; reserve: string[] };
  /** Accepted, but in neither a roster nor a pool — the "who is missing" line. */
  unpooled: string[];
  /** Went through the draft and were never picked up again. */
  discarded: string[];
  /** Everyone any of the three tabs might name, keyed by user id. */
  players: PlayerBook;
  /**
   * True once a lot has been awarded. Some settings stop being safe then —
   * `setDraftConfig` stops rewriting starting balances — and a screen that
   * offered them anyway would be offering a rejection.
   */
  started: boolean;
  /**
   * The night's format as stored, from `teamFormatFrom(event.config)` —
   * R-215's 6v6 or 3v3, the team size it implies and the comp it states.
   *
   * Read on the server like every other field here, so the tab renders what is
   * stored rather than what was last clicked. The comp is for *printing*: no
   * tab reads it back to refuse anything (UC-41 2).
   */
  teamFormat: TeamFormat;
  /**
   * Which route filled the current rosters — by hand, at random, or the draft
   * (R-220 / UC-42 6a) — from `teamsFillOf` over the same `getTeams` rows the
   * teams above came from, plus the mark the shuffle leaves on the event.
   *
   * Computed on the server because the answer needs `lotId` and `acquiredAt`,
   * which `TeamLike` deliberately does not carry to the client.
   */
  fill: TeamsFill;
  /**
   * Whether the room is served to captains and managers only (R-253 / UC-50),
   * from `privateDraftFrom(event.config)` — the same read the room's page and
   * `loadRoom` make, so the tab shows the answer the door is enforcing.
   *
   * Required rather than optional, for `TabVisibility.heroList`'s reason: a
   * caller that forgot it would draw the control as "Everyone" on a draft the
   * server is keeping private, and the compiler naming every caller is what
   * stops that.
   */
  privateDraft: boolean;
};

/**
 * What the Championship panel reads (UC-32).
 *
 * `counting` is the season this event is already in — null for the common case
 * of an event that counts towards nothing, and present whatever that season's
 * status, because the panel has to be able to say what the event is in.
 *
 * `seasons` is what may be *offered* to whoever is reading, which is
 * `championshipsToAddTo`'s rule: never a finished season, and hidden ones for
 * admins only (UC-31 2).
 *
 * `result` is UC-33's half: who took part, and where they finished. Null for
 * the same reason and in the same case as `counting` — an event in no season
 * has no finishing order to record — so the panel never has to ask whether one
 * of the two is present without the other. `order` says where the places come
 * from — the typed rows, or a round-scored night's table (UC-46 5) — and the
 * panel draws the editor or the read-only table accordingly.
 */
export type ChampionshipTabData = {
  counting: EventChampionship | null;
  seasons: { id: string; name: string; status: ChampionshipStatusValue }[];
  result: {
    participants: EventParticipants;
    order: FinishingOrder;
  } | null;
};

/**
 * Everything the Format, Schedule and Results tabs read, in one bundle.
 *
 * One server read builds it and all three tabs share it, for the same reason
 * `DraftTabData` is shared — and here the argument is stronger. The shape the
 * Format tab generates *is* the block plan the Schedule tab lays out and *is*
 * the cards the Results tab records against, all three of them derived from one
 * `formatFor` call. Tabs holding separate reads could show a running order for
 * a bracket that had already been regenerated underneath it.
 */
export type FormatTabData = {
  /** `formatFor` — stages, resolved matches, standings, blocks and day totals. */
  view: FormatView;
  /**
   * `scheduleSettingsFrom(event.config)`. `FormatView` carries the three
   * numbers the board needs but not `blockDays`, which only the Schedule tab
   * edits — so it comes across separately rather than being guessed at.
   */
  settings: ScheduleSettings;
  /**
   * Slot to `matches.id`, from `matchIdsFor`.
   *
   * A `ResolvedMatch` carries no id: it is a generated slot plus whatever is
   * stored against it, and the generated half has no row — which is exactly
   * what lets a bracket be previewed before it exists. The writes take a row
   * id, so the mapping travels alongside the board.
   */
  matchIds: Record<string, string>;
};

/**
 * What the Results tab reads for a round-scored night (UC-45), in one bundle.
 *
 * Nothing here is a new read: the editor already holds every piece — the
 * setup is one key on `event.config`, the rows are `EventEditorProps.roundScores`,
 * the names are the draft bundle's `players`, the seats are the accepted
 * applicants, and the status is the event's own. Bundled so the Results tab
 * takes one prop for the round sheet rather than five, the way the Format and
 * Draft tabs take theirs.
 *
 * `scoring` is **null for a night that is not scored in rounds**, and the tab
 * then draws no sheet at all — `roundScoringFrom`'s default, which is every
 * event on the site today.
 */
export type RoundScoresData = {
  scoring: RoundScoring | null;
  rows: RoundScoreRow[];
  players: PlayerBook;
  /** The accepted applicants' user ids: the players (UC-45 pre 3). */
  seated: string[];
  /** For UC-09 6b's lock, so the sheet can say so before the server has to. */
  status: EventStatus;
};

/**
 * One dealt hand as the Hands tab draws it (R-241, R-242 / UC-47 2).
 *
 * `handSheet` hands the page `StoredHand`s — full hero rows, `gameId`,
 * `retiredAt` and `createdAt` included, and a `Date` — and none of that crosses
 * to the browser. The standard is `handCards` in
 * `src/app/events/[slug]/draw/draw.ts`: only what a card shows crosses, because
 * a payload carrying `retiredAt` would be telling the reader which heroes have
 * been retired, and UC-47 2b says a retired hero is named with no mark against
 * it. A card on this sheet shows a name, so a name is what crosses; the role is
 * the group it sits in. `dealtAt` is ISO rather than a `Date` for
 * `ApplicationView.answerConfirmedAt`'s reason — the tab is a client component
 * and `LocalTime` formats the instant in the reader's zone.
 *
 * The roles arrive **already grouped, in deal order** — `HERO_ROLES` order,
 * three names each, as `StoredHand.heroes` holds them — so the panel draws what
 * it is given and regroups nothing. `HERO_ROLES` lives in `src/lib/heroes.ts`,
 * which reaches Postgres, so the page is the side that knows the order.
 */
export type DealtHand = {
  roles: { role: HeroRole; names: string[] }[];
  /** When Postgres stored it, ISO. */
  dealtAt: string;
};

/** A seat on the sheet (UC-47 2, 3): named, and holding a hand or not yet. */
export type SeatHandRow = {
  userId: string;
  name: string;
  hand: DealtHand | null;
};

/**
 * A hand whose holder no longer holds a seat (UC-47 3a). `name` is null when
 * there is no application row to name them from — `FormerRow.member`'s case in
 * `src/lib/hands-sheet.ts` — and the panel says so rather than printing an id.
 */
export type FormerHandRow = {
  userId: string;
  name: string | null;
  hand: DealtHand;
};

/**
 * Everything the Hands tab reads, in one bundle (R-239 to R-243 / UC-47).
 *
 * `handSheet` decided the rows, their order and the state the screen opens in
 * (`kind`); the page mapped each hand down to {@link DealtHand}. The tab takes
 * the result as one prop, the way the Results tab takes `RoundScoresData`, and
 * decides nothing of its own.
 */
export type HandsTabData = {
  kind: HandSheet["kind"];
  /** UC-47 2: every seat, in the Applicants tab's order. */
  seats: SeatHandRow[];
  /** UC-47 3a: after every seat. */
  former: FormerHandRow[];
  /** UC-47 4: how many of `seats` have drawn. */
  drawn: number;
};
