import { cx } from "./cx";

/**
 * A small line-drawn icon set.
 *
 * Inline SVG rather than a package: there are a dozen of these, they never
 * change, and a font or a dependency for twelve paths is a lot of weight for a
 * site this size. Every one is drawn on a 24-grid with a 1.5 stroke and no
 * fill, so they sit at the same visual weight as the type beside them instead
 * of shouting over it.
 *
 * They exist to give a section a handle the eye can find when scrolling — with
 * the boxes gone, an icon in the gutter is what tells you a new region started.
 */

export type IconName =
  | "calendar"
  | "people"
  | "trophy"
  | "list"
  | "settings"
  | "shield"
  | "clipboard"
  | "clock"
  | "flag"
  | "coin"
  | "grid"
  | "history"
  | "spark";

const PATHS: Record<IconName, string> = {
  calendar: "M4 7h16M4 7a1 1 0 011-1h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7zM8 3v4m8-4v4",
  people: "M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M12 7a3 3 0 11-6 0 3 3 0 016 0zM17 11a3 3 0 100-6M21 19v-1a4 4 0 00-3-3.87",
  trophy: "M7 4h10v6a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M9 20h6M12 15v5",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.34 1.88l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.88-.34 1.7 1.7 0 00-1 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.56 1.7 1.7 0 00-1.88.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.88 1.7 1.7 0 00-1.56-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.6a1.7 1.7 0 00-.34-1.88l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.88.34H9a1.7 1.7 0 001-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.56 1.7 1.7 0 001.88-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.88V9a1.7 1.7 0 001.56 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z",
  shield: "M12 3l7 3v6c0 4.4-3 8.2-7 9-4-.8-7-4.6-7-9V6l7-3z",
  clipboard: "M9 4h6a1 1 0 011 1v1H8V5a1 1 0 011-1zM8 6H6a1 1 0 00-1 1v13a1 1 0 001 1h12a1 1 0 001-1V7a1 1 0 00-1-1h-2",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  coin: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v10M14.5 9.5c0-1-1.1-1.5-2.5-1.5s-2.5.5-2.5 1.7c0 2.3 5 1.3 5 3.6 0 1.2-1.1 1.7-2.5 1.7s-2.5-.5-2.5-1.5",
  grid: "M4 4h7v7H4V4zM13 4h7v7h-7V4zM4 13h7v7H4v-7zM13 13h7v7h-7v-7z",
  history: "M3 12a9 9 0 109-9 9 9 0 00-6.36 2.64L3 8M3 4v4h4M12 8v4l3 2",
  spark: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z",
};

export type IconProps = {
  name: IconName;
  className?: string;
  /** Decorative by default; pass a label when the icon is the only content. */
  label?: string;
};

export default function Icon({ name, className, label }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("h-[18px] w-[18px] shrink-0", className)}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
