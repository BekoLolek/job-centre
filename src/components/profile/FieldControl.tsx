"use client";

import {
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Field,
  Stepper,
  Toggle,
} from "@/components/ui";
import RankPicker from "./RankPicker";
import type { ProfileValue } from "@/db/schema";
import type { ProfileFieldView } from "@/lib/profile";
import { NUMBER_MAX, NUMBER_MIN, TEXT_MAX_LENGTH } from "@/lib/profile-fields";

/**
 * One question, rendered as whatever taps least.
 *
 * The mapping is plan §2's rule made literal: `select` is a row of pills rather
 * than a native dropdown, `multiselect` is toggle chips, `rank` is the two-tap
 * tier picker, `bool` is a two-state toggle, `number` is a stepper with the
 * field still there for big jumps — and `text` is a plain input that is
 * deliberately the plainest thing on the page, because it is the exception.
 *
 * `debounce` tells the section how urgently to save: a tap is a decision and
 * saves at once, a keystroke is not and waits for the typing to stop.
 */

export type FieldControlProps = {
  field: ProfileFieldView;
  value: ProfileValue;
  disabled?: boolean;
  onChange: (value: ProfileValue, options?: { debounce?: boolean }) => void;
  /** Called when a typed control loses focus, so a pending save can go early. */
  onCommit?: () => void;
};

export default function FieldControl({
  field,
  value,
  disabled,
  onChange,
  onCommit,
}: FieldControlProps) {
  switch (field.type) {
    case "select": {
      if (field.choices.length === 0) {
        return <EmptyState size="sm">No options yet — an admin has to add some.</EmptyState>;
      }
      const current = typeof value === "string" ? value : null;
      return (
        <ChoiceRow>
          {field.choices.map((choice) => (
            <ChoiceChip
              key={choice.value}
              selected={choice.value === current}
              disabled={disabled}
              // Tapping the lit chip clears the answer. Without this there is no
              // way back to "not said" once anything has been tapped.
              onClick={() => onChange(choice.value === current ? null : choice.value)}
            >
              {choice.label}
            </ChoiceChip>
          ))}
        </ChoiceRow>
      );
    }

    case "multiselect": {
      if (field.choices.length === 0) {
        return <EmptyState size="sm">No options yet — an admin has to add some.</EmptyState>;
      }
      const chosen = Array.isArray(value) ? value : [];
      return (
        <ChoiceRow>
          {field.choices.map((choice) => {
            const on = chosen.includes(choice.value);
            return (
              <ChoiceChip
                key={choice.value}
                selected={on}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    on
                      ? chosen.filter((entry) => entry !== choice.value)
                      : [...chosen, choice.value]
                  )
                }
              >
                {choice.label}
              </ChoiceChip>
            );
          })}
        </ChoiceRow>
      );
    }

    case "rank":
      return (
        <RankPicker
          ladder={field.choices.map((choice) => choice.value)}
          value={typeof value === "string" ? value : null}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
      );

    case "bool":
      return (
        <Toggle
          value={typeof value === "boolean" ? value : null}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
      );

    case "number":
      return (
        <Stepper
          value={typeof value === "number" ? value : null}
          min={NUMBER_MIN}
          max={NUMBER_MAX}
          disabled={disabled}
          aria-label={field.label}
          onChange={(next) => onChange(next, { debounce: true })}
        />
      );

    case "text":
      return (
        <Field
          value={typeof value === "string" ? value : ""}
          maxLength={TEXT_MAX_LENGTH}
          disabled={disabled}
          placeholder="Type it in"
          aria-label={field.label}
          className="max-w-sm"
          onChange={(event) => onChange(event.target.value, { debounce: true })}
          onBlur={onCommit}
        />
      );
  }
}
