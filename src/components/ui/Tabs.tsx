"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";

/** Use for the boxed segmented toggle (Pools/Setup, Main/Reserve). Fully controlled. */

export type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
};

export type TabsProps<T extends string> = {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Stretch the tabs to fill the row (`flex-1`) instead of hugging their labels. */
  fill?: boolean;
  /** Disables every tab at once — for when the whole control is locked. */
  disabled?: boolean;
  className?: string;
};

export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  fill,
  disabled,
  className,
}: TabsProps<T>) {
  return (
    <div className={cx("flex rounded-xl border border-hair", className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={cx(
            "btn",
            fill && "flex-1",
            "border-0",
            value === item.value ? "text-gold bg-gold/10" : "text-muted bg-transparent"
          )}
          disabled={disabled || item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
