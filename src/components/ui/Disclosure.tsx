"use client";

import { useId, useState, type ReactNode } from "react";
import Icon, { type IconName } from "./Icon";
import { cx } from "./cx";

/**
 * A section you can fold away.
 *
 * The format screen is the densest in the editor — several stages, each with a
 * shape, a settings block, a preview, a group table and a bracket — and all of
 * it was open at once. That is a scroll of a thousand pixels to compare two
 * stages that are forty pixels of text apart.
 *
 * Folding is the answer, but it has to be honest about what is inside, because
 * the cost of a closed section is that you forget it exists. So the header
 * always carries a summary: what the section holds when it is shut. A row that
 * says only "Settings" is a row you have to open to learn anything from.
 *
 * Not `<details>`: the summary line has interactive controls in it on some of
 * these, and a `<button>` inside a `<summary>` is a click target inside a click
 * target — the inner one works, then the outer one folds the section under it.
 */

export type DisclosureProps = {
  title: ReactNode;
  /** What is inside, shown whether it is open or shut. Keep it to a phrase. */
  summary?: ReactNode;
  icon?: IconName;
  /** Sits at the right of the header, outside the fold control. */
  aside?: ReactNode;
  defaultOpen?: boolean;
  /** Fold state owned by the caller — for "collapse all". */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A quieter, smaller header, for a section nested inside another. */
  size?: "md" | "sm";
  className?: string;
  children: ReactNode;
};

export default function Disclosure({
  title,
  summary,
  icon,
  aside,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  size = "md",
  className,
  children,
}: DisclosureProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = controlled ?? uncontrolled;
  const id = useId();

  const toggle = () => {
    if (controlled === undefined) setUncontrolled(!open);
    onOpenChange?.(!open);
  };

  return (
    <div className={cx("border-t border-hair first:border-t-0", className)}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          className={cx(
            "group flex min-w-0 flex-1 items-center gap-2.5 text-left transition-colors",
            size === "sm" ? "py-2.5" : "py-3.5"
          )}
        >
          <Chevron open={open} />
          {icon && <Icon name={icon} className="shrink-0 text-dim" />}
          <span
            className={cx(
              "shrink-0 font-medium text-chalk transition-colors group-hover:text-hot",
              size === "sm" ? "text-[13px]" : "text-[14px]"
            )}
          >
            {title}
          </span>
          {summary && (
            <span className="min-w-0 truncate text-[12.5px] text-dim">{summary}</span>
          )}
        </button>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>

      {/*
        Unmounted when shut, not hidden. These sections hold live previews that
        resolve a whole bracket on every render; keeping eight of them mounted
        behind `display: none` is the version of this that gets slow.
      */}
      {open && (
        <div id={id} className={cx(size === "sm" ? "pb-4" : "pb-5")}>
          {children}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden
      className={cx(
        "h-2.5 w-2.5 shrink-0 text-dim transition-transform duration-150",
        open ? "rotate-90" : "rotate-0"
      )}
    >
      <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** A stack of disclosures, ruled between. */
export function DisclosureGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("border-b border-hair", className)}>{children}</div>;
}
