"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Use for a setting that is on or off — one box, two states, a default.
 *
 * Not the same thing as Toggle, which answers a *question* and has a third
 * state for "nobody has said yet". A setting always has a value, so this is the
 * native `<input type="checkbox">` rather than a pair of chips: the browser
 * already gives it the tick, the space-bar, the label association and the
 * disabled rendering, and none of that is worth reimplementing. What the native
 * control does not give is a focus ring in the site's blue, so that is here.
 *
 * Pass `label` for the usual box-and-words pair, which wraps both in a
 * `<label>` so the words are part of the hit target. Leave it out for a bare
 * box in a grid cell that is titled by its column, and pass `aria-label`.
 */

export type CheckboxProps = {
  checked: boolean;
  /** The new state rather than the event, the same shape as Toggle's. */
  onChange: (checked: boolean) => void;
  /** The words beside the box. Omitted, the bare `<input>` is returned. */
  label?: ReactNode;
  disabled?: boolean;
  /**
   * Extra classes for whichever node this returns — the `<label>` when there
   * is a label, the `<input>` when there is not. One hook rather than two,
   * because a second one would be silently dropped by the bare-input branch.
   */
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  // `defaultChecked` alongside `checked` is React's controlled/uncontrolled
  // warning, which the type system would not catch; `readOnly` does nothing to
  // a checkbox and reads as a guard it is not. `disabled` is the guard.
  "className" | "children" | "type" | "checked" | "onChange" | "defaultChecked" | "readOnly"
>;

export default function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
  ...rest
}: CheckboxProps) {
  const box = (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(input) => onChange(input.target.checked)}
      className={cx(
        "h-4 w-4 shrink-0 accent-union",
        // The kit's ring, in place of whatever the platform draws. No offset:
        // the box is 16px and a ring standing off it reads as a second box.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-union",
        // No opacity here — a disabled checkbox is already dimmed by the
        // browser, and dimming it twice takes it below the contrast floor.
        "disabled:cursor-not-allowed",
        label === undefined && className
      )}
      {...rest}
    />
  );

  if (label === undefined) return box;

  return (
    <label
      className={cx("flex items-center gap-2", !disabled && "cursor-pointer", className)}
    >
      {box}
      <span className="text-13 text-body">{label}</span>
    </label>
  );
}
