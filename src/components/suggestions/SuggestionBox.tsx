"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  Select,
  Textarea,
  cx,
  plural,
} from "@/components/ui";
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
 *
 * ## Signed out (UC-22 3b)
 *
 * The arrows are still there and they still do something — they are links to
 * the sign-in page. A disabled control with a tooltip is not "the system asks
 * them to sign in"; it is the system declining to say anything to the person
 * most likely to be reading this list, since the page is public precisely so
 * that people who are not members can see it.
 *
 * The `maxLength` attributes and the disabled button are a convenience — they
 * stop typing rather than letting a save fail. They are not the check: the
 * lengths and the required description are enforced in `src/lib/suggestions.ts`
 * (the constants are spelled out again here rather than imported, so that a
 * client bundle does not pull the database module in behind them).
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
  const [removing, setRemoving] = useState<Suggestion | null>(null);

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

  /** Only ever reached from the confirm dialog — see {@link RemoveConfirm}. */
  const remove = async (id: string) => {
    setError(null);
    setRemoving(null);
    const before = rows;
    setRows((current) => current.filter((row) => row.id !== id));
    try {
      const result = await deleteSuggestionAction(id);
      if (!result.ok) {
        setRows(before);
        setError(result.error);
      }
    } catch {
      setRows(before);
      setError("Could not reach the server.");
    }
  };

  /*
   * Optimistic like the vote, and for the same reason — but unlike the vote it
   * used to throw the answer away. A status the server refused (the row was
   * deleted while this page sat open) stayed on screen as if it had taken.
   */
  const mark = async (id: string, status: SuggestionStatus) => {
    setError(null);
    const before = rows;
    setRows((current) => current.map((row) => (row.id === id ? { ...row, status } : row)));
    try {
      const result = await setSuggestionStatusAction(id, status);
      if (!result.ok) {
        setRows(before);
        setError(result.error);
      }
    } catch {
      setRows(before);
      setError("Could not reach the server.");
    }
  };

  return (
    <div className="space-y-8">
      {error && <Alert>{error}</Alert>}

      {/* --- Add one -------------------------------------------------- */}
      {signedIn ? (
        <Panel tone="wash" padding="sm" className="space-y-3">
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
          <Textarea
            label="What it is, and why"
            hint="Needed. People are voting on the idea, not the title."
            placeholder="How it would work, how long it would take, why it would be good"
            className="h-24"
            value={detail}
            maxLength={1000}
            onChange={(input) => setDetail(input.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="union"
              disabled={busy || title.trim().length < 3 || detail.trim().length === 0}
              onClick={() => void add()}
            >
              {busy ? "Adding…" : "Suggest it"}
            </Button>
            <span className="text-13 text-dim">
              Yours counts as the first vote.
            </span>
          </div>
        </Panel>
      ) : (
        <Alert>
          Anyone can read this list.{" "}
          <Link href="/signin" className="underline">
            Sign in
          </Link>{" "}
          to add a suggestion or to vote on one.
        </Alert>
      )}

      {/* --- The list ------------------------------------------------- */}
      {rows.length === 0 ? (
        <EmptyState>Nothing suggested yet. The first one is the hardest.</EmptyState>
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
              onRemove={() => setRemoving(row)}
              onMark={(status) => void mark(row.id, status)}
            />
          ))}
        </div>
      )}

      <RemoveConfirm
        row={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing.id)}
      />
    </div>
  );
}

/**
 * Asking before removing (UC-22 E3).
 *
 * The votes are the reason this is a question rather than a button. Taking your
 * own idea back is your business, but the eleven people who backed it are not
 * asked, and they do not get a second chance to back it — so the person doing
 * it is told what goes with it, by name and by count, before it does.
 *
 * Exported so the dialog can be rendered and read on its own.
 */
export function RemoveConfirm({
  row,
  onConfirm,
  onCancel,
}: {
  row: Suggestion | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={row !== null} onClose={onCancel} title="Remove this suggestion?" size="sm">
      {row && (
        <div className="space-y-4">
          <p className="text-14 leading-relaxed text-body">
            “{row.title}” goes for good, and so do the{" "}
            <span className="text-chalk">{plural(row.up + row.down, "vote")}</span> on it.
            Nobody who backed it is asked first, and there is nothing to put it back.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="flare" onClick={onConfirm}>
              Remove it
            </Button>
            <Button onClick={onCancel}>Keep it</Button>
          </div>
        </div>
      )}
    </Modal>
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
          signedIn={signedIn}
          onClick={() => onVote(1)}
        />
        <span
          className={cx(
            "num text-16 leading-none",
            row.score > 0 ? "text-chalk" : row.score < 0 ? "text-dim" : "text-muted"
          )}
        >
          {row.score}
        </span>
        <Arrow
          direction="down"
          active={row.yours === -1}
          signedIn={signedIn}
          onClick={() => onVote(-1)}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-16 text-chalk">{row.title}</h3>
          {row.gameName && <Badge>{row.gameName}</Badge>}
          {row.status !== "open" && (
            <Badge tone={row.status === "declined" ? "flare" : "union"}>
              {STATUS_LABEL[row.status]}
            </Badge>
          )}
        </div>

        {row.detail && (
          <p className="mt-1.5 max-w-2xl text-13 leading-relaxed text-muted">
            {row.detail}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-13 text-dim">
          <span>
            {plural(row.up, "person", "people")} want{row.up === 1 ? "s" : ""} this
            {row.down > 0 && `, ${row.down} do not`}
          </span>
          {row.by && <span>· suggested by {row.by.name}</span>}
        </div>

        {/*
          `canRemove` already covers the admin — it is `isAdmin || it is mine`
          — so `canRemove || isAdmin` read as if there were a third case to
          catch, and there is not. */}
        {canRemove && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isAdmin && (
              <Select
                className="w-auto py-1 text-13"
                aria-label="Status"
                value={row.status}
                onChange={(input) => onMark(input.target.value as SuggestionStatus)}
              >
                {(Object.keys(STATUS_LABEL) as SuggestionStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="flare" onClick={onRemove}>
              Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One arrow — a button for a member, a link to the sign-in page for anybody
 * else (UC-22 3b).
 *
 * Same shape either way, so the row does not change size when somebody signs
 * in, and so a visitor who goes for the arrow is answered rather than ignored.
 */
function Arrow({
  direction,
  active,
  signedIn,
  onClick,
}: {
  direction: "up" | "down";
  active: boolean;
  signedIn: boolean;
  onClick: () => void;
}) {
  const label = direction === "up" ? "I want this" : "Not for me";
  const className = cx(
    "rounded p-1 transition-colors",
    active
      ? direction === "up"
        ? "text-union"
        : "text-flare"
      : "text-dim hover:text-chalk"
  );

  /* A triangle rather than one of the line icons: at 14px a chevron and an
     arrow look the same, and a filled shape reads as pressed. */
  const glyph = (
    <svg
      viewBox="0 0 12 8"
      aria-hidden
      className={cx("h-2.5 w-3.5 fill-current", direction === "down" && "rotate-180")}
    >
      <path d="M6 0 L12 8 L0 8 Z" />
    </svg>
  );

  if (!signedIn) {
    return (
      <Link href="/signin" aria-label={`Sign in to vote — ${label}`} className={className}>
        {glyph}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={className}
    >
      {glyph}
    </button>
  );
}
