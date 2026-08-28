"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Field, cx, plural } from "@/components/ui";
import type { SuggestionStatus } from "@/db/schema";
import type { Suggestion, SuggestionVote } from "@/lib/suggestions";
import {
  addSuggestionAction,
  deleteSuggestionAction,
  setSuggestionStatusAction,
  voteSuggestionAction,
} from "@/app/suggestions/actions";

/**
 * "Somebody should run one of these", and how many people agree.
 *
 * The number is the feature. Everything else on the row is arranged around
 * keeping it readable: the score sits left at the size of a heading, the two
 * arrows are next to it rather than buried in a menu, and the title comes
 * after, because you scan this list by how much people want things and only
 * then read what they are.
 *
 * ## Why votes do not re-render the page
 *
 * The list is sorted by score. Re-fetching after every vote would re-sort it
 * under the cursor, so the row you just voted on jumps somewhere else and the
 * next click lands on a different suggestion. The action returns the new tally
 * and only that row updates; the order settles on the next real page load.
 */

export default function SuggestionBox({
  initial,
  signedIn,
  isAdmin,
  viewerId,
}: {
  initial: Suggestion[];
  signedIn: boolean;
  isAdmin: boolean;
  viewerId: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [title, setTitle] = useState("");
  const [gameName, setGameName] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await addSuggestionAction({ title, detail, gameName });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTitle("");
      setGameName("");
      setDetail("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const vote = async (id: string, value: 1 | -1) => {
    setError(null);
    // Optimistic, because a vote button that waits half a second for a round
    // trip feels broken and gets clicked again.
    const before = rows;
    setRows((current) =>
      current.map((row) => (row.id === id ? applyVote(row, value) : row))
    );
    try {
      const result = await voteSuggestionAction(id, value);
      if (!result.ok) {
        setRows(before);
        setError(result.error);
        return;
      }
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...result.data, score: result.data.up - result.data.down } : row))
      );
    } catch {
      setRows(before);
      setError("Could not reach the server.");
    }
  };

  const remove = async (id: string) => {
    const before = rows;
    setRows((current) => current.filter((row) => row.id !== id));
    const result = await deleteSuggestionAction(id);
    if (!result.ok) {
      setRows(before);
      setError(result.error);
    }
  };

  const mark = async (id: string, status: SuggestionStatus) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, status } : row)));
    await setSuggestionStatusAction(id, status);
  };

  return (
    <div className="space-y-8">
      {error && <Alert>{error}</Alert>}

      {/* --- Add one -------------------------------------------------- */}
      {signedIn ? (
        <div className="space-y-3 rounded-xl bg-panel px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="What should we run?"
              placeholder="A REPO night"
              value={title}
              maxLength={120}
              wrapperClassName="min-w-[16rem] flex-[2]"
              onChange={(input) => setTitle(input.target.value)}
            />
            <Field
              label="Game"
              placeholder="Optional"
              value={gameName}
              maxLength={80}
              wrapperClassName="min-w-[10rem] flex-1"
              onChange={(input) => setGameName(input.target.value)}
            />
          </div>
          <Field
            label="Anything else"
            placeholder="Optional — how it would work, why it would be good"
            value={detail}
            maxLength={1000}
            onChange={(input) => setDetail(input.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="gold"
              disabled={busy || title.trim().length < 3}
              onClick={() => void add()}
            >
              {busy ? "Adding…" : "Suggest it"}
            </Button>
            <span className="text-[12.5px] text-dim">
              Yours counts as the first vote.
            </span>
          </div>
        </div>
      ) : (
        <Alert>
          Anyone can read this list. Sign in to add a suggestion or to vote on one.
        </Alert>
      )}

      {/* --- The list ------------------------------------------------- */}
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing suggested yet. The first one is the hardest.
        </p>
      ) : (
        <div className="divide-y divide-hair/60">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              signedIn={signedIn}
              canRemove={isAdmin || (viewerId !== null && row.by?.id === viewerId)}
              isAdmin={isAdmin}
              onVote={(value) => void vote(row.id, value)}
              onRemove={() => void remove(row.id)}
              onMark={(status) => void mark(row.id, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** What the row looks like the instant an arrow is clicked, before the server says. */
function applyVote(row: Suggestion, value: 1 | -1): Suggestion {
  const was = row.yours;
  const yours: SuggestionVote = was === value ? 0 : value;

  let { up, down } = row;
  if (was === 1) up -= 1;
  if (was === -1) down -= 1;
  if (yours === 1) up += 1;
  if (yours === -1) down += 1;

  return { ...row, up, down, score: up - down, yours };
}

const STATUS_LABEL: Record<SuggestionStatus, string> = {
  open: "Open",
  planned: "Planned",
  done: "Run",
  declined: "Not happening",
};

function Row({
  row,
  signedIn,
  canRemove,
  isAdmin,
  onVote,
  onRemove,
  onMark,
}: {
  row: Suggestion;
  signedIn: boolean;
  canRemove: boolean;
  isAdmin: boolean;
  onVote: (value: 1 | -1) => void;
  onRemove: () => void;
  onMark: (status: SuggestionStatus) => void;
}) {
  return (
    <div
      className={cx(
        "flex gap-4 py-5",
        row.status === "declined" && "opacity-60"
      )}
    >
      {/* The tally, which is what the list is for. */}
      <div className="flex w-[3.25rem] shrink-0 flex-col items-center gap-0.5">
        <Arrow
          direction="up"
          active={row.yours === 1}
          disabled={!signedIn}
          onClick={() => onVote(1)}
        />
        <span
          className={cx(
            "num text-[17px] leading-none",
            row.score > 0 ? "text-chalk" : row.score < 0 ? "text-dim" : "text-muted"
          )}
        >
          {row.score}
        </span>
        <Arrow
          direction="down"
          active={row.yours === -1}
          disabled={!signedIn}
          onClick={() => onVote(-1)}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[16px] text-chalk">{row.title}</h3>
          {row.gameName && <Badge>{row.gameName}</Badge>}
          {row.status !== "open" && (
            <Badge tone={row.status === "declined" ? "ember" : "gold"}>
              {STATUS_LABEL[row.status]}
            </Badge>
          )}
        </div>

        {row.detail && (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
            {row.detail}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-dim">
          <span>
            {plural(row.up, "person", "people")} want{row.up === 1 ? "s" : ""} this
            {row.down > 0 && `, ${row.down} do not`}
          </span>
          {row.by && <span>· suggested by {row.by.name}</span>}
        </div>

        {(canRemove || isAdmin) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isAdmin && (
              <select
                className="field w-auto py-1 text-[12.5px]"
                value={row.status}
                onChange={(input) => onMark(input.target.value as SuggestionStatus)}
              >
                {(Object.keys(STATUS_LABEL) as SuggestionStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            )}
            {canRemove && (
              <Button size="sm" variant="ember" onClick={onRemove}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Arrow({
  direction,
  active,
  disabled,
  onClick,
}: {
  direction: "up" | "down";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      aria-label={direction === "up" ? "I want this" : "Not for me"}
      title={disabled ? "Sign in to vote" : undefined}
      className={cx(
        "rounded p-1 transition-colors",
        disabled && "cursor-not-allowed opacity-40",
        active
          ? direction === "up"
            ? "text-union"
            : "text-flare"
          : "text-dim hover:text-chalk"
      )}
    >
      {/* A triangle rather than one of the line icons: at 14px a chevron and
          an arrow look the same, and a filled shape reads as pressed. */}
      <svg viewBox="0 0 12 8" aria-hidden className={cx("h-2.5 w-3.5 fill-current", direction === "down" && "rotate-180")}>
        <path d="M6 0 L12 8 L0 8 Z" />
      </svg>
    </button>
  );
}
