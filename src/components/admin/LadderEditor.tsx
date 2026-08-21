"use client";

import { useState } from "react";
import { Alert, Badge, Button, EmptyState, Eyebrow, Field, plural } from "@/components/ui";
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
 * Saving is preceded by `previewRankLadder`: removing an entry orphans every
 * answer naming it, and the count is shown before the write.
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
  const [confirmLoss, setConfirmLoss] = useState<{ removed: string[]; answers: number } | null>(
    null
  );

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
        if (impact.answers > 0) {
          setConfirmLoss(impact);
          return;
        }
      }
      const result = await setRankLadderAction(gameId, next);
      if (!result.ok) return setError(result.error);
      setConfirmLoss(null);
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
        {dirty && <Badge tone="gold">Unsaved</Badge>}
      </div>

      {error && <Alert>{error}</Alert>}

      {confirmLoss && (
        <Alert tone="ember">
          <span className="block font-medium">
            {confirmLoss.answers === 1
              ? "1 stored answer names a rank you are removing"
              : `${confirmLoss.answers} stored answers name a rank you are removing`}
          </span>
          <span className="mt-1 block opacity-90">
            Removing {confirmLoss.removed.slice(0, 4).join(", ")}
            {confirmLoss.removed.length > 4 && ` and ${confirmLoss.removed.length - 4} more`}{" "}
            leaves those members with a rank this game no longer has, so those answers are
            cleared and they will be asked again.
          </span>
          <span className="mt-3 flex gap-2">
            <Button size="sm" variant="ember" disabled={busy} onClick={() => void save(true)}>
              Save and clear them
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirmLoss(null)}>
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
        <ol className="divide-y divide-hair/60 rounded-xl border border-hair">
          {draft.map((name, index) => (
            <li key={`${name}-${index}`} className="flex items-center gap-3 px-3 py-2">
              <span className="num w-8 shrink-0 text-xs text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
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
                  variant="ember"
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
          <Button size="sm" variant="gold" disabled={busy} onClick={() => void save(false)}>
            {busy ? "Saving…" : "Save ladder"}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft([...ladder]);
              setError(null);
              setConfirmLoss(null);
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
