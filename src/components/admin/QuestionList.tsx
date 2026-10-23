"use client";

import { useState } from "react";
import QuestionDialog from "./QuestionDialog";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Modal,
  plural,
} from "@/components/ui";
import type { AdminFieldView } from "@/lib/admin-games";
import { fieldTypeInfo } from "@/lib/profile-fields";
import {
  deleteFieldAction,
  moveFieldAction,
  restoreFieldAction,
  retireFieldAction,
} from "@/app/admin/games/actions";

/**
 * The questions belonging to one game — or to nobody, which is the global set.
 *
 * Reordering is two buttons rather than drag-and-drop: it is one server round
 * trip either way, it works on a phone and with a keyboard, and `sort` is
 * rewritten densely on the server so the arrows never stop working.
 *
 * ## Retiring is a row control (UC-03 5a, R-09)
 *
 * "Stop asking this" is a thing an admin decides about *one* question, while
 * reading that question's label and its answer count — so it is a button on
 * that row, beside the arrows and Edit, and the retired ones are listed
 * underneath with the button that brings them back. It lived in a panel below
 * the list only because the task that added retiring could not edit this file.
 *
 * ## What each control does to the stored answers
 *
 * Checked against `src/lib/admin-games.ts`, because copy that is merely
 * reassuring is worse than none:
 *
 *  - **Stop asking** (`retireField`) writes `retired_at` and does not touch
 *    `profile_values` at all. `loadProfile` stops listing the question and
 *    stops counting it towards completeness; every answer stays where it is.
 *    `restoreField` puts the question — and therefore all of them — back.
 *  - **Edit** (`updateField`) never deletes an answer either; see
 *    `QuestionDialog`.
 *  - **Delete** (`deleteField`) is the only destructive one, and it is
 *    *refused outright* for a question anybody has answered. So the button is
 *    offered on a question with no answers and nowhere else: a button whose
 *    only possible outcome is a refusal is not a choice, it is a trap. The
 *    server still refuses it if somebody answers between the render and the
 *    click, and says why.
 */

/**
 * What retiring does, printed where the buttons are.
 *
 * Exported so a test can pin it. The wording this replaced promised the
 * opposite of what `retireField` does, and the cost of that is an admin who
 * deletes a question rather than retiring it.
 */
export const RETIRING_EXPLAINER =
  "Stopping a question stops it being asked and stops it counting towards a complete " +
  "profile. Every answer already given is kept, and asking the question again brings " +
  "all of them back.";

/** Why an answered question has no delete button: `deleteField` refuses it. */
export const DELETE_REFUSED_WHEN_ANSWERED =
  "A question somebody has answered cannot be deleted. Stop asking it instead — it " +
  "comes off every profile and every answer is kept.";

/** The confirm on the one kind of question a delete is still offered for. */
export const DELETE_UNANSWERED =
  "Nobody has answered this one yet, so there is nothing stored to keep. Deleting takes " +
  "the question itself and nothing else, and that part cannot be undone.";

export type QuestionListProps = {
  /** `null` for the global set. */
  gameId: string | null;
  gameName: string;
  rankLadder: readonly string[];
  /** Still asked, in `sort` order. */
  fields: AdminFieldView[];
  /** Retired: no longer asked, answers still stored (UC-03 5a). */
  retired?: AdminFieldView[];
  /** Runs an action and refreshes the page's server data. */
  onChanged: () => void;
  busy?: boolean;
};

export default function QuestionList({
  gameId,
  gameName,
  rankLadder,
  fields,
  retired = [],
  onChanged,
  busy,
}: QuestionListProps) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminFieldView | null>(null);
  const [deleting, setDeleting] = useState<AdminFieldView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setWorking(true);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error ?? "That did not work.");
    else onChanged();
    setWorking(false);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    await run(() => deleteFieldAction(deleting.id));
    setDeleting(null);
  };

  const locked = busy || working;

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}

      {fields.length === 0 ? (
        <EmptyState size="sm">
          {retired.length > 0
            ? `${gameName} asks members nothing at the moment — every question it has is retired below.`
            : `No questions yet — ${gameName} asks members for nothing.`}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
          {fields.map((field, index) => (
            <li key={field.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="num w-6 shrink-0 text-12 text-muted">{index + 1}</span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-14">{field.label}</span>
                <Eyebrow as="span" className="mt-0.5 block truncate text-inherit">
                  {field.key} · {fieldTypeInfo(field.type).label}
                  {field.options.length > 0 && ` · ${plural(field.options.length, "option")}`}
                </Eyebrow>
              </span>

              {field.required && <Badge tone="union">Required</Badge>}

              <Badge tone={field.answers > 0 ? "success" : "default"}>
                {plural(field.answers, "answer")}
              </Badge>

              <span className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  aria-label={`Move ${field.label} up`}
                  disabled={locked || index === 0}
                  onClick={() => void run(() => moveFieldAction(field.id, "up"))}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  aria-label={`Move ${field.label} down`}
                  disabled={locked || index === fields.length - 1}
                  onClick={() => void run(() => moveFieldAction(field.id, "down"))}
                >
                  ↓
                </Button>
                <Button size="sm" disabled={locked} onClick={() => setEditing(field)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  aria-label={`Stop asking ${field.label}`}
                  disabled={locked}
                  onClick={() => void run(() => retireFieldAction(field.id))}
                >
                  Stop asking
                </Button>
                {/*
                 * Only where `deleteField` would actually go through. On an
                 * answered question the same click can only come back as a
                 * refusal, and retiring is what the admin wanted anyway.
                 */}
                {field.answers === 0 && (
                  <Button
                    size="sm"
                    variant="flare"
                    aria-label={`Delete ${field.label}`}
                    disabled={locked}
                    onClick={() => setDeleting(field)}
                  >
                    Delete
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-12 leading-relaxed text-muted">{RETIRING_EXPLAINER}</p>

      <Button size="sm" disabled={locked} onClick={() => setAdding(true)}>
        + Add a question
      </Button>

      {retired.length > 0 && (
        <div className="border-t border-hair pt-4">
          <Eyebrow className="mb-2">Not asked any more</Eyebrow>
          <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
            {retired.map((field) => (
              <li key={field.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-14 text-muted">{field.label}</span>
                  <Eyebrow as="span" className="mt-0.5 block truncate text-inherit">
                    {field.key} · {fieldTypeInfo(field.type).label} · not asked
                  </Eyebrow>
                </span>

                <Badge tone={field.answers > 0 ? "success" : "default"}>
                  {plural(field.answers, "answer")} kept
                </Badge>

                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    aria-label={`Ask ${field.label} again`}
                    disabled={locked}
                    onClick={() => void run(() => restoreFieldAction(field.id))}
                  >
                    Ask it again
                  </Button>
                  {field.answers === 0 && (
                    <Button
                      size="sm"
                      variant="flare"
                      aria-label={`Delete ${field.label}`}
                      disabled={locked}
                      onClick={() => setDeleting(field)}
                    >
                      Delete
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <QuestionDialog
          open
          gameId={gameId}
          rankLadder={rankLadder}
          onClose={() => setAdding(false)}
          onSaved={onChanged}
        />
      )}

      {editing && (
        <QuestionDialog
          open
          gameId={gameId}
          rankLadder={rankLadder}
          field={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        size="sm"
        eyebrow="Delete question"
        title={deleting?.label ?? ""}
        footer={
          <>
            <Button size="sm" onClick={() => setDeleting(null)} disabled={working}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="flare"
              disabled={working}
              onClick={() => void confirmDelete()}
            >
              {working ? "Deleting…" : "Delete it"}
            </Button>
          </>
        }
      >
        <p className="text-14 text-muted">{DELETE_UNANSWERED}</p>

        <p className="text-12 leading-relaxed text-muted">{DELETE_REFUSED_WHEN_ANSWERED}</p>

        <Eyebrow>{deleting?.key}</Eyebrow>
      </Modal>
    </div>
  );
}
