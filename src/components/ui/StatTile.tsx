import type { ReactNode } from "react";
import { cx } from "./cx";
import Eyebrow from "./Eyebrow";

/** Use for an eyebrow-over-big-number readout — podium places, totals, headline figures. */

export type StatTileProps = {
  label: ReactNode;
  value: ReactNode;
  /** Tone/size overrides for the value line, e.g. `text-gold` or `text-muted`. */
  valueClassName?: string;
  className?: string;
};

export default function StatTile({ label, value, valueClassName, className }: StatTileProps) {
  return (
    <div className={className}>
      <Eyebrow className="mb-1">{label}</Eyebrow>
      <div className={cx("font-display text-2xl leading-tight", valueClassName)}>{value}</div>
    </div>
  );
}
