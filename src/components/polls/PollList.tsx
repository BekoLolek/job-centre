"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Panel,
  cx,
  plural,
} from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import type { Poll, PollEditPreview } from "@/lib/polls";
import {
  type PollActionResult,
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
 *
 * ## Two questions this screen asks before it does anything (UC-23 4, 5b)
 *
 * Editing a poll people have voted in, and deleting one. Both are asked in the
 * same way and for the same reason: the votes belong to other people, none of
 * whom is in the room, and neither action can be undone. The edit's question is
 * built from a server-side preview — see {@link afterPreview} for what a
 * preview means and {@link savePoll} for the save asking for one at all, which
 * together are what stops a save going ahead when the preview never arrived.
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
            <Button variant="union" onClick={() => setComposing(true)}>
              Post a poll
            </Button>
          )}
        </div>
      )}

      {polls.length === 0 ? (
        <EmptyState>No polls yet.</EmptyState>
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
  const [deleting, setDeleting] = useState(false);

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

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await deletePollAction(poll.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(false);
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
    <Panel as="section" tone="wash" padding="sm">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-16 text-chalk">{poll.question}</h3>
          {poll.detail && (
            <p className="mt-1.5 max-w-2xl text-13 leading-relaxed text-muted">
              {poll.detail}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {poll.multiple && <Badge>Pick as many as you like</Badge>}
          {poll.closed ? <Badge tone="flare">Closed</Badge> : <Badge tone="union">Open</Badge>}
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
                "relative block w-full overflow-hidden rounded px-3.5 py-2.5 text-left transition-colors",
                mine ? "bg-union/15" : "bg-overlay-1",
                signedIn && !poll.closed && "hover:bg-overlay-2",
                (!signedIn || poll.closed) && "cursor-default"
              )}
            >
              {/* The bar itself, behind the label. */}
              <span
                aria-hidden
                className={cx(
                  "absolute inset-y-0 left-0 -z-0 transition-[width] duration-300",
                  mine ? "bg-union/25" : "bg-overlay-2"
                )}
                style={{ width: `${share}%` }}
              />
              <span className="relative flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cx("flex-1 text-14", mine ? "text-chalk" : "text-body")}>
                  {option.label}
                </span>
                <span className="num shrink-0 text-13 text-body">{count}</span>
              </span>

              {count > 0 && (
                <span className="relative mt-1.5 flex flex-wrap gap-1">
                  {option.voters.map((voter) => (
                    <Badge key={voter.id}>{voter.name}</Badge>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-13 text-dim">
        <span>{plural(poll.voterCount, "person", "people")} voted</span>
        <span>
          · {poll.closed ? "closed" : "closes"} <LocalTime at={poll.closesAt.toISOString()} />
        </span>
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
            <span className="text-13 text-dim">
              Closed polls cannot be edited — the result stands.
            </span>
          )}
          <Button
            size="sm"
            variant="flare"
            className="ml-auto"
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
        </div>
      )}

      <DeleteConfirm
        poll={deleting ? poll : null}
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
      />
    </Panel>
  );
}

/**
 * Asking before a poll is deleted (UC-23 5b).
 *
 * A delete takes the votes with it by cascade, and the people who cast them are
 * not in the room. There is no undo and no copy: the result a closed poll was
 * meant to be a record of stops existing. So the question names the poll, says
 * how many people answered it, and makes the confirming button the one that
 * says what it does.
 *
 * Exported so the dialog can be rendered and read on its own.
 */
export function DeleteConfirm({
  poll,
  busy = false,
  onConfirm,
  onCancel,
}: {
  poll: Poll | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={poll !== null} onClose={onCancel} title="Delete this poll?" size="sm">
      {poll && (
        <div className="space-y-4">
          <p className="text-14 leading-relaxed text-body">
            “{poll.question}” goes, and so do the{" "}
            <span className="text-chalk">
              {plural(poll.voterCount, "answer")}
            </span>{" "}
            people gave it. Nothing keeps a copy, and a closed poll is the only
            record of what was decided.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="flare" disabled={busy} onClick={onConfirm}>
              Delete it and the votes
            </Button>
            <Button disabled={busy} onClick={onCancel}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Posting and editing                                                */
/* ------------------------------------------------------------------ */

type DraftOption = { id?: string; label: string };

/**
 * What the confirm dialog is built from — the preview, as a question.
 *
 * The preview itself, less the one field that is not a cost: `closed` is the
 * answer to "may this be edited at all", which {@link afterPreview} has already
 * turned into a refusal by the time there is a dialog. Everything else is
 * carried across under the name the library gave it, so that a field added to
 * {@link PollEditPreview} arrives here rather than having to be re-declared.
 */
export type EditConfirm = Omit<PollEditPreview, "closed">;

/**
 * What to do once the preview comes back (UC-23 4).
 *
 * Three answers and no fourth. The one that matters is `stop`: the save used to
 * run whenever the preview was *not* a success with votes to lose, so a preview
 * that failed — the session expired, the poll was deleted under the admin, the
 * network dropped — fell through to a save that went ahead without ever asking.
 * The one case UC-23 4 exists for is the one case that skipped it.
 *
 * Pure, and exported, because it is the whole rule and a browser is not needed
 * to state it.
 */
export type PreviewOutcome =
  | { kind: "stop"; error: string }
  | { kind: "confirm"; confirm: EditConfirm }
  | { kind: "save" };

export function afterPreview(result: PollActionResult<PollEditPreview>): PreviewOutcome {
  if (!result.ok) return { kind: "stop", error: result.error };

  const { closed, ...confirm } = result.data;
  if (closed) {
    return {
      kind: "stop",
      error: "That poll has closed. A closed poll cannot be edited — the result stands.",
    };
  }

  if (confirm.lostVotes > 0 || confirm.reworded.length > 0) return { kind: "confirm", confirm };

  return { kind: "save" };
}

/**
 * One press of Save, from the preview to the write (UC-23 4).
 *
 * Lifted out of the composer because the rule it carries is the one the whole
 * confirm exists for, and a rule that only exists inside a `useState` closure
 * is a rule nothing can test. {@link afterPreview} says what a preview means;
 * this says what is done about it — and, crucially, that an edit asks for one
 * at all. Delete the `poll && !force` guard and every save skips the preview,
 * which is precisely the bug Task 25 fixed and precisely what the test beside
 * this file now pins.
 *
 * `force` is the answer coming back from the dialog: the preview has been seen
 * and accepted, so asking for it again would only put the same question up
 * twice.
 */
export type SaveOutcome =
  | { kind: "stop"; error: string }
  | { kind: "confirm"; confirm: EditConfirm }
  | { kind: "saved" };

export async function savePoll(
  poll: Poll | undefined,
  draft: PollDraft,
  force: boolean
): Promise<SaveOutcome> {
  if (poll && !force) {
    const outcome = afterPreview(await previewPollEditAction(poll.id, draft));
    // Anything but a clean preview is the answer: a refusal to show, or a
    // question to ask. Neither of them writes.
    if (outcome.kind !== "save") return outcome;
  }

  const result = poll ? await updatePollAction(poll.id, draft) : await createPollAction(draft);
  if (!result.ok) return { kind: "stop", error: result.error };
  return { kind: "saved" };
}

function PollComposer({ poll, onDone }: { poll?: Poll; onDone: () => void }) {
  const router = useRouter();
  const [question, setQuestion] = useState(poll?.question ?? "");
  const [detail, setDetail] = useState(poll?.detail ?? "");
  const [multiple, setMultiple] = useState(poll?.multiple ?? false);
  const [closesAt, setClosesAt] = useState(poll ? toLocalInput(poll.closesAt) : "");
  const [options, setOptions] = useState<DraftOption[]>(
    poll ? poll.options.map((option) => ({ id: option.id, label: option.label })) : [
      { label: "" },
      { label: "" },
    ]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<EditConfirm | null>(null);

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
      const outcome = await savePoll(poll, draft(), force);
      if (outcome.kind === "stop") {
        setError(outcome.error);
        return;
      }
      if (outcome.kind === "confirm") {
        setConfirm(outcome.confirm);
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
    <Panel as="section" tone="wash" padding="sm" className="space-y-4">
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
        <Eyebrow as="span">Options</Eyebrow>
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
                variant="flare"
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
        {/*
         * No `pb-1` any more. That 4px was nudging a 20px-tall label up off the
         * bottom of this `items-end` row so it read as level with the field
         * beside it; `Checkbox` now stands 44px tall for the touch floor and
         * centres its own contents, so the nudge lands on top of that and
         * pushes the box back past the field's middle.
         */}
        <Checkbox
          label="Let people pick more than one"
          checked={multiple}
          onChange={setMultiple}
        />

        <Field
          label="Closes"
          hint="Needed, and in the future."
          type="datetime-local"
          value={closesAt}
          wrapperClassName="w-[15rem]"
          onChange={(input) => setClosesAt(input.target.value)}
        />
      </div>

      <p className="max-w-2xl text-13 leading-relaxed text-muted">
        You can change the question and the options while the poll is open. Once it closes
        nothing moves — a poll whose wording can change after the result is a poll that
        proves nothing. Every poll needs a closing time, so that the result is final on its
        own rather than whenever somebody remembers it.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="union" disabled={busy || !closesAt} onClick={() => void save()}>
          {busy ? "Saving…" : poll ? "Save changes" : "Post it"}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>

      <EditConfirmDialog
        confirm={confirm}
        busy={busy}
        onConfirm={() => void save(true)}
        onCancel={() => setConfirm(null)}
      />
    </Panel>
  );
}

/**
 * What this edit costs, said before it costs it (UC-23 4).
 *
 * Three separate sentences rather than one number, because they are three
 * different things to have done to somebody: their answer deleted, their answer
 * left attached to different words, or their several answers cleared because
 * the poll stopped allowing several. Only the paragraphs that apply appear.
 */
export function EditConfirmDialog({
  confirm,
  busy = false,
  onConfirm,
  onCancel,
}: {
  confirm: EditConfirm | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={confirm !== null}
      onClose={onCancel}
      title="This changes votes people have already cast"
    >
      {confirm && (
        <div className="space-y-4">
          {confirm.droppedOptions.length > 0 && (
            <p className="text-14 leading-relaxed text-body">
              Removing {confirm.droppedOptions.map((label) => `“${label}”`).join(", ")} throws away{" "}
              <span className="text-chalk">{plural(confirm.lostVotes, "vote")}</span>. Those
              people voted for something that will not exist any more, so there is nowhere to
              move their answer to — they would have to vote again.
            </p>
          )}

          {confirm.reworded.length > 0 && (
            <div className="space-y-2 text-14 leading-relaxed text-body">
              <p>
                Rewording an option keeps the votes on it — nobody is asked again, so these
                answers will stand against words their owners never read:
              </p>
              <ul className="space-y-1 text-13 text-muted">
                {confirm.reworded.map((row) => (
                  <li key={`${row.from}-${row.to}`}>
                    “{row.from}” → “{row.to}” · {plural(row.votes, "vote")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {confirm.clearedVoters > 0 && (
            <p className="text-14 leading-relaxed text-body">
              Only one answer each from now on, and{" "}
              <span className="text-chalk">
                {plural(confirm.clearedVoters, "person", "people")}
              </span>{" "}
              picked more than one. Rather than choose for them, their votes are cleared and
              they are asked again.
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button variant="flare" disabled={busy} onClick={onConfirm}>
              Save it anyway
            </Button>
            <Button disabled={busy} onClick={onCancel}>
              Leave it alone
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A `datetime-local` value in the admin's own zone, from a stored instant. */
function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}`;
}
