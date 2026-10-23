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
 * What removing one question actually costs, in the admin's terms (UC-08 8).
 *
 * The honest version of "are you sure?", and the two halves are honest about
 * different things: an own question's answers really do go (R-53's edits were
 * stored on the application), while a linked question's answer is the member's
 * profile answer and is not this event's to take (R-11).
 *
 * Exported as a function of the count rather than written into the modal's JSX
 * for the reason `strandedAnswerNotice` is: the dialog is only on screen after
 * a click a static render cannot make, and these are the sentences that have to
 * be **true**. The linked half is checked by `question-copy.test.ts`'s
 * destructive-wording scan, because it is the half that must never claim a loss
 * — `setEventQuestions` deletes the question row and `clearOrphanedAnswers`
 * touches `applications.answers` only, so a `profile_values` row cannot be
 * reached from here at all.
 */
export function removeQuestionNotice(question: {
  /** True when the answer shown under it is the member's profile answer. */
  linked: boolean;
  /** Stored answers for an own question; profile answers for a linked one. */
  answers: number;
}): { heading: string; body: string } {
  if (question.linked) {
    return {
      heading: `${plural(question.answers, "applicant")} answered this on their profile`,
      body:
        "That answer belongs to their profile and stays there, so this takes nothing with " +
        "it: they keep it, every other event asking for the same detail still reads it, " +
        "and they will not be asked again. Removing it only stops this event asking.",
    };
  }
  return {
    heading: `${plural(question.answers, "applicant")} answered this`,
    body:
      "Removing it takes their answers with it when you save. Nothing is written until then.",
  };
}

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
 *
 * ## A linked question has no answers to cost (R-11, Task 10)
 *
 * `ApplicantView.answers` is **composed**: `linkedAnswers` reads a linked
 * question's answer out of `profile_values` on every read, because that is
 * where it lives. So counting `applicants[].answers[id]` for a linked question
 * counts profile answers, and every number this tab works out from it would be
 * a cost nobody is going to pay — `clearOrphanedAnswers` has nothing to clear,
 * and the save would report "0 answers cleared" a second after the dialog said
 * three were at risk.
 *
 * Hence two counts, and the difference between them is the point:
 * `answersTo` is what is **stored here** (zero for a linked question) and
 * drives every warning and the save confirm, while `profileAnswersTo` is what
 * the member holds on their profile and is only ever used to say that it stays
 * there. Copy that talks an admin out of a safe action is the failure
 * `question-copy.test.ts` exists to prevent one screen over, so the linked
 * wording is scanned by that file too.
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

  /** A question as either list holds it: a draft, or a stored row. */
  type Counted = { id?: string; profileFieldId: string | null };

  /**
   * Answers **stored against** one existing question.
   *
   * Zero for a linked question, always: its answer is a `profile_values` row
   * composed in on read, and nothing is written under its id. Skipped rather
   * than counted and subtracted, because the composed map cannot tell a
   * profile answer from a legacy stored copy — and the copy is dropped on read
   * and cleared by the next write anyway, so neither is a cost of removing it.
   */
  const answersTo = (question: Counted): number => {
    if (!question.id || question.profileFieldId !== null) return 0;
    const questionId = question.id;
    return applicants.filter((row) => hasAnswer(row.answers[questionId])).length;
  };

  /**
   * Applicants who have answered a **linked** question on their profile.
   *
   * Not a cost: the only thing it is ever used to say is that those answers
   * stay where they are (`removeQuestionNotice`).
   */
  const profileAnswersTo = (question: Counted): number => {
    if (!question.id || question.profileFieldId === null) return 0;
    const questionId = question.id;
    return applicants.filter((row) => hasAnswer(row.answers[questionId])).length;
  };

  /** Of the stored ones, how many the draft definition would no longer accept. */
  const invalidatedBy = (draft: QuestionDraft): number => {
    if (!draft.id || draft.profileFieldId !== null) return 0;
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
      .reduce((total, question) => total + answersTo(question), 0);
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

  /** What the remove dialog says about the question it is open over. */
  const removal = deleting
    ? removeQuestionNotice({
        linked: deleting.profileFieldId !== null,
        answers:
          deleting.profileFieldId === null
            ? answersTo(deleting)
            : profileAnswersTo(deleting),
      })
    : null;

  const linked = questions.filter((question) => question.profileFieldId !== null).length;
  const kept = new Set(questions.map((question) => question.id).filter(Boolean));
  const dropping = event.questions.filter((question) => !kept.has(question.id));

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Application form</Eyebrow>
          <Badge>
            {questions.length}/{maxQuestions}
          </Badge>
          {linked > 0 && <Badge tone="success">{linked} prefilled from profiles</Badge>}
        </div>

        <p className="text-12 leading-relaxed text-muted">
          Every question is a choice wherever it can be — a row of buttons, chips, a stepper,
          a rank picker (§2). A question <span className="text-body">linked</span> to a
          profile field arrives already answered, which is what turns a returning player&apos;s
          application into: check, tap the days, submit.
        </p>

        {questions.length === 0 ? (
          <EmptyState>
            No questions. That is a perfectly good event — applicants just sign up, and
            answer the availability question if you have given it days.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
            {questions.map((question, index) => {
              const answers = answersTo(question);
              const fromProfiles = profileAnswersTo(question);
              const invalid = invalidatedBy(question);
              const link = linkableFields.find((field) => field.id === question.profileFieldId);
              const problem = fieldErrors[question.id ?? `new-${index}`];

              return (
                <li key={question.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="num w-6 shrink-0 text-12 text-muted">{index + 1}</span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-14">{question.label}</span>
                    <Eyebrow as="span" className="mt-0.5 block truncate text-inherit">
                      {fieldTypeInfo(question.type).label}
                      {question.options.length > 0 &&
                        ` · ${plural(question.options.length, "option")}`}
                      {link && ` · prefills from ${link.label}`}
                    </Eyebrow>
                    {problem && <span className="mt-1 block text-12 text-flare">{problem}</span>}
                  </span>

                  {question.profileFieldId && <Badge tone="success">Prefilled</Badge>}
                  {question.required && <Badge tone="union">Required</Badge>}
                  {!question.id && <Badge tone="union">New</Badge>}
                  {answers > 0 && (
                    <Badge tone={invalid > 0 ? "flare" : "default"}>
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
                      variant="flare"
                      onClick={() =>
                        // The dialog is for a question there is something to
                        // say about: answers that really would go, or a
                        // profile answer the admin might fear for. Neither,
                        // and removing a draft row needs no ceremony.
                        answers > 0 || fromProfiles > 0
                          ? setDeleting(question)
                          : remove(question.key)
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
          <Alert tone="union">
            {plural(dropping.length, "question")} will be deleted when you save, along with{" "}
            {plural(
              dropping.reduce((total, question) => total + answersTo(question), 0),
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

      {/* --- Removing a question somebody has answered -------------- */}
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
              variant="flare"
              onClick={() => deleting && remove(deleting.key)}
            >
              Remove it
            </Button>
          </>
        }
      >
        {deleting && removal && (
          /*
            `union` rather than `flare` for a linked question: nothing is lost,
            so the loudest tone on the page would be the dialog arguing with its
            own words.
          */
          <Alert tone={deleting.profileFieldId === null ? "flare" : "union"}>
            <span className="block font-medium">{removal.heading}</span>
            <span className="mt-1 block opacity-90">{removal.body}</span>
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
              variant="flare"
              disabled={state === "saving"}
              onClick={() => void commit()}
            >
              {state === "saving" ? "Saving…" : "Clear them and save"}
            </Button>
          </>
        }
      >
        <Alert tone="flare">
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
