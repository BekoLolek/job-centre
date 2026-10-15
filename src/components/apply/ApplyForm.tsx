"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import FieldControl from "@/components/profile/FieldControl";
import { AVAILABILITY_CHOICES, EventDateRange } from "@/components/events";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Panel,
  cx,
  plural,
} from "@/components/ui";
import type { AvailabilityState, EntryMode, ProfileValue } from "@/db/schema";
import { dayName } from "@/lib/events-policy";
import type { AnsweredQuestionView } from "@/lib/events";
import LocalTime from "@/components/format/LocalTime";
import type { ProfileFieldView, ProfileSectionView } from "@/lib/profile";
import { GLOBAL_SECTION_KEY, formatAnswer, hasAnswer } from "@/lib/profile-fields";
import {
  applyToEventAction,
  editApplicationAction,
} from "@/app/events/[slug]/apply/actions";
import { detailWrites } from "./writes";

/**
 * The application form — the page this whole project exists to make painless.
 *
 * ## The three taps
 *
 * docs/platform-plan.md §2: *"A returning player's application should be: check
 * the prefilled profile is still right, tap the days you can make, submit."*
 * That is the literal design of this component, and for a member whose profile
 * is filled in it really is three taps and no typing:
 *
 *   1. **"Yes, still right"** on the profile block, which arrives already
 *      answered — every value shown as a sentence rather than as a control,
 *      because a control invites fiddling with an answer that was already
 *      correct.
 *   2. **"I can make every day"**, or one tap per day if it is more complicated
 *      than that.
 *   3. **Apply.**
 *
 * Anything they *do* want to change is one more tap to open that row's control
 * — the same click-first controls `/me/profile` uses, not a second
 * implementation — and editing a row counts as having checked it.
 *
 * ## The profile block is the profile, not a copy of it
 *
 * UC-12 2 shows the member their **saved profile details for the event's game**,
 * all of them, and UC-12 3a says an edit here is saved to their profile. So
 * that is where it goes and nowhere else (R-11): the event's application stores
 * answers to the event's *own* questions, and a detail the event wants from the
 * profile is read from the profile every time anybody looks. There is no
 * snapshot. A snapshot would be a second copy of an answer, which is the thing
 * the domain model forbids (docs/domain-model.md:335 — nothing derived is
 * stored), and it would be the copy a manager read while the member looked at
 * the other one.
 *
 * What the member taps is therefore two different writes behind one button:
 * details they **changed** are saved, details they **left alone** are stamped
 * as confirmed (R-49). The second one is why `confirmed_at` exists — without it
 * a filled-in profile produces no evidence that anybody ever looked.
 *
 * ## Asking for what is missing, inline
 *
 * A required detail with no answer (UC-12 2b) and an answer the question has
 * outgrown both arrive with their control already open, because they are the
 * two cases the member cannot resolve by reading. Everything else stays a
 * sentence. The submit button will not go until the missing ones are filled in,
 * and `applyToEvent` refuses it regardless — the client stops the obvious so
 * the round trip is not wasted, and the server decides.
 *
 * ## Editing an application that is already in
 *
 * Same form, `mode: "edit"` (R-53 / UC-13 3). It saves and stays rather than
 * navigating, no seat moves, and the button says so. Whether to offer it at all
 * is the page's decision, taken from `canEditAnswers` — and whether to *accept*
 * it is `editApplicationAnswers`', taken again under the event's row lock,
 * because this form being on screen proves nothing about whether sign-ups were
 * still open when the member pressed the button.
 *
 * ## What is not here
 *
 * No validation rules. The client stops the obvious ("that required question
 * has no answer") so the round trip is not wasted, but the server re-reads the
 * questions, the details, the ladder and the seat count inside a row lock and
 * refuses anything it does not like. If the two ever disagree the server wins,
 * and its per-row errors land back on the right rows — profile details keyed by
 * field id, event questions by question id, which is why the two maps are kept
 * apart all the way down.
 */

export type ApplyDay = {
  id: string;
  dayIndex: number;
  label: string | null;
  /** ISO, because a Date does not survive the props of a client component well. */
  startsAt: string | null;
};

export type ApplyFormProps = {
  eventId: string;
  slug: string;
  /** Applying for the first time, or changing answers already stored. */
  mode: "apply" | "edit";
  /** The member's profile for this event's game, plus the global details. */
  profile: ProfileSectionView[];
  /** The event's own questions. Linked ones are in `profile`, not here. */
  questions: AnsweredQuestionView[];
  days: ApplyDay[];
  /** The event's game ladder, for rendering a `rank` answer back. */
  rankLadder: string[];
  /** Their existing per-day answers, when they are re-applying or editing. */
  availability: Record<string, AvailabilityState>;
  /** True when the seats are gone and this application joins the queue (§14). */
  willWaitlist: boolean;
  /**
   * How this event's applications land (R-27). `approval` means submitting
   * hands the application to a manager rather than taking a seat, which is the
   * one thing the member has to know *before* they press the button — so it is
   * a prop rather than something inferred from `willWaitlist`, which
   * `applicationsOpen` leaves false for an approval event whether or not there
   * is a seat behind it.
   */
  entryMode: EntryMode;
};

/** One detail, with the section it came from — the flat list the form works on. */
type DetailRow = ProfileFieldView & { sectionKey: string; sectionName: string };

export default function ApplyForm({
  eventId,
  slug,
  mode,
  profile,
  questions,
  days,
  rankLadder,
  availability: initialAvailability,
  willWaitlist,
  entryMode,
}: ApplyFormProps) {
  const router = useRouter();

  const details = useMemo<DetailRow[]>(
    () =>
      profile.flatMap((section) =>
        section.fields.map((field) => ({
          ...field,
          sectionKey: section.key,
          sectionName: section.name,
        }))
      ),
    [profile]
  );

  const [detailValues, setDetailValues] = useState<Record<string, ProfileValue>>(() => {
    const start: Record<string, ProfileValue> = {};
    for (const detail of details) start[detail.id] = detail.value;
    return start;
  });
  const [answers, setAnswers] = useState<Record<string, ProfileValue>>(() => {
    const start: Record<string, ProfileValue> = {};
    for (const question of questions) start[question.id] = question.value;
    return start;
  });
  const [availability, setAvailability] =
    useState<Record<string, AvailabilityState>>(initialAvailability);

  /**
   * Detail rows whose control is open. A detail that needs the member — a
   * required blank (UC-12 2b) or an answer its question has outgrown — starts
   * open, because those are the two they cannot deal with by reading.
   */
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const start: Record<string, boolean> = {};
    for (const detail of details) if (detail.attention !== null) start[detail.id] = true;
    return start;
  });
  /** Details the member actually changed. Only these are written as values. */
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [confirmed, setConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Split once, on the *incoming* state rather than the current one, so filling
  // in a blank does not make the row jump out of the "needs you" block mid-form.
  const { settled, needed } = useMemo(() => {
    const settled: DetailRow[] = [];
    const needed: DetailRow[] = [];
    for (const detail of details) {
      (detail.attention === null && hasAnswer(detail.value) ? settled : needed).push(detail);
    }
    return { settled, needed };
  }, [details]);

  const clearError = (id: string) =>
    setErrors((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  const changeDetail = (id: string, value: ProfileValue) => {
    setDetailValues((current) => ({ ...current, [id]: value }));
    setTouched((current) => ({ ...current, [id]: true }));
    clearError(id);
    setSaved(false);
    // Touching an answer is a stronger form of checking it than pressing the
    // confirm button, so it counts as both.
    setConfirmed(true);
  };

  const changeAnswer = (id: string, value: ProfileValue) => {
    setAnswers((current) => ({ ...current, [id]: value }));
    clearError(id);
    setSaved(false);
  };

  /** Required rows with nothing in them — the ones the server will refuse. */
  const missing = [
    ...details.filter(
      (detail) => detail.required && !hasAnswer(detailValues[detail.id] ?? null)
    ),
    ...questions.filter(
      (question) => question.required && !hasAnswer(answers[question.id] ?? null)
    ),
  ];

  const everyDayYes =
    days.length > 0 && days.every((day) => availability[day.id] === "yes");

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    setErrors({});
    try {
      const answerPayload: Record<string, unknown> = {};
      for (const question of questions) answerPayload[question.id] = answers[question.id] ?? null;

      // Two halves of one tap: what they changed is written, what they left
      // alone is stamped (R-49) — and nothing is stamped unless they said so,
      // which in `mode: "edit"` is the only thing stopping a day-chip change
      // from vouching for the member's whole profile. The rule is
      // `detailWrites`, where it can be tested.
      const { details: detailPayload, confirming } = detailWrites({
        details,
        values: detailValues,
        touched,
        confirmed,
      });

      const input = {
        eventId,
        slug,
        answers: answerPayload,
        details: detailPayload,
        confirmed: confirming,
        availability,
      };

      const result =
        mode === "edit" ? await editApplicationAction(input) : await applyToEventAction(input);

      if (!result.ok) {
        setProblem(result.error);
        setErrors(result.errors ?? {});
        // A row that failed has to be reachable, so open every detail that has
        // an error on it — including ones the member had never opened.
        setOpen((current) => ({
          ...current,
          ...Object.fromEntries(Object.keys(result.errors ?? {}).map((id) => [id, true])),
        }));
        setBusy(false);
        return;
      }

      if (mode === "edit") {
        // Nothing moves them off this page: they came here to change one answer
        // and may want to change another. `router.refresh()` re-reads the
        // profile so the sentences they are looking at are the stored ones.
        setSaved(true);
        setTouched({});
        setBusy(false);
        router.refresh();
        return;
      }

      // Note there is no `setBusy(false)` on the way out: the navigation below
      // is what ends this form's life, and re-enabling the button first is how
      // an impatient second tap becomes a second application.

      // Where the news is broken, and why it is not broken here: submitting
      // makes this page render the edit form instead, so a success panel in
      // this component would be replaced a frame later. The confirmation is
      // therefore server-rendered on the page they land on, from the stored
      // application rather than from this component's memory of it.
      router.replace(`/me/events?applied=${encodeURIComponent(slug)}`);
    } catch {
      setProblem(
        mode === "edit"
          ? "Could not reach the server, so nothing was saved. Try again."
          : "Could not reach the server, so nothing was submitted. Try again."
      );
      setBusy(false);
    }
  };

  /* --- One detail row ------------------------------------------------ */

  const detailRow = (detail: DetailRow, startOpen: boolean) => {
    const value = detailValues[detail.id] ?? null;
    const isOpen = open[detail.id] === true || startOpen;
    const shape = {
      type: detail.type,
      label: detail.label,
      options: detail.options,
      rankLadder: detail.sectionKey === GLOBAL_SECTION_KEY ? [] : rankLadder,
    };

    return (
      <div key={detail.id} className="px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="eyebrow text-chalk/70">{detail.label}</span>

          {detail.attention === "stale" && (
            <Badge tone="union">Question changed</Badge>
          )}
          {detail.attention === "missing" && <Badge tone="union">Needed</Badge>}

          {!isOpen && (
            <span
              className={cx("num text-14", hasAnswer(value) ? "text-chalk" : "text-muted")}
            >
              {formatAnswer(shape, value)}
            </span>
          )}

          {/*
            When they last said this one is right (R-49 / UC-12 3). It is the
            answer to the question this block asks — "is this still true?" — and
            a member looking at "confirmed in March" knows which rows to read
            properly. `LocalTime` because no instant is formatted on the server.
          */}
          {!isOpen && detail.confirmedAt !== null && hasAnswer(value) && (
            <span className="text-12 text-muted">
              confirmed <LocalTime at={detail.confirmedAt} format="day" />
            </span>
          )}

          {!startOpen && (
            <button
              type="button"
              className="ml-auto text-12 text-muted underline underline-offset-4 hover:text-union"
              onClick={() =>
                setOpen((current) => ({ ...current, [detail.id]: !isOpen }))
              }
            >
              {isOpen ? "Done" : "Change"}
            </button>
          )}
        </div>

        {detail.attention === "stale" && (
          <p className="mt-2 text-12 leading-relaxed text-muted">
            This question has changed since you answered it, so your old answer cannot be
            read any more. It is still saved — pick again and it is replaced.
          </p>
        )}

        {isOpen && (
          <div className="mt-3">
            <FieldControl
              field={{ ...detail, value }}
              value={value}
              onChange={(next) => changeDetail(detail.id, next)}
            />
          </div>
        )}

        {errors[detail.id] && (
          <p className="mt-2 text-12 text-flare">{errors[detail.id]}</p>
        )}
      </div>
    );
  };

  /* --- The form ------------------------------------------------------ */

  return (
    <div className="space-y-5">
      {problem && <Alert>{problem}</Alert>}

      {saved && (
        <Alert tone="union">
          <span className="block font-medium">Saved</span>
          <span className="mt-1 block opacity-90">
            Your answers are updated and your place is exactly where it was — changing an
            answer does not move you in any queue.
          </span>
        </Alert>
      )}

      {/* --- 1. The profile, as it stands, confirmed in one tap -------- */}
      {settled.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-20 leading-none">Your details</h2>
            <Badge tone={confirmed ? "success" : "union"}>
              {confirmed ? "Checked" : "Needs a look"}
            </Badge>
            <span className="ml-auto text-12 text-muted">
              {plural(settled.length, "answer")} from your profile
            </span>
          </div>

          <div className="divide-y divide-hair/60">
            {settled.map((detail) => detailRow(detail, false))}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-hair px-5 py-4">
            <Button
              variant={confirmed ? "default" : "union"}
              onClick={() => setConfirmed(true)}
              disabled={confirmed}
            >
              {confirmed ? "✓ Confirmed" : "Yes, that's all still right"}
            </Button>
            <p className="text-12 leading-relaxed text-muted">
              These are your profile, not a copy of it — changing one here changes it
              everywhere, and one tap says they are still true.
            </p>
          </div>
        </Panel>
      )}

      {/* --- 2. Details this event still needs ------------------------- */}
      {needed.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-20 leading-none">
              {settled.length > 0 ? "Still needed" : "Your details"}
            </h2>
            <span className="ml-auto text-12 text-muted">
              {needed.every((detail) => !detail.required)
                ? "All optional"
                : `${needed.filter((detail) => detail.required).length} to answer`}
            </span>
          </div>

          <div className="divide-y divide-hair/60">
            {needed.map((detail) => detailRow(detail, true))}
          </div>

          <p className="border-t border-hair px-5 py-3 text-12 text-muted">
            Answered once, these are remembered for every future event — that is what makes
            the next application three taps.
          </p>
        </Panel>
      )}

      {/* --- 3. The event's own questions ------------------------------ */}
      {questions.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-20 leading-none">
              {details.length > 0 ? "Just these" : "The questions"}
            </h2>
            <span className="ml-auto text-12 text-muted">
              {questions.every((question) => !question.required)
                ? "All optional"
                : `${questions.filter((question) => question.required).length} to answer`}
            </span>
          </div>

          <div className="divide-y divide-hair/60">
            {questions.map((question) => (
              <div key={question.id} className="px-5 py-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-2">
                  <span className="eyebrow text-chalk/70">{question.label}</span>
                  {question.required && !hasAnswer(answers[question.id] ?? null) && (
                    <Badge tone="union">Needed</Badge>
                  )}
                </div>

                <FieldControl
                  field={{
                    id: question.id,
                    key: question.key,
                    label: question.label,
                    type: question.type,
                    options: question.options,
                    required: question.required,
                    choices: question.choices,
                    value: answers[question.id] ?? null,
                  }}
                  value={answers[question.id] ?? null}
                  onChange={(next) => changeAnswer(question.id, next)}
                />

                {errors[question.id] && (
                  <p className="mt-2 text-12 text-flare">{errors[question.id]}</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {details.length === 0 && questions.length === 0 && (
        <Panel as="section">
          <Eyebrow className="mb-3">No questions</Eyebrow>
          <EmptyState>
            This event asks nothing at all — say which days you can make and you are done.
          </EmptyState>
        </Panel>
      )}

      {/* --- 4. Availability, as day chips ---------------------------- */}
      {days.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-20 leading-none">
              Which days can you make?
            </h2>
            <Button
              size="sm"
              variant={everyDayYes ? "default" : "union"}
              className="ml-auto"
              onClick={() => {
                setSaved(false);
                setAvailability(
                  Object.fromEntries(days.map((day) => [day.id, "yes" as AvailabilityState]))
                );
              }}
              disabled={everyDayYes}
            >
              {everyDayYes ? "✓ Every day" : "I can make every day"}
            </Button>
          </div>

          <div className="divide-y divide-hair/60">
            {days.map((day) => (
              <div
                key={day.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4"
              >
                <div className="min-w-40">
                  {/* `dayName` is the one rule for what a day is called
                      (UC-08 E3), numbered from the stored `dayIndex` rather
                      than this row's position. */}
                  <div className="text-14">
                    {dayName(
                      {
                        startsAt: day.startsAt === null ? null : new Date(day.startsAt),
                        label: day.label,
                      },
                      day.dayIndex
                    )}
                  </div>
                  <EventDateRange
                    startsAt={day.startsAt}
                    fallback="Time to be confirmed"
                    className="mt-1 block"
                  />
                </div>

                <ChoiceRow className="ml-auto">
                  {AVAILABILITY_CHOICES.map((choice) => (
                    <ChoiceChip
                      key={choice.value}
                      selected={availability[day.id] === choice.value}
                      onClick={() => {
                        setSaved(false);
                        setAvailability((current) => {
                          const next = { ...current };
                          if (next[day.id] === choice.value) delete next[day.id];
                          else next[day.id] = choice.value;
                          return next;
                        });
                      }}
                    >
                      {choice.label}
                    </ChoiceChip>
                  ))}
                </ChoiceRow>
              </div>
            ))}
          </div>

          <p className="border-t border-hair px-5 py-3 text-12 text-muted">
            Optional, and you can change it any time from My events — it is what the
            schedule gets built around, not a commitment.
          </p>
        </Panel>
      )}

      {/* --- 5. One submit -------------------------------------------- */}
      <Panel as="section" className="sticky bottom-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0">
            <Button
              variant="union"
              onClick={submit}
              disabled={
                busy || missing.length > 0 || (mode === "apply" && settled.length > 0 && !confirmed)
              }
            >
              {busy
                ? mode === "edit"
                  ? "Saving…"
                  : "Submitting…"
                : mode === "edit"
                  ? "Save changes"
                  : willWaitlist
                    ? "Join the waitlist"
                    : "Apply"}
            </Button>
          </div>

          <p className="min-w-0 flex-1 text-12 leading-relaxed text-muted">
            {missing.length > 0 ? (
              <span className="text-union">
                {plural(missing.length, "question")} still needed:{" "}
                {missing.map((row) => row.label).join(", ")}
              </span>
            ) : mode === "edit" ? (
              "Saving changes your answers and your profile. It does not touch your seat, your place in any queue, or when you applied — and you can keep changing them until sign-ups close."
            ) : settled.length > 0 && !confirmed ? (
              <span className="text-union">
                Confirm the details above are still right, then this goes through.
              </span>
            ) : entryMode === "approval" ? (
              "The organisers review every application to this event, so this goes to them rather than taking a seat. You will hear either way, and you can withdraw it at any time until then."
            ) : willWaitlist ? (
              "Every seat is taken, so this joins the queue. You move up on your own if somebody withdraws."
            ) : (
              "First come, first served — the seat is yours the moment this goes through."
            )}
          </p>

          <button
            type="button"
            className="text-12 text-muted underline underline-offset-4 hover:text-union"
            onClick={() => router.push(`/events/${slug}`)}
          >
            {mode === "edit" ? "Done" : "Cancel"}
          </button>
        </div>
      </Panel>
    </div>
  );
}
