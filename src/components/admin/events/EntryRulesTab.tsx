"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, ChoiceChip, ChoiceRow, Eyebrow, Panel } from "@/components/ui";
import RankPicker from "@/components/profile/RankPicker";
import type { EventDetail } from "@/lib/events";
import { rankMeetsMinimum } from "@/lib/events-policy";
import { saveEntryRulesAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Entry rules — §8.3's two optional rank thresholds.
 *
 * Both are pickers over the selected game's ladder rather than text boxes, for
 * the reason §8.3 gives: eligibility is a comparison of two *positions* in an
 * ordered list, which only works while both ends are ladder entries. A typed
 * "plat 3" is a string that matches nothing.
 *
 * ## What the screen has to be honest about
 *
 * These are **guidance, not a wall.** `setApplicationStatus` is deliberately
 * ungated — an admin can accept the Gold player filling in for a mate — and the
 * applicants table shows who is below the bar rather than hiding them. A screen
 * that implied otherwise would be describing a system that does not exist.
 *
 * When the event has no game, or its game has no ladder, there is nothing to
 * compare and the tab says so instead of rendering two empty pickers. That is
 * also what the server does: `updateEvent` refuses a threshold in either case.
 */

export default function EntryRulesTab({ event }: { event: EventDetail }) {
  const router = useRouter();

  const [enter, setEnter] = useState<string | null>(event.minRankToEnter);
  const [captain, setCaptain] = useState<string | null>(event.minRankToCaptain);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const ladder = event.rankLadder;

  const touch = () => {
    setState("dirty");
    setError(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveEntryRulesAction(event.id, {
        minRankToEnter: enter,
        minRankToCaptain: captain,
      });
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  /* --- Nothing to compare against --------------------------------- */

  if (!event.game) {
    return (
      <Panel as="section" padding="none" className="space-y-3 border-t border-hair/70 pt-8 first:border-t-0 first:pt-0">
        <Eyebrow>Entry rules</Eyebrow>
        <Alert tone="gold">This event has no game, so there is no rank ladder to gate on.</Alert>
        <p className="text-sm leading-relaxed text-muted">
          Pick a game on the Basics tab and its ladder appears here. An event without one —
          a movie night, a Jackbox evening — takes everybody, which is usually the point.
        </p>
      </Panel>
    );
  }

  if (ladder.length === 0) {
    return (
      <Panel as="section" padding="none" className="space-y-3 border-t border-hair/70 pt-8 first:border-t-0 first:pt-0">
        <Eyebrow>Entry rules</Eyebrow>
        <Alert tone="gold">{event.game.name} has no rank ladder, so there is nothing to compare.</Alert>
        <p className="text-sm leading-relaxed text-muted">
          Ladders are per game and live under Admin → Games. Plenty of games never get one —
          Jackbox has no ranks and never will — and an event on such a game simply has no
          entry threshold.
        </p>
      </Panel>
    );
  }

  /* --- The pickers ------------------------------------------------- */

  // A threshold naming a rank the ladder no longer holds is not enforced, and
  // the admin is the only person who can fix it. Say so where they will see it.
  const enterCheck = rankMeetsMinimum(null, enter, ladder);
  const captainCheck = rankMeetsMinimum(null, captain, ladder);

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Panel as="section" padding="none" className="space-y-6 border-t border-hair/70 pt-8 first:border-t-0 first:pt-0">
        <div>
          <Eyebrow className="mb-2">Entry rules</Eyebrow>
          <p className="text-sm leading-relaxed text-muted">
            Two optional thresholds, read against{" "}
            <span className="text-chalk/80">{event.game.name}</span>&apos;s{" "}
            {ladder.length}-rank ladder. They are{" "}
            <span className="text-gold">guidance, not a wall</span>: the application form
            tells somebody they are below the bar before they waste their time, and you can
            still accept them anyway from the Applicants tab.
          </p>
        </div>

        <Threshold
          title="Minimum rank to enter"
          hint="Below this, the form says so before they apply. You can still let them in."
          ladder={ladder}
          value={enter}
          unknown={enterCheck.reason === "minimum_unknown" ? enter : null}
          onChange={(next) => {
            setEnter(next);
            touch();
          }}
        />

        <Threshold
          title="Minimum rank to captain"
          hint="Used by the captain picker in Phase 3. Captaincy implies entry, so somebody below the entry bar cannot captain either."
          ladder={ladder}
          value={captain}
          unknown={captainCheck.reason === "minimum_unknown" ? captain : null}
          onChange={(next) => {
            setCaptain(next);
            touch();
          }}
        />

        <SaveRow state={state} onSave={() => void save()} label="Save entry rules" />
      </Panel>

      <Panel as="section" padding="none" className="space-y-2 border-t border-hair/70 pt-8 first:border-t-0 first:pt-0">
        <Eyebrow>How a member&apos;s rank is read</Eyebrow>
        <p className="text-sm leading-relaxed text-muted">
          From their profile — the `rank` question on {event.game.name}, which is a picker
          over this same ladder. Somebody who has never answered it does not clear a
          threshold, and the form tells them to add it rather than silently refusing. A
          member whose stored rank was removed from the ladder is asked to pick it again,
          because a stored rank is a claim made on some past date (§8.3).
        </p>
      </Panel>
    </div>
  );
}

function Threshold({
  title,
  hint,
  ladder,
  value,
  unknown,
  onChange,
}: {
  title: string;
  hint: string;
  ladder: readonly string[];
  value: string | null;
  unknown: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="space-y-3 border-t border-hair pt-5 first:border-0 first:pt-0">
      <div>
        <Eyebrow className="mb-1 text-chalk/70">{title}</Eyebrow>
        <p className="text-xs leading-relaxed text-muted">{hint}</p>
      </div>

      <ChoiceRow>
        <ChoiceChip selected={value === null} onClick={() => onChange(null)}>
          No minimum
        </ChoiceChip>
        {value !== null && (
          <span className="eyebrow self-center text-gold">{value} or above</span>
        )}
      </ChoiceRow>

      {unknown && (
        <Alert tone="ember">
          “{unknown}” is not in this ladder any more, so it is not being enforced — everybody
          clears it. Pick a current rank, or clear it.
        </Alert>
      )}

      <RankPicker ladder={ladder} value={value} onChange={onChange} />
    </div>
  );
}
