/**
 * The draft's shared pieces — everything both the admin's setup screens and the
 * live draft room need to draw.
 *
 * The split from `src/components/ui/` is deliberate: `ui/` knows nothing about
 * this application, whereas everything here knows what a roster slot is and
 * what money looks like on this site. It knows no *rules* though — the numbers
 * come from `src/lib/draft-policy.ts` and nothing here recomputes one.
 */

export { default as BidCeiling } from "./BidCeiling";
export type { BidCeilingProps } from "./BidCeiling";

export { default as Money } from "./MoneyFigure";
export type { MoneyProps, MoneySize, MoneyTone } from "./MoneyFigure";

export { default as PlayerChip } from "./PlayerChip";
export type { PlayerChipProps } from "./PlayerChip";

export { default as RosterList } from "./RosterList";
export type { RosterListProps } from "./RosterList";

export { default as TeamCard } from "./TeamCard";
export type { TeamCardProps } from "./TeamCard";

export { ceilingFor, ceilingsFor } from "./ceiling";
export type { Ceiling } from "./ceiling";

export { formatDelta, formatMoney } from "./money";

export {
  BALANCE_MODES,
  BIDDING_MODES,
  BID_VISIBILITIES,
  EXCLUSION_REASONS,
  LOT_STATUSES,
  POOL_KINDS,
  SELECTION_MODES,
  balanceModeLabel,
  bidVisibilityLabel,
  biddingModeLabel,
  selectionModeLabel,
} from "./labels";
export type { Choice, ExclusionReason } from "./labels";

export {
  completionSentence,
  lotLine,
  lotSentence,
  poolLabel,
  stageLabel,
  teamNameFor,
  undoPlan,
  undoTarget,
} from "./story";
export type { LotContext, LotLine, LotTone, NamedTeam, UndoPlan } from "./story";

export { playerHref, playerName } from "./types";
export type { MemberLike, PlayerBook, PlayerLike, TeamLike } from "./types";
