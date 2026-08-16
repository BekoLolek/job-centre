"use client";

import { cx } from "./cx";

/**
 * Use for a small whole number — plus and minus either side of the figure.
 *
 * The field is still there and still typeable, because typing 47 beats tapping
 * plus forty-seven times. But the common case (nudge it by one) is a tap, which
 * is the rule in plan §2. Empty is a real state: clearing the box answers
 * nothing rather than answering zero.
 */

export type StepperProps = {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Rendered after the number — "hours", "packs". */
  suffix?: string;
  className?: string;
  "aria-label"?: string;
};

export default function Stepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  step = 1,
  disabled,
  suffix,
  className,
  "aria-label": ariaLabel,
}: StepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  // Stepping from empty starts at the floor rather than at zero-plus-one, so a
  // field whose minimum is 1 does not need a first tap that lands out of range.
  const nudge = (delta: number) => onChange(clamp((value ?? min) + delta));

  const atFloor = value !== null && value <= min;
  const atCeiling = value !== null && value >= max;

  return (
    <div className={cx("flex w-full max-w-xs items-stretch", className)}>
      <button
        type="button"
        aria-label="Decrease"
        disabled={disabled || atFloor}
        onClick={() => nudge(-step)}
        className="btn w-12 justify-center border-r-0 text-base"
      >
        −
      </button>

      <input
        type="number"
        inputMode="numeric"
        aria-label={ariaLabel}
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") return onChange(null);
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          onChange(clamp(Math.round(parsed)));
        }}
        className="field min-w-0 flex-1 text-center"
      />

      <button
        type="button"
        aria-label="Increase"
        disabled={disabled || atCeiling}
        onClick={() => nudge(step)}
        className="btn w-12 justify-center border-l-0 text-base"
      >
        +
      </button>

      {suffix && (
        <span className="eyebrow ml-3 self-center whitespace-nowrap">{suffix}</span>
      )}
    </div>
  );
}
