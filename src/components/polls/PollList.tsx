"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Field, Modal, cx, plural } from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import type { Poll } from "@/lib/polls";
import {
  type PollDraft,
  closePollAction,
  createPollAction,
  deletePollAction,
  previewPollEditAction,
  updatePollAction,
  votePollAction,
} from "@/app/polls/actions";

/**
 * Polls, read like Discord's: the bars, the counts, and the names.
 *
 * Showing who voted is the part people notice, and it is the point. A poll
 * about which night suits is answered by "Thursday, 6" far less usefully than
 * by "Thursday: Ada, Bo, Cy…", because the follow-up question is always *who*.
 * The page says so above the fold so nobody votes expecting a secret ballot.
 *
 * The bar is share-of-the-most-voted rather than share-of-everybody, for the
 * same reason the availability heatmap is: against everybody, a poll where
 * most people have not answered renders as five short stubs with no shape.
 */

export default function PollList({
  polls,
  signedIn,
  isAdmin,
}: {
  polls: Poll[];
  signedIn: boolean;
  isAdmin: boolean;
}) {
  const [composing, setComposing] = useState(false);

  return (
    <div className="space-y-8">
      {isAdmin && (
        <div>
          {composing ? (
            <PollComposer onDone={() => setComposing(false)} />
          ) : (
            <Button variant="gold" onClick={() => setComposing(true)}>
              Post a poll
            </Button>
          )}
        </div>
      )}

      {polls.length === 0 ? (
        <p className="text-[13px] text-muted">No polls yet.</p>
      ) : (
        <div className="space-y-3">
          {polls.map((poll) => (
            <PollCard key={poll.id} poll={poll} signedIn={signedIn} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One poll                                                           */
/* ------------------------------------------------------------------ */

function PollCard({
  poll,
  signedIn,
  isAdmin,
}: {
  poll: Poll;
  signedIn: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [yours, setYours] = useState(poll.yours);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const most = Math.max(1, ...poll.options.map((option) => option.voters.length));

  const vote = async (optionId: string) => {
    if (!signedIn || poll.closed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await votePollAction(poll.id, optionId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setYours(result.data.yours);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <PollComposer
        poll={poll}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <section className="rounded-xl bg-panel px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] text-chalk">{poll.question}</h3>
          {poll.detail && (
            <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
              {poll.detail}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {poll.multiple && <Badge>Pick as many as you like</Badge>}
          {poll.closed ? <Badge tone="ember">Closed</Badge> : <Badge tone="gold">Open</Badge>}
        </div>
      </div>

      {error && <Alert className="mt-3">{error}</Alert>}

      <div className="mt-4 space-y-2">
        {poll.options.map((option) => {
          const count = option.voters.length;
          const mine = yours.includes(option.id);
          const share = Math.round((count / most) * 100);
          return (
            <button
              key={option.id}
              type="button"
              disabled={!signedIn || poll.closed || busy}
              onClick={() => void vote(option.id)}
              aria-pressed={mine}
              title={
                poll.closed
                  ? "This poll has closed"
                  : signedIn
                    ? undefined
                    : "Sign in to vote"
              }
              className={cx(
                "relative block w-full overflow-hidden rounded-lg px-3.5 py-2.5 text-left transition-colors",
                mine ? "bg-union/[0.14]" : "bg-white/[0.03]",
                signedIn && !poll.closed && "hover:bg-white/[0.06]",
                (!signedIn || poll.closed) && "cursor-default"
              )}
            >
              {/* The bar itself, behind the label. */}
              <span
                aria-hidden
                className={cx(
                  "absolute inset-y-0 left-0 -z-0 transition-[width] duration-300",
                  mine ? "bg-union/25" : "bg-white/[0.05]"
                )}
                style={{ width: `${share}%` }}
              />
              <span className="relative flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cx("flex-1 text-[14px]", mine ? "text-chalk" : "text-body")}>
                  {option.label}
                </span>
                <span className="num shrink-0 text-[13px] text-muted">{count}</span>
              </span>

              {count > 0 && (
                <span className="relative mt-1.5 flex flex-wrap gap-1">
                  {option.voters.map((voter) => (
                    <span
                      key={voter.id}
                      className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11.5px] text-muted"
                    >
                      {voter.name}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-dim">
        <span>{plural(poll.voterCount, "person", "people")} voted</span>
        {poll.closesAt && (
          <span>
            · {poll.closed ? "closed" : "closes"} <LocalTime at={poll.closesAt.toISOString()} />
          </span>
        )}
        {poll.by && <span>· posted by {poll.by.name}</span>}
        {!signedIn && <span>· sign in to vote</span>}
      </div>

      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-3">
          {!poll.closed && (
            <>
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await closePollAction(poll.id);
                  router.refresh();
                }}
              >
                Close now
              </Button>
            </>
          )}
          {poll.closed && (
            <span className="text-[12.5px] text-dim">
              Closed polls cannot be edited — the result stands.
            </span>
          )}
          <Button
            size="sm"
            variant="ember"
            className="ml-auto"
            onClick={async () => {
              await deletePollAction(poll.id);
              router.refresh();
            }}
          >
            Delete
          </Button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Posting and editing                                                */
/* ------------------------------------------------------------------ */

type DraftOption = { id?: string; label: string };

function PollComposer({ poll, onDone }: { poll?: Poll; onDone: () => void }) {
  const router = useRouter();
  const [question, setQuestion] = useState(poll?.question ?? "");
  const [detail, setDetail] = useState(poll?.detail ?? "");
  const [multiple, setMultiple] = useState(poll?.multiple ?? false);
  const [closesAt, setClosesAt] = useState(
    poll?.closesAt ? toLocalInput(poll.closesAt) : ""
  );
  const [options, setOptions] = useState<DraftOption[]>(
    poll ? poll.options.map((option) => ({ id: option.id, label: option.label })) : [
      { label: "" },
      { label: "" },
    ]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ lostVotes: number; dropped: string[] } | null>(null);

  const draft = (): PollDraft => ({
    question,
    detail,
    multiple,
    closesAt: closesAt ? new Date(closesAt).toISOString() : null,
    options: options.filter((option) => option.label.trim()),
  });

  const save = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      if (poll && !force) {
        const preview = await previewPollEditAction(poll.id, draft());
        if (preview.ok && preview.data.lostVotes > 0) {
          setConfirm({
            lostVotes: preview.data.lostVotes,
            dropped: preview.data.droppedOptions,
          });
          return;
        }
      }

      const result = poll
        ? await updatePollAction(poll.id, draft())
        : await createPollAction(draft());

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirm(null);
      onDone();
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-xl bg-panel px-5 py-4">
      {error && <Alert>{error}</Alert>}

      <Field
        label="Question"
        placeholder="Which night suits for the Rivals tournament?"
        value={question}
        maxLength={200}
        onChange={(input) => setQuestion(input.target.value)}
      />
      <Field
        label="Anything else"
        placeholder="Optional"
        value={detail}
        maxLength={500}
        onChange={(input) => setDetail(input.target.value)}
      />

      <div className="space-y-2">
        <span className="eyebrow">Options</span>
        {options.map((option, index) => (
          <div key={index} className="flex items-center gap-2">
            <Field
              label=""
              aria-label={`Option ${index + 1}`}
              placeholder={`Option ${index + 1}`}
              value={option.label}
              maxLength={100}
              wrapperClassName="flex-1"
              onChange={(input) =>
                setOptions((current) =>
                  current.map((row, at) =>
                    at === index ? { ...row, label: input.target.value } : row
                  )
                )
              }
            />
            {options.length > 2 && (
              <Button
                size="sm"
                variant="ember"
                aria-label={`Remove option ${index + 1}`}
                onClick={() =>
                  setOptions((current) => current.filter((_unused, at) => at !== index))
                }
              >
                ×
              </Button>
            )}
          </div>
        ))}
        {options.length < 20 && (
          <Button size="sm" onClick={() => setOptions((current) => [...current, { label: "" }])}>
            Add an option
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex cursor-pointer items-center gap-2 pb-1">
          <input
            type="checkbox"
            checked={multiple}
            onChange={(input) => setMultiple(input.target.checked)}
            className="h-4 w-4 accent-union"
          />
          <span className="text-[13.5px] text-body">Let people pick more than one</span>
        </label>

        <Field
          label="Closes"
          type="datetime-local"
          value={closesAt}
          wrapperClassName="w-[15rem]"
          onChange={(input) => setClosesAt(input.target.value)}
        />
      </div>

      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        You can change the question and the options while the poll is open. Once it closes
        nothing moves — a poll whose wording can change after the result is a poll that
        proves nothing. Leave the closing time blank to keep it open until you close it.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="gold" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : poll ? "Save changes" : "Post it"}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="This will discard votes"
      >
        {confirm && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-body">
              Removing {confirm.dropped.map((label) => `“${label}”`).join(", ")} throws away{" "}
              <span className="text-chalk">{plural(confirm.lostVotes, "vote")}</span>. Those
              people voted for something that will not exist any more, so there is nowhere to
              move their answer to — they would have to vote again.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="ember" disabled={busy} onClick={() => void save(true)}>
                Remove it and lose the votes
              </Button>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Leave it alone
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

/** A `datetime-local` value in the admin's own zone, from a stored instant. */
function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}`;
}
