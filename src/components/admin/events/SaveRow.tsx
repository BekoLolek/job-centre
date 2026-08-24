"use client";

import { useId, type ReactNode } from "react";
import { Button, Eyebrow, cx } from "@/components/ui";
import { useUnsavedChanges } from "./UnsavedChanges";

/**
 * What a tab ends with: its extra controls, and whatever it has to say.
 *
 * The save button used to live here, at the bottom of a panel you had to
 * scroll to find. It has moved to the bar that appears over the page the
 * moment anything is dirty — see {@link UnsavedChanges} — because a save
 * control that scrolls out of view is one you forget, and forgetting it used
 * to cost the edit silently.
 *
 * So this component now mostly *publishes*: it hands the tab's save state to
 * the bar and renders only the parts that genuinely belong inline, which is
 * the tab's own extra controls and the line confirming what just happened.
 *
 * Every call site kept its props. The one that matters is `disabled`, which
 * now blocks the bar's button rather than a local one, so a tab that cannot
 * be saved says why on the bar instead of leaving a dead button at the bottom
 * of the page.
 */

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type SaveRowProps = {
  state: SaveState;
  /** Blocks saving on top of the state — nothing to save, invalid input. */
  disabled?: boolean;
  onSave: () => void;
  label?: string;
  /** What "Saved" said, when there is something worth saying. */
  note?: ReactNode;
  /** Shown on the bar when `disabled` — why this cannot be saved yet. */
  reason?: ReactNode;
  /** Extra controls, kept inline. */
  children?: ReactNode;
  className?: string;
};

export default function SaveRow({
  state,
  disabled,
  onSave,
  label = "Save changes",
  note,
  reason,
  children,
  className,
}: SaveRowProps) {
  const id = useId();

  useUnsavedChanges(id, {
    dirty: state === "dirty",
    saving: state === "saving",
    blocked: disabled,
    label,
    reason: disabled ? reason : undefined,
    save: onSave,
  });

  // The confirmation and the failure still belong next to the thing they
  // happened to; only the button moved.
  const said =
    state === "saved" ? (
      <Eyebrow as="span" className="text-signal">
        {note ?? "Saved"}
      </Eyebrow>
    ) : state === "error" ? (
      <Eyebrow as="span" className="text-ember">
        Not saved
      </Eyebrow>
    ) : null;

  if (!children && !said) return null;

  return (
    <div className={cx("flex flex-wrap items-center gap-3 pt-2", className)}>
      {children}
      {said && <span className="ml-auto">{said}</span>}
    </div>
  );
}

/**
 * The old inline row, for anywhere outside the editor that has no bar to
 * publish to. Nothing uses it yet; it exists so that adding a save control to
 * a screen without the provider does not mean inventing one.
 */
export function InlineSaveRow({
  state,
  disabled,
  onSave,
  label = "Save",
  note,
  children,
  className,
}: SaveRowProps) {
  return (
    <div
      className={cx("flex flex-wrap items-center gap-3 border-t border-hair pt-4", className)}
    >
      {children}
      <span className="ml-auto flex items-center gap-3">
        {note && state === "saved" && (
          <Eyebrow as="span" className="text-signal">
            {note}
          </Eyebrow>
        )}
        <Button
          variant="gold"
          size="sm"
          disabled={disabled || state === "saving"}
          onClick={onSave}
        >
          {state === "saving" ? "Saving…" : label}
        </Button>
      </span>
    </div>
  );
}
