"use client";

import ChoiceChip, { ChoiceRow } from "./ChoiceChip";
import { cx } from "./cx";

/**
 * Use for a yes/no answer — two chips, not a switch.
 *
 * A sliding switch has only two states, which means "no" and "never asked" look
 * identical, and a profile is full of questions nobody has reached yet. Two
 * chips make the unanswered state visible: neither is lit. Tapping the lit one
 * clears the answer again.
 */

export type ToggleProps = {
  /** `null` means unanswered, and renders with neither side lit. */
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  yesLabel?: string;
  noLabel?: string;
  disabled?: boolean;
  className?: string;
};

export default function Toggle({
  value,
  onChange,
  yesLabel = "Yes",
  noLabel = "No",
  disabled,
  className,
}: ToggleProps) {
  const pick = (next: boolean) => onChange(value === next ? null : next);

  return (
    <ChoiceRow className={cx("max-w-xs", className)}>
      <ChoiceChip block selected={value === true} disabled={disabled} onClick={() => pick(true)}>
        {yesLabel}
      </ChoiceChip>
      <ChoiceChip block selected={value === false} disabled={disabled} onClick={() => pick(false)}>
        {noLabel}
      </ChoiceChip>
    </ChoiceRow>
  );
}
