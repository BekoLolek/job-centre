"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Modal,
  Panel,
  plural,
} from "@/components/ui";
import type { ApplicantView, EventDetail } from "@/lib/events";
import { fieldTypeInfo, hasAnswer, normaliseOptions, valueStillValid } from "@/lib/profile-fields";
import { saveEventQuestionsAction } from "@/app/admin/events/actions";
import EventQuestionDialog, { type QuestionDraft } from "./EventQuestionDialog";
import SaveRow, { type SaveState } from "./SaveRow";
import type { LinkableField } from "./types";

/**
 * Questions — the application form builder (§6.3's "Form" tab).
 *
 * ## Why the whole list saves at once
 *
 * `setEventQuestions` replaces the set: it renumbers `sort`, rewrites keys
 * around the unique index, and re-validates every stored answer afterwards.
 * Doing that per question would run the answer sweep once per edit, which is
 * both slower and less honest — reordering three questions would report three
 * separate costs for one rearrangement. So edits are collected here and
 * committed together, and the list on screen is a draft until it is saved.
 *
 * ## Warning before the damage
 *
 * The tab already holds every application, so what an edit costs can be worked
 * out locally with `valueStillValid` — the same function `admin-games.ts` uses
 * server-side for `previewFieldEdit`, over the same stored values. That is why
 * there is no preview round trip here and there is one for days: the answers
 * are already on the page, the availability rows are not.
 */

export default function QuestionsTab({
  event,
  applicants,
  linkableFields,
  maxQuestions,
}: {
  event: EventDetail;
  applicants: ApplicantView[];
  linkableFields: LinkableField[];
  maxQuestions: number;
}) {
  const router = useRouter();

  const [questions, setQuestions] = useState<QuestionDraft[]>(() =>
    event.questions.map((question) => ({
      key: question.id,
      id: question.id,
      label: question.label,
      type: question.type,
      options: question.options.map((option) => option.label),
      required: question.required,
      profileFieldId: question.profileFieldId,
    }))
  );

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<QuestionDraft | null>(null);
  const [deleting, setDeleting] = useState<QuestionDraft | null>(null);
  const [confirmLoss, setConfirmLoss] = useState<number | null>(null);

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);

  const touch = () => {
    setState("dirty");
    setError(null);
    setNote(null);
  };

  /* --- Counting what an edit costs -------------------------------- */

  /** Stored answers to one existing question. */
  const answersTo = (questionId: string | undefined): number => {
    if (!questionId) return 0;
    return applicants.filter((row) => hasAnswer(row.answers[questionId])).length;
  };

  /** Of those, how many the draft definition would no longer accept. */
  const invalidatedBy = (draft: QuestionDraft): number => {
    if (!draft.id) return 0;
    const shape = {
      type: draft.type,
      label: draft.label,
      options: normaliseOptions(draft.options),
      rankLadder: event.rankLadder,
    };
    return applicants.filter((row) => {
      const value = row.answers[draft.id as string];
      if (value === undefined || !hasAnswer(value)) return false;
      return !valueStillValid(shape, value);
    }).length;
  };

  /** Everything the *whole* pending list would clear, deletions included. */
  const totalLoss = (): number => {
    const kept = new Set(questions.map((question) => question.id).filter(Boolean));
    const removed = event.questions
      .filter((question) => !kept.has(question.id))
      .reduce((total, question) => total + answersTo(question.id), 0);
    const retyped = questions.reduce((total, draft) => total + invalidatedBy(draft), 0);
    return removed + retyped;
  };

  /* --- List editing ------------------------------------------------ */

  const append = (draft: QuestionDraft) => {
    setQuestions((current) => [
      ...current,
      { ...draft, key: `new-${current.length}-${Date.now()}` },
    ]);
    touch();
  };

  const replace = (draft: QuestionDraft) => {
    setQuestions((current) =>
      current.map((question) => (question.key === draft.key ? draft : question))
    );
    touch();
  };

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= questions.length) return;
    setQuestions((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  const remove = (key: string) => {
    setQuestions((current) => current.filter((question) => question.key !== key));
    setDeleting(null);
    touch();
  };

  /* --- Saving ------------------------------------------------------ */

  const attemptSave = () => {
    const loss = totalLoss();
    if (loss > 0) {
      setConfirmLoss(loss);
      return;
    }
    void commit();
  };

  const commit = async () => {
    setState("saving");
    setError(null);
    setFieldErrors({});
    try {
      const result = await saveEventQuestionsAction(
        event.id,
        questions.map((question) => ({
          id: question.id,
          label: question.label,
          type: question.type,
          options: question.options,
          required: question.required,
          profileFieldId: question.profileFieldId,
        }))
      );

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.errors ?? {});
        setState("error");
        return;
      }

      setConfirmLoss(null);
      // Adopt the ids the server just wrote. Without this the tab still thinks
      // every question is new, so the next save would delete these rows and
      // insert fresh ones — and every answer given to them would go too.
      setQuestions(
        result.data.questions.map((question) => ({
          key: question.id as string,
          id: question.id,
          label: question.label,
          type: question.type as QuestionDraft["type"],
          options: question.options,
          required: question.required,
          profileFieldId: question.profileFieldId,
        }))
      );
      setNote(
        result.data.clearedAnswers > 0
          ? `Saved · ${plural(result.data.clearedAnswers, "answer")} cleared`
          : null
      );
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const linked = questions.filter((question) => question.profileFieldId !== null).length;
  const kept = new Set(questions.map((question) => question.id).filter(Boolean));
  const dropping = event.questions.filter((question) => !kept.has(question.id));

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Panel as="section" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Application form</Eyebrow>
          <Badge>
            {questions.length}/{maxQuestions}
          </Badge>
          {linked > 0 && <Badge tone="signal">{linked} prefilled from profiles</Badge>}
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Every question is a choice wherever it can be — a row of buttons, chips, a stepper,
          a rank picker (§2). A question <span className="text-signal">linked</span> to a
          profile field arrives already answered, which is what turns a returning player&apos;s
          application into: check, tap the days, submit.
        </p>

        {questions.length === 0 ? (
          <EmptyState>
            No questions. That is a perfectly good event — applicants just sign up, and
            answer the availability question if you have given it days.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hair/60 border border-hair">
            {questions.map((question, index) => {
              const answers = answersTo(question.id);
              const invalid = invalidatedBy(question);
              const link = linkableFields.find((field) => field.id === question.profileFieldId);
              const problem = fieldErrors[question.id ?? `new-${index}`];

              return (
                <li key={question.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="num w-6 shrink-0 text-xs text-muted">{index + 1}</span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{question.label}</span>
                    <span className="eyebrow mt-0.5 block truncate">
                      {fieldTypeInfo(question.type).label}
                      {question.options.length > 0 &&
                        ` · ${plural(question.options.length, "option")}`}
                      {link && ` · prefills from ${link.label}`}
                    </span>
                    {problem && <span className="mt-1 block text-xs text-ember">{problem}</span>}
                  </span>

                  {question.profileFieldId && <Badge tone="signal">Prefilled</Badge>}
                  {question.required && <Badge tone="gold">Required</Badge>}
                  {!question.id && <Badge tone="gold">New</Badge>}
                  {answers > 0 && (
                    <Badge tone={invalid > 0 ? "ember" : "default"}>
                      {invalid > 0
                        ? `${invalid}/${answers} answers at risk`
                        : plural(answers, "answer")}
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
                    <Button size="sm" onClick={() => setEditing(question)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ember"
                      onClick={() =>
                        answers > 0 ? setDeleting(question) : remove(question.key)
                      }
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {dropping.length > 0 && (
          <Alert tone="gold">
            {plural(dropping.length, "question")} will be deleted when you save, along with{" "}
            {plural(
              dropping.reduce((total, question) => total + answersTo(question.id), 0),
              "stored answer"
            )}
            . Nothing has been removed yet.
          </Alert>
        )}

        <SaveRow
          state={state}
          note={note}
          onSave={attemptSave}
          label="Save questions"
        >
          <Button
            size="sm"
            disabled={questions.length >= maxQuestions}
            onClick={() => setAdding(true)}
          >
            + Add a question
          </Button>
        </SaveRow>
      </Panel>

      {adding && (
        <EventQuestionDialog
          open
          rankLadder={event.rankLadder}
          linkableFields={linkableFields}
          invalidatedBy={invalidatedBy}
          onClose={() => setAdding(false)}
          onSave={append}
        />
      )}

      {editing && (
        <EventQuestionDialog
          open
          draft={editing}
          rankLadder={event.rankLadder}
          linkableFields={linkableFields}
          invalidatedBy={invalidatedBy}
          onClose={() => setEditing(null)}
          onSave={replace}
        />
      )}

      {/* --- Removing a question that has answers ------------------- */}
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        size="sm"
        eyebrow="Remove question"
        title={deleting?.label ?? ""}
        footer={
          <>
            <Button size="sm" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="ember"
              onClick={() => deleting && remove(deleting.key)}
            >
              Remove it
            </Button>
          </>
        }
      >
        {deleting && (
          <Alert tone="ember">
            <span className="block font-medium">
              {plural(answersTo(deleting.id), "applicant")} answered this
            </span>
            <span className="mt-1 block opacity-90">
              Removing it takes their answers with it when you save. Nothing is written
              until then.
            </span>
          </Alert>
        )}
      </Modal>

      {/* --- The commit confirm ------------------------------------- */}
      <Modal
        open={confirmLoss !== null}
        onClose={() => setConfirmLoss(null)}
        size="sm"
        eyebrow="Before this is saved"
        title="This clears stored answers"
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmLoss(null)}>
              Leave it alone
            </Button>
            <Button
              size="sm"
              variant="ember"
              disabled={state === "saving"}
              onClick={() => void commit()}
            >
              {state === "saving" ? "Saving…" : "Clear them and save"}
            </Button>
          </>
        }
      >
        <Alert tone="ember">
          <span className="block font-medium">
            {plural(confirmLoss ?? 0, "answer")} will be removed
          </span>
          <span className="mt-1 block opacity-90">
            Questions you deleted, and questions whose new definition no longer accepts what
            people already said. There is no undo, and nothing has been changed yet.
          </span>
        </Alert>
      </Modal>
    </div>
  );
}
