"use client";

import type { ReactNode } from "react";
import { Button, Eyebrow, cx } from "@/components/ui";

/**
 * The save control every tab ends with, and the line that says what happened.
 *
 * §6.3's editor saves each tab independently, which only works if each tab can
 * say for itself whether it is saved — one page-wide "Saved" would be a lie the
 * moment two tabs disagree. So the state is per tab and it lives here.
 */

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type SaveRowProps = {
  state: SaveState;
  /** Disables the button on top of the state — nothing to save, invalid input. */
  disabled?: boolean;
  onSave: () => void;
  label?: string;
  /** What "Saved" said, when there is something worth saying. */
  note?: ReactNode;
  /** Extra controls to the left of the button. */
  children?: ReactNode;
  className?: string;
};

export default function SaveRow({
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
      className={cx(
        "flex flex-wrap items-center gap-3 border-t border-hair pt-4",
        className
      )}
    >
      {children}

      <span className="ml-auto flex items-center gap-3">
        {note && state === "saved" && (
          <Eyebrow as="span" className="text-signal">
            {note}
          </Eyebrow>
        )}
        <SaveIndicator state={state} hasNote={Boolean(note)} />
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

function SaveIndicator({ state, hasNote }: { state: SaveState; hasNote: boolean }) {
  if (state === "saving") {
    return (
      <Eyebrow as="span" className="animate-pulse text-gold">
        Saving…
      </Eyebrow>
    );
  }
  if (state === "saved" && !hasNote) {
    return (
      <Eyebrow as="span" className="text-signal">
        ✓ Saved
      </Eyebrow>
    );
  }
  if (state === "error") {
    return (
      <Eyebrow as="span" className="text-ember">
        Not saved
      </Eyebrow>
    );
  }
  if (state === "dirty") {
    return (
      <Eyebrow as="span" className="text-muted">
        Unsaved changes
      </Eyebrow>
    );
  }
  return null;
}
