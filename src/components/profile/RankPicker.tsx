"use client";

import { useMemo, useState } from "react";
import { ChoiceChip, ChoiceRow, Eyebrow } from "@/components/ui";
import { groupRankLadder } from "@/lib/profile-fields";

/**
 * Picking a rank in one or two taps.
 *
 * Marvel Rivals' ladder is 23 entries long. Rendered flat that is a wall of
 * chips or, worse, a scrolling dropdown — and plan §2's whole complaint about
 * the Google Form was friction exactly like that. So it is split the way
 * players say it out loud: **tier first, then division**. Diamond, then II.
 *
 * Highest first, because the people who care about their rank are near the top
 * and the ladder is stored lowest-first for comparison purposes (§8.3), not for
 * display. Tiers with no divisions — Eternity, One Above All — are a single tap:
 * there is no second row to show.
 *
 * Works with any ladder, including a two-entry one an admin invents this
 * afternoon, because the grouping is derived from the strings rather than from
 * a table of known tiers.
 */

export type RankPickerProps = {
  /** The game's ladder, lowest first, exactly as stored. */
  ladder: readonly string[];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
};

export default function RankPicker({ ladder, value, onChange, disabled }: RankPickerProps) {
  const tiers = useMemo(() => groupRankLadder(ladder), [ladder]);
  // Highest first for display; the underlying indexes are untouched.
  const shown = useMemo(() => [...tiers].reverse(), [tiers]);

  const tierOfValue = useMemo(
    () => tiers.find((tier) => tier.entries.some((entry) => entry.name === value))?.tier ?? null,
    [tiers, value]
  );

  // Which tier's divisions are on screen. Follows the answer, but can be moved
  // without changing the answer — opening Diamond to look does not clear Gold I.
  const [openTier, setOpenTier] = useState<string | null>(null);
  const activeTier = openTier ?? tierOfValue;
  const divisions = shown.find((tier) => tier.tier === activeTier);

  if (tiers.length === 0) {
    return (
      <p className="text-sm text-muted">
        This game has no rank ladder yet, so there is nothing to pick. An admin can add
        one under Admin → Games.
      </p>
    );
  }

  const pickTier = (tier: string) => {
    const group = tiers.find((entry) => entry.tier === tier);
    if (!group) return;
    // A tier with a single entry is the answer — no second tap to make.
    if (group.entries.length === 1) {
      const only = group.entries[0].name;
      setOpenTier(null);
      onChange(value === only ? null : only);
      return;
    }
    setOpenTier(tier === activeTier ? null : tier);
  };

  return (
    <div className="space-y-3">
      <ChoiceRow>
        {shown.map((tier) => {
          const holdsAnswer = tier.tier === tierOfValue;
          return (
            <ChoiceChip
              key={tier.tier}
              selected={holdsAnswer}
              tone={holdsAnswer ? "gold" : "default"}
              disabled={disabled}
              className={
                !holdsAnswer && tier.tier === activeTier ? "border-gold/50 text-gold" : undefined
              }
              onClick={() => pickTier(tier.tier)}
            >
              {tier.tier}
              {holdsAnswer && tier.entries.length > 1 && (
                <span className="ml-1.5 font-mono text-xs">
                  {tier.entries.find((entry) => entry.name === value)?.division}
                </span>
              )}
            </ChoiceChip>
          );
        })}
      </ChoiceRow>

      {divisions && divisions.entries.length > 1 && (
        <div className="border-l-2 border-gold/30 pl-3">
          <Eyebrow className="mb-2">{divisions.tier} — which one?</Eyebrow>
          <ChoiceRow>
            {[...divisions.entries].reverse().map((entry) => (
              <ChoiceChip
                key={entry.name}
                selected={entry.name === value}
                disabled={disabled}
                onClick={() => {
                  onChange(entry.name === value ? null : entry.name);
                  setOpenTier(null);
                }}
              >
                {entry.division ?? entry.name}
              </ChoiceChip>
            ))}
          </ChoiceRow>
        </div>
      )}
    </div>
  );
}
