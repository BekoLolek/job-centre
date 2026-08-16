"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Button,
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
import type { ProfileFieldType, ProfileValue } from "@/db/schema";
import type { AdminFieldView } from "@/lib/admin-games";
import { FIELD_TYPES, choicesFor, fieldTypeInfo, normaliseOptions } from "@/lib/profile-fields";
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
 * The preview underneath is live and is the real control, `FieldControl`, with
 * the draft definition fed into it. It is what makes "add REPO with two
 * questions" a minute's work: you can see the chips a member will tap before
 * saving anything, so a badly-worded option gets fixed here rather than after
 * forty people have answered it.
 *
 * Editing a question that already has answers goes through a second step:
 * `previewFieldEdit` says how many the change would invalidate, and nothing is
 * written until that number has been read and accepted.
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the edit would clear answers: the second, deliberate click. */
  const [confirmLoss, setConfirmLoss] = useState<number | null>(null);
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

  const input = {
    label,
    type,
    options: options.map((option) => option.label),
    required,
  };

  const save = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (editing && field) {
        // Count what this would destroy before destroying it. `force` is the
        // second click, made with the number on screen.
        if (!force) {
          const impact = await previewFieldEditAction(field.id, input);
          if (impact.invalidated > 0) {
            setConfirmLoss(impact.invalidated);
            return;
          }
        }
        const result = await updateFieldAction(field.id, input);
        if (!result.ok) return setError(result.error);
      } else {
        const result = await createFieldAction(gameId, input);
        if (!result.ok) return setError(result.error);
      }
      setConfirmLoss(null);
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
            variant="gold"
            disabled={busy || !label.trim()}
            onClick={() => void save(false)}
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Add question"}
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}

      {confirmLoss !== null && (
        <Alert tone="ember">
          <span className="block font-medium">
            This change clears {plural(confirmLoss, "stored answer")}
          </span>
          <span className="mt-1 block opacity-90">
            The new definition does not accept what those members already said, so those
            answers would be removed. Nothing has been changed yet.
          </span>
          <span className="mt-3 flex gap-2">
            <Button size="sm" variant="ember" onClick={() => void save(true)} disabled={busy}>
              Clear them and save
            </Button>
            <Button size="sm" onClick={() => setConfirmLoss(null)} disabled={busy}>
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
        <p className="mt-2 text-xs text-muted">{info.hint}</p>
        {type === "text" && (
          <p className="mt-1 text-xs text-gold/80">
            Free text is the last resort — a member has to type it in every time and nothing
            can validate it. Use it only where a list genuinely cannot be written down.
          </p>
        )}
        {type === "rank" && rankLadder.length === 0 && (
          <p className="mt-1 text-xs text-ember">
            This game has no rank ladder yet, so a rank question would have nothing to
            offer. Add the ranks first.
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
        <p className="mt-2 text-xs text-muted">
          Required questions are counted on the member&apos;s profile and will gate event
          applications later. They never stop someone saving a half-finished profile.
        </p>
      </div>

      <Panel padding="sm" className="bg-ink/40">
        <Eyebrow className="mb-3">What the member sees</Eyebrow>
        <div className="mb-2 text-sm text-chalk/80">{previewField.label}</div>
        <FieldControl
          field={previewField}
          value={previewValue}
          onChange={(value) => setPreviewValue(value)}
        />
      </Panel>
    </Modal>
  );
}
