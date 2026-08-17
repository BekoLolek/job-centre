/**
 * The words for §9's settings — one wording, admin screen and draft room alike.
 *
 * Each option carries a `label` and a `hint`, and the hint says what the option
 * *does* rather than restating its name. "Sealed — one bid each, nobody sees
 * the others" is a rule somebody can choose between; "Sealed bidding" is a
 * label they have to already understand.
 */

import type {
  DraftBalanceMode,
  DraftBidVisibility,
  DraftBiddingMode,
  DraftLotStatus,
  DraftPoolKind,
  DraftSelectionMode,
} from "@/db/schema";

export type Choice<T extends string> = {
  value: T;
  label: string;
  hint: string;
};

export const BALANCE_MODES: ReadonlyArray<Choice<DraftBalanceMode>> = [
  {
    value: "uniform",
    label: "Uniform",
    hint: "Every team starts on the same money.",
  },
  {
    value: "per_team",
    label: "Per team",
    hint: "Set each team's starting balance yourself — §9's handicapping.",
  },
];

export const BIDDING_MODES: ReadonlyArray<Choice<DraftBiddingMode>> = [
  {
    value: "sealed",
    label: "Sealed",
    hint: "One bid each, nobody sees the others until the lot settles.",
  },
  {
    value: "open",
    label: "Open",
    hint: "Captains raise each other, each raise at least the increment above the last.",
  },
];

export const SELECTION_MODES: ReadonlyArray<Choice<DraftSelectionMode>> = [
  {
    value: "wheel",
    label: "Wheel",
    hint: "Spin for the next player, as the board does today.",
  },
  {
    value: "admin_pick",
    label: "Admin picks",
    hint: "You name who goes up next. No wheel.",
  },
  {
    value: "fixed_order",
    label: "Fixed order",
    hint: "Straight down the pool in the order it was seeded.",
  },
];

export const BID_VISIBILITIES: ReadonlyArray<Choice<DraftBidVisibility>> = [
  {
    value: "admin_only",
    label: "Admin only",
    hint: "Today's board: you see every amount, a captain sees only their own.",
  },
  {
    value: "captains",
    label: "Captains",
    hint: "Every captain sees every live amount. Open bidding needs at least this.",
  },
  {
    value: "everyone",
    label: "Everyone",
    hint: "The whole room watches the amounts go in.",
  },
];

export const POOL_KINDS: Record<DraftPoolKind, string> = {
  main: "Main pool",
  reserve: "Reserve pool",
};

export const LOT_STATUSES: Record<DraftLotStatus, string> = {
  open: "On the block",
  awarded: "Sold",
  discarded: "Undrafted",
  reserved: "Held over",
  voided: "Undone",
};

function labelOf<T extends string>(choices: ReadonlyArray<Choice<T>>, value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

export const balanceModeLabel = (value: DraftBalanceMode) => labelOf(BALANCE_MODES, value);
export const biddingModeLabel = (value: DraftBiddingMode) => labelOf(BIDDING_MODES, value);
export const selectionModeLabel = (value: DraftSelectionMode) =>
  labelOf(SELECTION_MODES, value);
export const bidVisibilityLabel = (value: DraftBidVisibility) =>
  labelOf(BID_VISIBILITIES, value);

/**
 * Why somebody accepted into the event is not in the draft pool.
 *
 * The two reasons are not equivalent and the screen must not merge them: a
 * captain is *deliberately* out of the pool and always will be (§14), whereas
 * anyone else outside it is an oversight waiting to be noticed.
 */
export type ExclusionReason = "captain" | "drafted" | "not_accepted" | "discarded";

export const EXCLUSION_REASONS: Record<ExclusionReason, string> = {
  captain: "Captains a team — never enters the pool",
  drafted: "Already on a roster",
  not_accepted: "Not accepted into the event",
  discarded: "Went through the draft undrafted",
};
