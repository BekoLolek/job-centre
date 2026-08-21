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
import { deleteFieldAction, moveFieldAction } from "@/app/admin/games/actions";

/**
 * The questions belonging to one game — or to nobody, which is the global set.
 *
 * Reordering is two buttons rather than drag-and-drop: it is one server round
 * trip either way, it works on a phone and with a keyboard, and `sort` is
 * rewritten densely on the server so the arrows never stop working.
 *
 * Deleting says the number out loud first. `profile_values.field_id` cascades,
 * so removing a question really does take every answer with it — the confirm
 * exists so that is a decision rather than a discovery.
 */

export type QuestionListProps = {
  /** `null` for the global set. */
  gameId: string | null;
  gameName: string;
  rankLadder: readonly string[];
  fields: AdminFieldView[];
  /** Runs an action and refreshes the page's server data. */
  onChanged: () => void;
  busy?: boolean;
};

export default function QuestionList({
  gameId,
  gameName,
  rankLadder,
  fields,
  onChanged,
  busy,
}: QuestionListProps) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminFieldView | null>(null);
  const [deleting, setDeleting] = useState<AdminFieldView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const move = async (field: AdminFieldView, direction: "up" | "down") => {
    setWorking(true);
    setError(null);
    const result = await moveFieldAction(field.id, direction);
    if (!result.ok) setError(result.error);
    else onChanged();
    setWorking(false);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setWorking(true);
    setError(null);
    const result = await deleteFieldAction(deleting.id);
    if (!result.ok) setError(result.error);
    else onChanged();
    setDeleting(null);
    setWorking(false);
  };

  const locked = busy || working;

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}

      {fields.length === 0 ? (
        <EmptyState size="sm">
          No questions yet — {gameName} asks members for nothing.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-hair/60 rounded-xl border border-hair">
          {fields.map((field, index) => (
            <li key={field.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="num w-6 shrink-0 text-xs text-muted">{index + 1}</span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{field.label}</span>
                <span className="eyebrow mt-0.5 block truncate">
                  {field.key} · {fieldTypeInfo(field.type).label}
                  {field.options.length > 0 && ` · ${plural(field.options.length, "option")}`}
                </span>
              </span>

              {field.required && <Badge tone="gold">Required</Badge>}

              <Badge tone={field.answers > 0 ? "signal" : "default"}>
                {plural(field.answers, "answer")}
              </Badge>

              <span className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  aria-label={`Move ${field.label} up`}
                  disabled={locked || index === 0}
                  onClick={() => void move(field, "up")}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  aria-label={`Move ${field.label} down`}
                  disabled={locked || index === fields.length - 1}
                  onClick={() => void move(field, "down")}
                >
                  ↓
                </Button>
                <Button size="sm" disabled={locked} onClick={() => setEditing(field)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ember"
                  disabled={locked}
                  onClick={() => setDeleting(field)}
                >
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Button size="sm" disabled={locked} onClick={() => setAdding(true)}>
        + Add a question
      </Button>

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
              variant="ember"
              disabled={working}
              onClick={() => void confirmDelete()}
            >
              {working ? "Deleting…" : "Delete for good"}
            </Button>
          </>
        }
      >
        {deleting && deleting.answers > 0 ? (
          <Alert tone="ember">
            <span className="block font-medium">
              This destroys {plural(deleting.answers, "stored answer")}
            </span>
            <span className="mt-1 block opacity-90">
              {deleting.answers === 1 ? "One member has" : `${deleting.answers} members have`}{" "}
              answered this question. Deleting it removes the question and{" "}
              {deleting.answers === 1 ? "their answer" : "every one of their answers"}, and
              there is no undo.
            </span>
          </Alert>
        ) : (
          <p className="text-sm text-muted">
            Nobody has answered this one yet, so nothing is lost but the question itself.
          </p>
        )}

        <p className="text-xs leading-relaxed text-muted">
          If you only want to stop asking it for now, deactivate the whole game instead —
          that hides its questions without touching a single answer.
        </p>

        <Eyebrow>{deleting?.key}</Eyebrow>
      </Modal>
    </div>
  );
}
