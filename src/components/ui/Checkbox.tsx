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
 *
 * **The hit area is 44x44, and the drawn box is still 16x16.** The Constraints
 * in `docs/requirements.md` ("usable on a phone at ~400px") apply to every
 * control, and the switches R-104 asks for — UC-25 6, `/me/notifications` —
 * are a whole column of these. 16px is a third of the touch floor, so
 * both branches return a `<label>` sized to 44px — `h-11 w-11` around a bare
 * box, `min-h-11 min-w-11` around the box-and-words pair — and a click
 * anywhere in it reaches the nested input. `11` is Tailwind's own step
 * (2.75rem), and `globals.css` sets its 15px on `body` rather than on the
 * root, so a rem is the browser's 16px and 2.75rem is 44px on the nose.
 *
 * The padding-on-the-input alternative was rejected on the third criterion:
 * the focus ring is drawn on the input's border box, so padding it out to 44px
 * would take the ring with it and turn a tight 16px outline into a box nearly
 * three times the size. Wrapping leaves the input — and therefore the ring,
 * the tick, and the space bar — untouched.
 */

export type CheckboxProps = {
  checked: boolean;
  /** The new state rather than the event, the same shape as Toggle's. */
  onChange: (checked: boolean) => void;
  /** The words beside the box. Omitted, the bare `<input>` is returned. */
  label?: ReactNode;
  disabled?: boolean;
  /**
   * Extra classes for the `<label>` this returns, labelled or not — spacing
   * and placement, not the box. One hook rather than two, and it lands on the
   * same node either way now that the bare branch has a wrapper of its own.
   * Nothing reaches the `<input>`: its size, its accent and its ring are the
   * component's, and a call site that could resize the box could put it back
   * under the touch floor from the outside.
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
        "disabled:cursor-not-allowed"
      )}
      {...rest}
    />
  );

  /*
   * A bare box still gets a label, it just has nothing to say. 44x44 exactly,
   * `inline-flex` rather than `flex` so the `text-center` of the table cell it
   * usually sits in still centres it — a block-level 44px box would pin itself
   * to the left of the column instead, which is the one layout this would
   * otherwise break. It fits: `/me/notifications` gives the switch columns
   * 4.5rem (72px) and `TableCell` spends `px-3` (24px) of it, leaving 48px.
   */
  if (label === undefined) {
    return (
      <label
        className={cx(
          "inline-flex h-11 w-11 items-center justify-center",
          !disabled && "cursor-pointer",
          className
        )}
      >
        {box}
      </label>
    );
  }

  /*
   * With words beside it the row is already wide enough to tap; it is the
   * height that falls short, because 13px type on a 20px line box is 20px
   * tall. `min-h-11` floors it at 44 and `items-center` keeps the box level
   * with the words inside that taller box. `min-w-11` is the floor for the
   * width nothing else guarantees — a one-word label at 13px clears it, but
   * "Yes" is not a promise, and 16px of box plus an 8px gap is only 24.
   */
  return (
    <label
      className={cx(
        "flex min-h-11 min-w-11 items-center gap-2",
        !disabled && "cursor-pointer",
        className
      )}
    >
      {box}
      <span className="text-13 text-body">{label}</span>
    </label>
  );
}
