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
import { FIELD_TYPES, choicesFor, fieldTypeInfo, normaliseOptions } from "@/lib/profile-fields";
import type { LinkableField } from "./types";

/**
 * Add or edit one application question.
 *
 * The same three decisions as `/admin/games`' question dialog — label, answer
 * type, required — plus the one that only exists here and is the whole reason
 * the profile exists (§2, §7):
 *
 * ## The profile link
 *
 * A question carrying a `profileFieldId` arrives at the member **already
 * answered**, filled from what they told us last time, and they check it rather
 * than retype it. That is the difference between this and the Google Form it
 * replaces, so the link sits at the top of the dialog in its own panel rather
 * than buried under the options as an advanced setting.
 *
 * Only fields the event may prefill from are offered — its game's, plus the
 * global ones — because `setEventQuestions` refuses anything else, and a field
 * belonging to another game would prefill an answer given about a different
 * game entirely. Picking one whose type differs is refused for the same reason:
 * a `rank` answer cannot fill a `number` box.
 *
 * The live preview underneath is the real member control with the draft
 * definition fed into it, so a badly-worded option gets fixed here rather than
 * after forty people have answered it.
 */

export type QuestionDraft = {
  key: string;
  id?: string;
  label: string;
  type: ProfileFieldType;
  /** Plain labels, one per line in the box. */
  options: string[];
  required: boolean;
  profileFieldId: string | null;
};

export type EventQuestionDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Absent when adding. */
  draft?: QuestionDraft;
  /** The event's ladder, so a `rank` preview has something to show. */
  rankLadder: readonly string[];
  linkableFields: LinkableField[];
  /**
   * How many stored answers this edit would invalidate, given the draft. The
   * tab computes it from the applications it already holds — no round trip.
   */
  invalidatedBy: (draft: QuestionDraft) => number;
  onSave: (draft: QuestionDraft) => void;
};

export default function EventQuestionDialog({
  open,
  onClose,
  draft,
  rankLadder,
  linkableFields,
  invalidatedBy,
  onSave,
}: EventQuestionDialogProps) {
  const editing = Boolean(draft?.id);

  const [label, setLabel] = useState(draft?.label ?? "");
  const [type, setType] = useState<ProfileFieldType>(draft?.type ?? "select");
  const [optionText, setOptionText] = useState((draft?.options ?? []).join("\n"));
  const [required, setRequired] = useState(draft?.required ?? false);
  const [profileFieldId, setProfileFieldId] = useState(draft?.profileFieldId ?? null);
  const [previewValue, setPreviewValue] = useState<ProfileValue>(null);
  const [confirmLoss, setConfirmLoss] = useState<number | null>(null);

  const info = fieldTypeInfo(type);
  const options = useMemo(() => normaliseOptions(optionText.split("\n")), [optionText]);

  const linked = linkableFields.find((field) => field.id === profileFieldId) ?? null;
  // A link only holds while the types match, so switching the answer type drops
  // it rather than saving something the server would refuse.
  const linkStillValid = linked === null || linked.type === type;

  const current: QuestionDraft = {
    key: draft?.key ?? "new",
    id: draft?.id,
    label,
    type,
    options: options.map((option) => option.label),
    required,
    profileFieldId: linkStillValid ? profileFieldId : null,
  };

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

  const problem = (): string | null => {
    if (!label.trim()) return "Give the question a label.";
    if (info.needsOptions && options.length === 0) {
      return "A pick-one or pick-any question needs at least one option.";
    }
    if (info.usesRankLadder && rankLadder.length === 0) {
      return "A rank question needs an event whose game has a rank ladder.";
    }
    return null;
  };

  const commit = (force: boolean) => {
    if (problem()) return;
    if (!force) {
      const invalidated = invalidatedBy(current);
      if (invalidated > 0) {
        setConfirmLoss(invalidated);
        return;
      }
    }
    onSave(current);
    onClose();
  };

  const blocked = problem();

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={editing ? "Edit question" : "New question"}
      title={label || (editing ? "Edit question" : "What do you want to ask?")}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="gold" disabled={Boolean(blocked)} onClick={() => commit(false)}>
            {editing ? "Save question" : "Add question"}
          </Button>
        </>
      }
    >
      {blocked && <Alert tone="gold">{blocked}</Alert>}

      {confirmLoss !== null && (
        <Alert tone="ember">
          <span className="block font-medium">
            This change clears {plural(confirmLoss, "stored answer")}
          </span>
          <span className="mt-1 block opacity-90">
            The new definition does not accept what those applicants already said. Nothing is
            written until you save the whole question list.
          </span>
          <span className="mt-3 flex gap-2">
            <Button size="sm" variant="ember" onClick={() => commit(true)}>
              Change it anyway
            </Button>
            <Button size="sm" onClick={() => setConfirmLoss(null)}>
              Leave it alone
            </Button>
          </span>
        </Alert>
      )}

      <Field
        label="Question"
        hint="What the applicant reads, e.g. “Which nights suit you best?”"
        value={label}
        maxLength={120}
        autoFocus
        onChange={(input) => setLabel(input.target.value)}
      />

      {/* --- The profile link -------------------------------------- */}
      <Panel padding="sm" className="space-y-3 bg-ink/40">
        <div className="flex flex-wrap items-baseline gap-2">
          <Eyebrow className="text-chalk/70">Prefill from the profile</Eyebrow>
          {linked && linkStillValid && (
            <span className="eyebrow text-signal">Linked · answered in advance</span>
          )}
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Link this to a profile question and the application arrives with the member&apos;s
          stored answer already in it — they check it instead of typing it again. That is
          the whole reason the profile exists.
        </p>

        {linkableFields.length === 0 ? (
          <p className="text-xs text-gold/80">
            Nothing to link to: this event has no game, or its game has no profile questions
            yet. Add them under Admin → Games.
          </p>
        ) : (
          <ChoiceRow>
            <ChoiceChip
              selected={profileFieldId === null}
              onClick={() => setProfileFieldId(null)}
            >
              Ask it fresh
            </ChoiceChip>
            {linkableFields.map((field) => {
              const matches = field.type === type;
              return (
                <ChoiceChip
                  key={field.id}
                  selected={profileFieldId === field.id}
                  // Never disabled on a type mismatch. `setEventQuestions` does
                  // refuse a link whose types differ — but the fix for that is to
                  // *adopt* the profile field's shape, which is what the click
                  // below does, not to make the link unreachable until the admin
                  // has guessed the right type first.
                  title={
                    matches
                      ? `${field.scope} · ${field.key}`
                      : `Linking this switches the answer type to ${fieldTypeInfo(field.type).label}, so it matches “${field.label}”.`
                  }
                  onClick={() => {
                    setProfileFieldId(field.id);
                    setType(field.type);
                    setPreviewValue(null);
                    // Take its options too: a linked pick-one that offers
                    // different choices from the profile's would store answers
                    // the profile could never have prefilled.
                    setOptionText(field.options.map((option) => option.label).join("\n"));
                  }}
                >
                  {field.label}
                  <span className="ml-1.5 font-mono text-[10px] opacity-60">{field.scope}</span>
                  {!matches && <span className="ml-1.5 text-[10px] text-gold">↻</span>}
                </ChoiceChip>
              );
            })}
          </ChoiceRow>
        )}

        {linked && !linkStillValid && (
          <p className="text-xs text-ember">
            {linked.label} is a {fieldTypeInfo(linked.type).label} question, so it can no
            longer prefill this one. Saving now asks the question fresh.
          </p>
        )}
      </Panel>

      {/* --- Type --------------------------------------------------- */}
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
            Free text is the last resort — an applicant has to type it every time and nothing
            can validate it. Use it only where a list genuinely cannot be written down.
          </p>
        )}
        {type === "rank" && rankLadder.length === 0 && (
          <p className="mt-1 text-xs text-ember">
            This event has no game with a rank ladder, so a rank question would have nothing
            to offer. Pick a game on the Basics tab first.
          </p>
        )}
      </div>

      {info.needsOptions && (
        <Textarea
          label="Options"
          hint="One per line. The order here is the order of the buttons."
          className="h-32"
          value={optionText}
          onChange={(input) => setOptionText(input.target.value)}
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
          Unlike on a profile, required here is a hard gate: an application missing one is
          refused. A linked question counts as answered when the profile has it.
        </p>
      </div>

      <Panel padding="sm" className="bg-ink/40">
        <Eyebrow className="mb-3">What the applicant sees</Eyebrow>
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
