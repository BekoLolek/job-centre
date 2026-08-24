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
import type { AvailabilityState, ProfileValue } from "@/db/schema";
import type { PrefilledQuestionView } from "@/lib/events";
import { formatAnswer, hasAnswer } from "@/lib/profile-fields";
import { applyToEventAction } from "@/app/events/[slug]/apply/actions";

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
 *   1. **"Yes, still right"** on the prefilled block, which arrives already
 *      answered from `loadApplicationForm` — every value shown as a sentence
 *      rather than as a control, because a control invites fiddling with an
 *      answer that was already correct.
 *   2. **"I can make every day"**, or one tap per day if it is more complicated
 *      than that.
 *   3. **Apply.**
 *
 * Anything they *do* want to change is one more tap to open that row's control
 * — the same click-first controls `/me/profile` uses, not a second
 * implementation — and editing a row counts as having checked it.
 *
 * ## What is not here
 *
 * No validation rules. The client stops the obvious ("that required question
 * has no answer") so the round trip is not wasted, but `applyToEvent` re-reads
 * the questions, the ladder and the seat count inside a row lock and refuses
 * anything it does not like. If the two ever disagree the server wins, and its
 * per-question errors land back on the right rows.
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
  questions: PrefilledQuestionView[];
  days: ApplyDay[];
  /** The event's game ladder, for rendering a `rank` answer back. */
  rankLadder: string[];
  /** Their existing per-day answers, when they are re-applying. */
  availability: Record<string, AvailabilityState>;
  /** True when the seats are gone and this application joins the queue (§14). */
  willWaitlist: boolean;
};

export default function ApplyForm({
  eventId,
  slug,
  questions,
  days,
  rankLadder,
  availability: initialAvailability,
  willWaitlist,
}: ApplyFormProps) {
  const router = useRouter();

  const [values, setValues] = useState<Record<string, ProfileValue>>(() => {
    const start: Record<string, ProfileValue> = {};
    for (const question of questions) start[question.id] = question.value;
    return start;
  });
  const [availability, setAvailability] =
    useState<Record<string, AvailabilityState>>(initialAvailability);

  /** Rows the member has opened to change. Everything else stays a sentence. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Split once: the questions that arrived answered, and the ones that did not.
  // The split is on the *incoming* value, not the current one, so answering a
  // blank question does not make it jump into the confirm block mid-form.
  const { known, blank } = useMemo(() => {
    const known: PrefilledQuestionView[] = [];
    const blank: PrefilledQuestionView[] = [];
    for (const question of questions) {
      (hasAnswer(question.value) ? known : blank).push(question);
    }
    return { known, blank };
  }, [questions]);

  const change = (questionId: string, value: ProfileValue) => {
    setValues((current) => ({ ...current, [questionId]: value }));
    setErrors((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
    // Touching an answer is a stronger form of checking it than pressing the
    // confirm button, so it counts as both.
    setConfirmed(true);
  };

  const missing = questions.filter(
    (question) => question.required && !hasAnswer(values[question.id] ?? null)
  );

  const everyDayYes =
    days.length > 0 && days.every((day) => availability[day.id] === "yes");

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    setErrors({});
    try {
      const answers: Record<string, unknown> = {};
      for (const question of questions) answers[question.id] = values[question.id] ?? null;

      const result = await applyToEventAction({
        eventId,
        slug,
        answers,
        availability,
      });

      if (!result.ok) {
        setProblem(result.error);
        setErrors(result.errors ?? {});
        // A question that failed has to be reachable, so open every row that
        // has an error on it — including ones the member had never opened.
        setOpen((current) => ({
          ...current,
          ...Object.fromEntries(Object.keys(result.errors ?? {}).map((id) => [id, true])),
        }));
        setBusy(false);
        return;
      }
      // Note there is no `setBusy(false)` on the way out: the navigation below
      // is what ends this form's life, and re-enabling the button first is how
      // an impatient second tap becomes a second application.

      // Where the news is broken, and why it is not broken here: submitting
      // makes this page's own guard true — a member with a live application is
      // sent to `/me/events` — so a success panel rendered in this component
      // would be replaced by that redirect a frame later. The confirmation is
      // therefore server-rendered on the page they land on, from the stored
      // application rather than from this component's memory of it.
      router.replace(`/me/events?applied=${encodeURIComponent(slug)}`);
    } catch {
      setProblem("Could not reach the server, so nothing was submitted. Try again.");
      setBusy(false);
    }
  };

  /* --- The form ------------------------------------------------------ */

  return (
    <div className="space-y-5">
      {problem && <Alert>{problem}</Alert>}

      {/* --- 1. Already answered, confirm in one tap ------------------ */}
      {known.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-xl leading-none">
              Already answered
            </h2>
            <Badge tone={confirmed ? "signal" : "gold"}>
              {confirmed ? "Checked" : "Needs a look"}
            </Badge>
            <span className="ml-auto text-xs text-muted">
              {plural(known.length, "answer")} from your profile
            </span>
          </div>

          <div className="divide-y divide-hair/60">
            {known.map((question) => {
              const value = values[question.id] ?? null;
              const isOpen = open[question.id] === true;
              return (
                <div key={question.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                    <span className="eyebrow text-chalk/70">{question.label}</span>

                    {!isOpen && (
                      <span
                        className={cx(
                          "num text-sm",
                          hasAnswer(value) ? "text-chalk" : "text-muted"
                        )}
                      >
                        {formatAnswer(
                          {
                            type: question.type,
                            label: question.label,
                            options: question.options,
                            rankLadder,
                          },
                          value
                        )}
                      </span>
                    )}

                    <button
                      type="button"
                      className="ml-auto text-xs text-muted underline underline-offset-4 hover:text-gold"
                      onClick={() =>
                        setOpen((current) => ({ ...current, [question.id]: !isOpen }))
                      }
                    >
                      {isOpen ? "Done" : "Change"}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="mt-3">
                      <FieldControl
                        field={{
                          id: question.id,
                          key: question.key,
                          label: question.label,
                          type: question.type,
                          options: question.options,
                          required: question.required,
                          choices: question.choices,
                          value,
                        }}
                        value={value}
                        onChange={(next) => change(question.id, next)}
                      />
                    </div>
                  )}

                  {errors[question.id] && (
                    <p className="mt-2 text-xs text-ember">{errors[question.id]}</p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-hair px-5 py-4">
            <Button
              variant={confirmed ? "default" : "gold"}
              onClick={() => setConfirmed(true)}
              disabled={confirmed}
            >
              {confirmed ? "✓ Confirmed" : "Yes, that's all still right"}
            </Button>
            <p className="text-xs leading-relaxed text-muted">
              These came from your profile. One tap says they are still true — nothing to
              retype.
            </p>
          </div>
        </Panel>
      )}

      {/* --- 2. Anything that has never been answered ----------------- */}
      {blank.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-xl leading-none">
              {known.length > 0 ? "Just these" : "The questions"}
            </h2>
            <span className="ml-auto text-xs text-muted">
              {blank.every((question) => !question.required)
                ? "All optional"
                : `${blank.filter((question) => question.required).length} to answer`}
            </span>
          </div>

          <div className="divide-y divide-hair/60">
            {blank.map((question) => (
              <div key={question.id} className="px-5 py-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-2">
                  <span className="eyebrow text-chalk/70">{question.label}</span>
                  {question.required && !hasAnswer(values[question.id] ?? null) && (
                    <Badge tone="gold">Needed</Badge>
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
                    value: values[question.id] ?? null,
                  }}
                  value={values[question.id] ?? null}
                  onChange={(next) => change(question.id, next)}
                />

                {errors[question.id] && (
                  <p className="mt-2 text-xs text-ember">{errors[question.id]}</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {questions.length === 0 && (
        <Panel as="section">
          <Eyebrow className="mb-3">No questions</Eyebrow>
          <EmptyState>
            This event asks nothing at all — say which days you can make and you are done.
          </EmptyState>
        </Panel>
      )}

      {/* --- 3. Availability, as day chips ---------------------------- */}
      {days.length > 0 && (
        <Panel as="section" padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
            <h2 className="font-display text-xl leading-none">
              Which days can you make?
            </h2>
            <Button
              size="sm"
              variant={everyDayYes ? "default" : "gold"}
              className="ml-auto"
              onClick={() =>
                setAvailability(
                  Object.fromEntries(days.map((day) => [day.id, "yes" as AvailabilityState]))
                )
              }
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
                  <div className="text-sm">{day.label ?? `Day ${day.dayIndex + 1}`}</div>
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
                      onClick={() =>
                        setAvailability((current) => {
                          const next = { ...current };
                          if (next[day.id] === choice.value) delete next[day.id];
                          else next[day.id] = choice.value;
                          return next;
                        })
                      }
                    >
                      {choice.label}
                    </ChoiceChip>
                  ))}
                </ChoiceRow>
              </div>
            ))}
          </div>

          <p className="border-t border-hair px-5 py-3 text-xs text-muted">
            Optional, and you can change it any time from My events — it is what the
            schedule gets built around, not a commitment.
          </p>
        </Panel>
      )}

      {/* --- 4. One submit -------------------------------------------- */}
      <Panel as="section" className="sticky bottom-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0">
            <Button
              variant="gold"
              onClick={submit}
              disabled={busy || missing.length > 0 || (known.length > 0 && !confirmed)}
            >
              {busy ? "Submitting…" : willWaitlist ? "Join the waitlist" : "Apply"}
            </Button>
          </div>

          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
            {missing.length > 0 ? (
              <span className="text-gold">
                {plural(missing.length, "question")} still needed:{" "}
                {missing.map((question) => question.label).join(", ")}
              </span>
            ) : known.length > 0 && !confirmed ? (
              <span className="text-gold">
                Confirm the answers above are still right, then this goes through.
              </span>
            ) : willWaitlist ? (
              "Every seat is taken, so this joins the queue. You move up on your own if somebody withdraws."
            ) : (
              "First come, first served — the seat is yours the moment this goes through."
            )}
          </p>

          <button
            type="button"
            className="text-xs text-muted underline underline-offset-4 hover:text-gold"
            onClick={() => router.push(`/events/${slug}`)}
          >
            Cancel
          </button>
        </div>
      </Panel>
    </div>
  );
}
