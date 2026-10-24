import type { PlayerBook, TeamLike } from "@/components/draft";
import type {
  ChampionshipStatusValue,
  EventStatus,
  ProfileFieldOption,
  ProfileFieldType,
} from "@/db/schema";
import type {
  EventParticipants,
  RecordedPlacement,
} from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import type { TeamsFill } from "@/lib/draft";
import type { DraftConfig } from "@/lib/draft-policy";
import type { RoundScoring, TeamFormat } from "@/lib/events-policy";
import type { FormatView, ScheduleSettings } from "@/lib/format";
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
  /** User ids, in wheel order. */
  pool: { main: string[]; reserve: string[] };
  /** Accepted, but in neither a roster nor a pool — the "who is missing" line. */
  unpooled: string[];
  /** Went through the draft and were never picked up again. */
  discarded: string[];
  /** Everyone any of the three tabs might name, keyed by user id. */
  players: PlayerBook;
  /**
   * True once a lot has been awarded. Several settings stop being safe then —
   * `setDraftConfig` refuses to lower the roster target or to rewrite starting
   * balances — and a screen that offered them anyway would be offering a
   * rejection.
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
 * of the two is present without the other.
 */
export type ChampionshipTabData = {
  counting: EventChampionship | null;
  seasons: { id: string; name: string; status: ChampionshipStatusValue }[];
  result: {
    participants: EventParticipants;
    placements: RecordedPlacement[];
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
