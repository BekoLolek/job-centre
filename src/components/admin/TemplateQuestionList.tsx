"use client";

import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Select,
  Textarea,
  Toggle,
  plural,
} from "@/components/ui";
import type { EventQuestionSpec, ProfileFieldType } from "@/db/schema";
import type { TemplateFieldOption } from "@/lib/admin-templates";
import { FIELD_TYPES, fieldTypeInfo, normaliseOptions } from "@/lib/profile-fields";

/**
 * The default questions a template carries.
 *
 * Unlike `/admin/games`' question list, nothing here is a server round trip:
 * a template's questions are one jsonb column, so the whole list is edited in
 * the browser and written once when the card is saved. That is also why
 * reordering and removing are free — there is no `sort` to renumber and no
 * stored answer to orphan, because a template has never been answered by
 * anybody.
 *
 * ## The prefill link is a *key*, not an id
 *
 * A question that names a profile field arrives at the member already answered
 * (§2, §7). An `event_questions` row holds the field's id, but a template
 * cannot: ids differ between the local database and the deployment, and a
 * template is a thing you might one day want to move. So the template stores
 * the field's **key** and `resolveTemplateQuestions` in `events.ts` resolves it
 * against the new event's game when the template is used. Two fields in
 * different games can share a key, which is why the picker says which game each
 * one belongs to.
 */

export default function TemplateQuestionList({
  questions,
  profileFields,
  gameId,
  onChange,
}: {
  questions: EventQuestionSpec[];
  profileFields: TemplateFieldOption[];
  /** The template's game, so the picker can say which links will resolve. */
  gameId: string | null;
  onChange: (next: EventQuestionSpec[]) => void;
}) {
  const [editing, setEditing] = useState<{ index: number; draft: Draft } | null>(null);

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const remove = (index: number) => onChange(questions.filter((_, i) => i !== index));

  const commit = (draft: Draft, index: number) => {
    const spec: EventQuestionSpec = {
      label: draft.label.trim(),
      type: draft.type,
      options: normaliseOptions(
        draft.options
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      ),
      required: draft.required,
      ...(draft.profileFieldKey ? { profileFieldKey: draft.profileFieldKey } : {}),
    };
    const next = [...questions];
    if (index === -1) next.push(spec);
    else next[index] = spec;
    onChange(next);
    setEditing(null);
  };

  return (
    <div className="space-y-3">
      {questions.length === 0 ? (
        <EmptyState size="sm">
          No questions yet — an event made from this template arrives with an empty
          application form.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-hair/60 border border-hair">
          {questions.map((question, index) => {
            const link = question.profileFieldKey
              ? profileFields.find(
                  (field) =>
                    field.key === question.profileFieldKey &&
                    (field.gameId === gameId || field.gameId === null)
                )
              : undefined;
            return (
              <li
                key={`${question.key ?? question.label}-${index}`}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
              >
                <span className="num w-6 shrink-0 text-xs text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{question.label}</span>
                  <span className="eyebrow mt-0.5 block">
                    {fieldTypeInfo(question.type).label}
                    {question.options && question.options.length > 0
                      ? ` · ${plural(question.options.length, "option")}`
                      : ""}
                  </span>
                </span>
                {question.required && <Badge tone="gold">Required</Badge>}
                {question.profileFieldKey && (
                  <Badge
                    tone={link ? "signal" : "ember"}
                    title={
                      link
                        ? `Prefilled from "${link.label}"${link.gameName ? ` (${link.gameName})` : " (everyone)"}`
                        : "No profile field with this key on this game — the question will simply not prefill."
                    }
                  >
                    prefill: {question.profileFieldKey}
                  </Badge>
                )}
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    aria-label={`Move ${question.label} up`}
                    disabled={index === 0}
                    onClick={() => move(index, "up")}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Move ${question.label} down`}
                    disabled={index === questions.length - 1}
                    onClick={() => move(index, "down")}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setEditing({ index, draft: draftOf(question) })}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ember" onClick={() => remove(index)}>
                    Remove
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="gold"
          onClick={() => setEditing({ index: -1, draft: emptyDraft() })}
        >
          Add question
        </Button>
        <span className="text-xs text-muted">
          Removing one here changes nothing about any event already made from this template.
        </span>
      </div>

      <QuestionDialog
        state={editing}
        profileFields={profileFields}
        gameId={gameId}
        onClose={() => setEditing(null)}
        onSave={commit}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The dialog                                                         */
/* ------------------------------------------------------------------ */

type Draft = {
  label: string;
  type: ProfileFieldType;
  /** One option per line — the shape somebody actually types. */
  options: string;
  required: boolean;
  profileFieldKey: string;
};

function emptyDraft(): Draft {
  return { label: "", type: "select", options: "", required: false, profileFieldKey: "" };
}

function draftOf(question: EventQuestionSpec): Draft {
  return {
    label: question.label,
    type: question.type,
    options: (question.options ?? []).map((option) => option.label).join("\n"),
    required: question.required ?? false,
    profileFieldKey: question.profileFieldKey ?? "",
  };
}

function QuestionDialog({
  state,
  profileFields,
  gameId,
  onClose,
  onSave,
}: {
  state: { index: number; draft: Draft } | null;
  profileFields: TemplateFieldOption[];
  gameId: string | null;
  onClose: () => void;
  onSave: (draft: Draft, index: number) => void;
}) {
  const [draft, setDraft] = useState<Draft>(state?.draft ?? emptyDraft());
  const [seen, setSeen] = useState<number | null>(null);

  // The dialog is rendered once and pointed at a different question each time,
  // so the draft is re-seeded when the index changes rather than on mount.
  if (state && seen !== state.index) {
    setSeen(state.index);
    setDraft(state.draft);
  }
  if (!state && seen !== null) setSeen(null);

  const info = fieldTypeInfo(draft.type);
  const options = draft.options
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Only fields the event could actually prefill from: this game's, plus the
  // global ones. `setEventQuestions` refuses anything else, and a field
  // belonging to another game would prefill an answer about a different game.
  const linkable = profileFields.filter(
    (field) => field.gameId === null || field.gameId === gameId
  );
  const linked = linkable.find((field) => field.key === draft.profileFieldKey);
  const linkTypeMismatch = linked !== undefined && linked.type !== draft.type;

  const problem = !draft.label.trim()
    ? "Give the question a label — it is what the member reads."
    : info.needsOptions && options.length === 0
      ? `"${info.label}" needs at least one option to choose from.`
      : linkTypeMismatch
        ? `"${linked?.label}" is a ${linked ? fieldTypeInfo(linked.type as ProfileFieldType).label.toLowerCase() : ""} question, so it cannot prefill a ${info.label.toLowerCase()} one.`
        : null;

  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={state && state.index === -1 ? "Add a question" : "Edit the question"}
      eyebrow="A template's default application form"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="gold"
            disabled={problem !== null}
            onClick={() => state && onSave(draft, state.index)}
          >
            {state && state.index === -1 ? "Add" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field
          label="Label"
          hint="The sentence the member reads."
          value={draft.label}
          maxLength={120}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />

        <div>
          <Eyebrow className="mb-2">Answer type</Eyebrow>
          <ChoiceRow>
            {FIELD_TYPES.map((option) => (
              <ChoiceChip
                key={option.type}
                selected={option.type === draft.type}
                onClick={() => setDraft({ ...draft, type: option.type })}
              >
                {option.label}
              </ChoiceChip>
            ))}
          </ChoiceRow>
          <p className="mt-2 text-xs text-muted">{info.hint}</p>
        </div>

        {info.needsOptions && (
          <Textarea
            label="Options"
            hint="One per line. These are what the member taps."
            value={draft.options}
            rows={4}
            onChange={(event) => setDraft({ ...draft, options: event.target.value })}
          />
        )}

        <div>
          <Eyebrow className="mb-2">Required</Eyebrow>
          <Toggle
            value={draft.required}
            onChange={(next) => setDraft({ ...draft, required: next === true })}
          />
        </div>

        <div className="border-t border-hair pt-4">
          <Select
            label="Prefill from the profile"
            hint="The member arrives with their stored answer filled in and checks it rather than retypes it."
            value={draft.profileFieldKey}
            onChange={(event) => setDraft({ ...draft, profileFieldKey: event.target.value })}
          >
            <option value="">Ask fresh every time</option>
            {linkable.map((field) => (
              <option key={`${field.gameId ?? "global"}-${field.key}`} value={field.key}>
                {field.label} · {field.gameName ?? "Everyone"} ({field.key})
              </option>
            ))}
          </Select>
          {linkable.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              This template&apos;s game has no profile questions to prefill from. Add some at{" "}
              <span className="font-mono">/admin/games</span>.
            </p>
          )}
        </div>

        {problem && <Alert>{problem}</Alert>}
      </div>
    </Modal>
  );
}
