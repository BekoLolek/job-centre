"use client";

import { useState } from "react";
import { Alert, Badge, Button, EmptyState, Eyebrow, Field, plural } from "@/components/ui";
import type { LadderImpact } from "@/lib/admin-games";
import { normaliseRankLadder, reorder } from "@/lib/profile-fields";
import { previewRankLadderAction, setRankLadderAction } from "@/app/admin/games/actions";

/**
 * A game's rank ladder — an ordered list, lowest first.
 *
 * The order *is* the data (plan §8.3): "is this player above Platinum III" is an
 * index comparison, so the arrows here are not cosmetic. Edits are held locally
 * until Save, because a ladder is normally rearranged in several moves and
 * writing after each one would orphan answers halfway through a rethink.
 *
 * **An empty ladder is a correct answer.** Jackbox has no ranks and never will,
 * so nothing here insists on entries, and a game with an empty ladder simply
 * cannot have a rank question.
 *
 * Saving is preceded by `previewRankLadder`, which answers two questions the
 * admin cannot see from this list:
 *
 *  - **What does it cost in answers?** Removing an entry orphans every answer
 *    naming it, and the count is shown before the write.
 *  - **What does it do to the events?** (UC-03 3b, R-10.) An event's entry
 *    rule is stored as a rank *name*, so moving that name up or down this list
 *    re-aims the rule — the same stored "Platinum I or above" lets a different
 *    set of people in. A pure reorder costs no answers at all and is the case
 *    where that is easiest to miss, so the affected events are named here,
 *    before saving, rather than discovered by somebody who was refused entry.
 */

export type LadderEditorProps = {
  gameId: string;
  gameName: string;
  ladder: readonly string[];
  onChanged: () => void;
};

export default function LadderEditor({
  gameId,
  gameName,
  ladder,
  onChanged,
}: LadderEditorProps) {
  const [draft, setDraft] = useState<string[]>([...ladder]);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<LadderImpact | null>(null);

  const dirty =
    draft.length !== ladder.length || draft.some((name, index) => name !== ladder[index]);

  const add = () => {
    const name = entry.trim();
    if (!name) return;
    if (draft.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      setError(`"${name}" is already in the ladder.`);
      return;
    }
    setError(null);
    setDraft([...draft, name]);
    setEntry("");
  };

  const save = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = normaliseRankLadder(draft);
      if (!force) {
        const impact = await previewRankLadderAction(gameId, next);
        // Either cost is enough to stop and say so. Events without answers is
        // exactly the reorder case, which is the one worth catching.
        if (impact.answers > 0 || impact.events.length > 0) {
          setConfirm(impact);
          return;
        }
      }
      const result = await setRankLadderAction(gameId, next);
      if (!result.ok) return setError(result.error);
      setConfirm(null);
      onChanged();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Eyebrow>Rank ladder — lowest first</Eyebrow>
        <Badge>{plural(draft.length, "entry", "entries")}</Badge>
        {dirty && <Badge tone="union">Unsaved</Badge>}
      </div>

      {error && <Alert>{error}</Alert>}

      {confirm && (
        <Alert tone="flare">
          <span className="block font-medium">Before you save this ladder</span>

          {confirm.answers > 0 && (
            <span className="mt-2 block opacity-90">
              {confirm.answers === 1
                ? "1 stored answer names a rank you are removing"
                : `${confirm.answers} stored answers name a rank you are removing`}
              . Removing {confirm.removed.slice(0, 4).join(", ")}
              {confirm.removed.length > 4 && ` and ${confirm.removed.length - 4} more`} leaves
              those members with a rank this game no longer has, so those answers are cleared
              and they will be asked again.
            </span>
          )}

          {confirm.events.length > 0 && (
            <span className="mt-2 block opacity-90">
              <span className="block">
                {plural(confirm.events.length, "event")} with a rank rule on {gameName}{" "}
                {confirm.events.length === 1 ? "means" : "mean"} something different after
                this. The rule stays as written; where it sits on the ladder does not.
              </span>
              <ul className="mt-2 space-y-1">
                {confirm.events.map((event) => (
                  <li key={event.id}>
                    <span className="font-medium">{event.title}</span>
                    {" — "}
                    {event.rules
                      .map((rule) => (rule === "enter" ? "entry" : "captain"))
                      .join(" and ")}{" "}
                    at {event.ranks.join(", ")}
                    {event.ranksGone && ", which this ladder no longer has"}
                  </li>
                ))}
              </ul>
            </span>
          )}

          <span className="mt-3 flex gap-2">
            <Button size="sm" variant="flare" disabled={busy} onClick={() => void save(true)}>
              {confirm.answers > 0 ? "Save and clear them" : "Save the new order"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </span>
        </Alert>
      )}

      {draft.length === 0 ? (
        <EmptyState size="sm">
          No ranks — which is correct for {gameName} if it has none. A game with an empty
          ladder simply cannot be asked a rank question.
        </EmptyState>
      ) : (
        <ol className="divide-y divide-hair/60 rounded-lg border border-hair">
          {draft.map((name, index) => (
            <li key={`${name}-${index}`} className="flex items-center gap-3 px-3 py-2">
              <span className="num w-8 shrink-0 text-12 text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-14">{name}</span>
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  aria-label={`Move ${name} down the ladder`}
                  disabled={busy || index === 0}
                  onClick={() => setDraft(reorder(draft, index, "up"))}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  aria-label={`Move ${name} up the ladder`}
                  disabled={busy || index === draft.length - 1}
                  onClick={() => setDraft(reorder(draft, index, "down"))}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="flare"
                  aria-label={`Remove ${name}`}
                  disabled={busy}
                  onClick={() => setDraft(draft.filter((_, at) => at !== index))}
                >
                  ✕
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Add a rank"
          hint="Goes on the top of the ladder — move it down from there."
          value={entry}
          maxLength={60}
          wrapperClassName="flex-1 min-w-[12rem]"
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" disabled={busy || !entry.trim()} onClick={add}>
          Add
        </Button>
      </div>

      {dirty && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-3">
          <Button size="sm" variant="union" disabled={busy} onClick={() => void save(false)}>
            {busy ? "Saving…" : "Save ladder"}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft([...ladder]);
              setError(null);
              setConfirm(null);
            }}
          >
            Revert
          </Button>
          <span className="eyebrow">Nothing is written until you save.</span>
        </div>
      )}
    </div>
  );
}
