"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The in-page menu: text on a rule, with the current one underlined.
 *
 * What was here before was a row of pill buttons inside a rounded outline —
 * a box of boxes, and at eleven items in the event editor it wrapped into a
 * grey slab that told you nothing about where you were. Two problems with
 * that shape. A button is a thing you press to make something happen, and
 * changing which panel is showing is not that; and an outline around the whole
 * group makes the group the object you see, when the thing that matters is
 * which single item is current.
 *
 * An underline on a rule is the answer nearly every product has landed on. The
 * rule is a continuous edge the eye reads as one surface, the underline is a
 * mark on it, and there is nothing else drawn at all. It also scales: eleven
 * underlined words scroll sideways happily, where eleven pills do not.
 *
 * Counts sit beside their label in the dim step rather than in brackets. A
 * bracketed number is read as part of the name; a separate figure is read as a
 * quantity, which is what it is. `dot` marks the tabs holding something that
 * needs a decision.
 */

export type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
  /** Shown beside the label, quietly. Zero still shows — "0 applicants" is news. */
  count?: number;
  /** A small red mark, for a tab holding something undecided. */
  dot?: boolean;
  disabled?: boolean;
};

type ItemVisualProps = {
  label: ReactNode;
  count?: number;
  dot?: boolean;
  current: boolean;
  size: "md" | "sm";
};

/** The label, its count and its mark — shared by the button and the link forms. */
function ItemBody({ label, count, dot, current, size }: ItemVisualProps) {
  return (
    <>
      <span className={cx(size === "sm" ? "text-[13px]" : "text-[13.5px]")}>{label}</span>
      {count !== undefined && (
        <span
          className={cx(
            "num text-[12px] tabular-nums transition-colors",
            current ? "text-muted" : "text-dim"
          )}
        >
          {count}
        </span>
      )}
      {dot && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-flare"
          title="Needs a decision"
        />
      )}
    </>
  );
}

const BASE =
  "group relative -mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap " +
  "border-b-2 font-medium transition-colors focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-union focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-ink";

const SIZE = {
  md: "pb-3 pt-1",
  sm: "pb-2.5 pt-0.5",
} as const;

const STATE = {
  current: "border-union text-chalk",
  idle: "border-transparent text-muted hover:border-hair hover:text-chalk",
  disabled: "border-transparent text-dim opacity-50 cursor-not-allowed",
} as const;

export type TabNavProps = {
  /** Wraps the row in its own rule. Turn off when a parent already draws one. */
  rule?: boolean;
  size?: "md" | "sm";
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
};

/** The rail the items sit on. Scrolls sideways rather than wrapping. */
export function TabNav({
  rule = true,
  size = "md",
  className,
  children,
  ...rest
}: TabNavProps) {
  return (
    <div
      role="tablist"
      className={cx(
        "flex items-end overflow-x-auto",
        size === "sm" ? "gap-5" : "gap-6",
        rule && "border-b border-hair",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export type TabsProps<T extends string> = {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Stretch the items to fill the row instead of hugging their labels. */
  fill?: boolean;
  /** Disables every item at once — for when the whole control is locked. */
  disabled?: boolean;
  size?: "md" | "sm";
  /** Turn off when the row sits inside something that already draws a rule. */
  rule?: boolean;
  "aria-label"?: string;
  className?: string;
};

/** The controlled form: which panel is showing is React state. */
export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  fill,
  disabled,
  size = "md",
  rule = true,
  className,
  ...rest
}: TabsProps<T>) {
  return (
    <TabNav rule={rule} size={size} className={className} {...rest}>
      {items.map((item) => {
        const current = value === item.value;
        const off = disabled || item.disabled;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={current}
            className={cx(
              BASE,
              SIZE[size],
              off ? STATE.disabled : current ? STATE.current : STATE.idle,
              fill && "flex-1 justify-center"
            )}
            disabled={off}
            onClick={() => onChange(item.value)}
          >
            <ItemBody
              label={item.label}
              count={item.count}
              dot={item.dot}
              current={current}
              size={size}
            />
          </button>
        );
      })}
    </TabNav>
  );
}

export type TabLinkItem = {
  href: string;
  label: ReactNode;
  count?: number;
  dot?: boolean;
  current: boolean;
};

/**
 * The link form, for filters that belong in the URL.
 *
 * Identical to the eye, deliberately. Whether a filter is client state or a
 * query parameter is an implementation detail, and it would be a strange site
 * where the two looked different.
 */
export function TabLinks({
  items,
  size = "md",
  rule = true,
  className,
  ...rest
}: {
  items: readonly TabLinkItem[];
  size?: "md" | "sm";
  rule?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <TabNav rule={rule} size={size} className={className} {...rest}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.current ? "page" : undefined}
          className={cx(BASE, SIZE[size], item.current ? STATE.current : STATE.idle)}
        >
          <ItemBody
            label={item.label}
            count={item.count}
            dot={item.dot}
            current={item.current}
            size={size}
          />
        </Link>
      ))}
    </TabNav>
  );
}
