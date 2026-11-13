"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ChoiceChip,
  ChoiceRow,
  Eyebrow,
  Field,
  Modal,
  Panel,
  Textarea,
  plural,
} from "@/components/ui";
import FieldControl from "@/components/profile/FieldControl";
import type { ProfileFieldOption, ProfileFieldType, ProfileValue } from "@/db/schema";
import type { AdminFieldView, FieldInput } from "@/lib/admin-games";
import {
  FIELD_TYPES,
  THIS_GAME,
  canHoldRoles,
  choicesFor,
  fieldTypeInfo,
  normaliseOptions,
  rankUnavailable,
} from "@/lib/profile-fields";
import {
  createFieldAction,
  previewFieldEditAction,
  updateFieldAction,
} from "@/app/admin/games/actions";

/**
 * Add or edit one question.
 *
 * Three decisions and a preview: what to call it, what kind of answer it takes,
 * and whether it is required. Options are typed one per line, because for the
 * *admin* a textarea is the fast path — plan §2's "clicks, not typing" rule is
 * about the member filling the form in, not the person defining it.
 *
 * A game's own pick-any gets a fourth: whether it is the question the game's
 * preferred roles are read from (R-259 / UC-54). The box is offered only
 * there — `canHoldRoles`, the same rule `createField` and `updateField` keep
 * the tick by — so it is never on screen where ticking it would do nothing.
 *
 * The preview underneath is live and is the real control, `FieldControl`, with
 * the draft definition fed into it. It is what makes "add REPO with two
 * questions" a minute's work: you can see the chips a member will tap before
 * saving anything, so a badly-worded option gets fixed here rather than after
 * forty people have answered it.
 *
 * Editing a question that already has answers goes through a second step:
 * `previewFieldEdit` says how many stored answers the new definition will no
 * longer read, and nothing is written until that number has been seen.
 *
 * **No answer is deleted by an edit** (UC-03 5a, R-09). `updateField` writes
 * the field row and nothing else, so the warning below is about answers going
 * *quiet*, not about answers going away — and putting the question back as it
 * was brings every one of them back onto the form. The copy said the opposite
 * until Task 47, which is the worse failure of the two: an admin who believes
 * an edit destroys answers avoids retiring a question and deletes it instead.
 */

/**
 * What the admin is told when the new definition cannot read stored answers.
 *
 * Exported as a function of the count so a test can pin every word of it
 * without driving the dialog into that state. Each clause is checked against
 * `updateField`: the rows stay, `loadProfile` hands the member the question
 * with a value its control cannot show, and restoring the old definition makes
 * them readable again because nothing was thrown away in between.
 */
export function strandedAnswerNotice(count: number): { heading: string; body: string } {
  const one = count === 1;
  return {
    heading: `${plural(count, "stored answer")} no longer fits this question`,
    body:
      `Nothing is deleted — editing a question never throws an answer away. ` +
      `${one ? "The answer stays" : "The answers stay"} on the member's profile row, ` +
      `but the question as you have now written it cannot show ${one ? "it" : "them"} ` +
      `until ${one ? "that member answers" : "those members answer"} again. Putting the ` +
      `question back the way it was makes ${one ? "it" : "them"} readable again.`,
  };
}

/**
 * The words beside the preferred-roles box. Exported so a test can find the
 * box by them rather than by its position in the dialog.
 */
export const ROLES_MARKER_LABEL = "This is the game's preferred-roles question";

/**
 * What a save sends, for a new question and an edited one alike.
 *
 * Exported and pure so a test can read it, because a static render cannot
 * click Save. The field worth pinning is `holdsRoles`: it is optional on
 * `FieldInput`, so leaving it out compiles, and `updateField` reads its
 * absence as "not marked" — an editor that dropped it would clear the marker
 * on every edit of the marked question, a rename included.
 */
export function fieldInputFrom(draft: {
  label: string;
  type: ProfileFieldType;
  options: readonly ProfileFieldOption[];
  required: boolean;
  holdsRoles: boolean;
}): FieldInput {
  return {
    label: draft.label,
    type: draft.type,
    options: draft.options.map((option) => option.label),
    required: draft.required,
    holdsRoles: draft.holdsRoles,
  };
}

/*
 * The "why not a rank question here" copy is `rankUnavailable` in
 * `src/lib/profile-fields.ts`, which is also where `createField` reads its
 * refusal from — the two were the same two sentences in two files. A dialog
 * that can only be open over one game names it "This game" (`THIS_GAME`),
 * because it has no game row to read a name out of.
 */

export type QuestionDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Where a new question lands. `null` is the global section. */
  gameId: string | null;
  /** The game's ladder, so a `rank` preview has something to show. */
  rankLadder: readonly string[];
  /** Absent when adding. */
  field?: AdminFieldView;
  onSaved: () => void;
};

export default function QuestionDialog({
  open,
  onClose,
  gameId,
  rankLadder,
  field,
  onSaved,
}: QuestionDialogProps) {
  const editing = Boolean(field);

  const [label, setLabel] = useState(field?.label ?? "");
  const [type, setType] = useState<ProfileFieldType>(field?.type ?? "select");
  const [optionText, setOptionText] = useState(
    (field?.options ?? []).map((option) => option.label).join("\n")
  );
  const [required, setRequired] = useState(field?.required ?? false);
  const [holdsRoles, setHoldsRoles] = useState(field?.holdsRoles ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many stored answers the new definition would not read, once counted.
   * Set means "the number is on screen"; saving again goes through with it.
   */
  const [stranded, setStranded] = useState<number | null>(null);
  const [previewValue, setPreviewValue] = useState<ProfileValue>(null);

  const info = fieldTypeInfo(type);
  const options = useMemo(() => normaliseOptions(optionText.split("\n")), [optionText]);

  const previewField = useMemo(
    () => ({
      id: "preview",
      key: "preview",
      label: label || "Your question",
      type,
      required,
      options,
      choices: choicesFor(type, options, rankLadder),
      value: null as ProfileValue,
    }),
    [label, type, required, options, rankLadder]
  );

  const input = fieldInputFrom({ label, type, options, required, holdsRoles });

  const save = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (editing && field) {
        // Count what this would strand before stranding it. `force` is the
        // second click, made with the number on screen. Nothing here deletes:
        // the number is how many answers the question stops being able to
        // show, and the admin is owed it before the save rather than after.
        if (!force) {
          const impact = await previewFieldEditAction(field.id, input);
          if (impact.invalidated > 0) {
            setStranded(impact.invalidated);
            return;
          }
        }
        const result = await updateFieldAction(field.id, input);
        if (!result.ok) return setError(result.error);
      } else {
        const result = await createFieldAction(gameId, input);
        if (!result.ok) return setError(result.error);
      }
      setStranded(null);
      onSaved();
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={editing ? "Edit question" : "New question"}
      title={label || (editing ? "Edit question" : "What do you want to ask?")}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="union"
            disabled={busy || !label.trim()}
            onClick={() => void save(false)}
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Add question"}
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}

      {stranded !== null && (
        <Alert tone="union">
          <span className="block font-medium">{strandedAnswerNotice(stranded).heading}</span>
          <span className="mt-1 block opacity-90">
            {strandedAnswerNotice(stranded).body}
          </span>
          <span className="mt-3 flex gap-2">
            <Button size="sm" variant="union" onClick={() => void save(true)} disabled={busy}>
              Save the change
            </Button>
            <Button size="sm" onClick={() => setStranded(null)} disabled={busy}>
              Leave it alone
            </Button>
          </span>
        </Alert>
      )}

      <Field
        label="Question"
        hint="What the member reads, e.g. “Preferred roles”"
        value={label}
        maxLength={60}
        autoFocus
        onChange={(event) => setLabel(event.target.value)}
      />

      <div>
        <Eyebrow className="mb-2 text-chalk/70">Answer type</Eyebrow>
        <ChoiceRow>
          {FIELD_TYPES.map((option) => (
            <ChoiceChip
              key={option.type}
              selected={option.type === type}
              onClick={() => {
                setType(option.type);
                setPreviewValue(null);
              }}
            >
              {option.label}
            </ChoiceChip>
          ))}
        </ChoiceRow>
        <p className="mt-2 text-12 text-muted">{info.hint}</p>
        {type === "text" && (
          <p className="mt-1 text-12 text-union">
            Free text is the last resort — a member has to type it in every time and nothing
            can validate it. Use it only where a list genuinely cannot be written down.
          </p>
        )}
        {type === "rank" && rankLadder.length === 0 && (
          <p className="mt-1 text-12 text-flare">
            {rankUnavailable(gameId === null ? null : THIS_GAME)}
          </p>
        )}
      </div>

      {info.needsOptions && (
        <Textarea
          label="Options"
          hint="One per line. The order here is the order of the buttons."
          className="h-32"
          value={optionText}
          onChange={(event) => setOptionText(event.target.value)}
        />
      )}

      {canHoldRoles(gameId, type) && (
        <Checkbox
          checked={holdsRoles}
          onChange={setHoldsRoles}
          label={
            <span className="block">
              <span className="block text-14 text-chalk">{ROLES_MARKER_LABEL}</span>
              <span className="mt-0.5 block text-13 leading-relaxed text-muted">
                A member&apos;s roles are read from the question with this tick, not from
                what the question is called — so renaming it is safe. If two are ticked,
                the first in the list is the one read.
              </span>
            </span>
          }
        />
      )}

      <div>
        <Eyebrow className="mb-2 text-chalk/70">Is it required?</Eyebrow>
        <ChoiceRow>
          <ChoiceChip selected={!required} onClick={() => setRequired(false)}>
            Optional
          </ChoiceChip>
          <ChoiceChip selected={required} onClick={() => setRequired(true)}>
            Required
          </ChoiceChip>
        </ChoiceRow>
        <p className="mt-2 text-12 text-muted">
          Required questions are counted on the member&apos;s profile and will gate event
          applications later. They never stop someone saving a half-finished profile.
        </p>
      </div>

      <Panel padding="sm" className="bg-ink/40">
        <Eyebrow className="mb-3">What the member sees</Eyebrow>
        <div className="mb-2 text-14 text-chalk/80">{previewField.label}</div>
        <FieldControl
          field={previewField}
          value={previewValue}
          onChange={(value) => setPreviewValue(value)}
        />
      </Panel>
    </Modal>
  );
}
