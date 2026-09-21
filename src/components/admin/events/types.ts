import type { PlayerBook, TeamLike } from "@/components/draft";
import type {
  ChampionshipStatusValue,
  ProfileFieldOption,
  ProfileFieldType,
} from "@/db/schema";
import type {
  EventParticipants,
  RecordedPlacement,
} from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import type { DraftConfig } from "@/lib/draft-policy";
import type { FormatView, ScheduleSettings } from "@/lib/format";

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
