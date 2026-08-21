"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FieldControl from "./FieldControl";
import { Alert, Badge, EmptyState, Eyebrow, Section } from "@/components/ui";
import type { ProfileValue } from "@/db/schema";
import type { ProfileSectionView } from "@/lib/profile";
import { hasAnswer, sectionCompleteness } from "@/lib/profile-fields";
import { saveProfileSectionAction } from "@/app/me/profile/actions";

/**
 * One game's questions, saving themselves as they are answered.
 *
 * ## Why there is no save button
 *
 * The brief is a server action *per section*, optimistic, with a clear saved
 * indicator, and no page-wide submit — because the failure mode of the Google
 * Form was a long page you had to get all the way through. Here a tap is the
 * commit: the chip lights immediately, the write goes out behind it, and the
 * only thing that ever appears is a small "Saved" a moment later.
 *
 * ## What happens when the write fails
 *
 * Optimism is only honest if it can be taken back. The last values the server
 * confirmed are kept in a ref; a rejected save restores exactly the fields it
 * covered — not the whole section, so a failure on one chip does not undo three
 * others that landed — and shows why.
 *
 * ## Ordering
 *
 * Saves are serialised through one in-flight slot with a pending patch behind
 * it. Tapping four chips quickly cannot produce four racing requests whose
 * arrival order decides what gets stored: it produces one write, then one more
 * carrying whatever accumulated while the first was away.
 */

type Status = "idle" | "dirty" | "saving" | "saved" | "error";

/** How long typing has to stop before a text or number field saves itself. */
const TYPING_SETTLE_MS = 700;
/** How long the "Saved" tick stays up before fading back to idle. */
const SAVED_MS = 2600;

export default function ProfileSection({ section }: { section: ProfileSectionView }) {
  const initial: Record<string, ProfileValue> = {};
  for (const field of section.fields) initial[field.id] = field.value;

  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState<Status>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** The last state the server confirmed. What a failed save reverts to. */
  const confirmed = useRef(initial);
  /** Changes waiting to go out. Keyed by field id, last write wins. */
  const pending = useRef<Record<string, ProfileValue>>({});
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const flush = useCallback(async () => {
    if (inFlight.current) return;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;

    pending.current = {};
    inFlight.current = true;
    setStatus("saving");

    try {
      const result = await saveProfileSectionAction(section.gameId, patch);

      if (!mounted.current) return;

      if (result.ok) {
        confirmed.current = { ...confirmed.current, ...result.values };
        // Trust the server's version over the optimistic one: it has been
        // through validation, so a multiselect comes back in option order.
        setValues((current) => ({ ...current, ...result.values }));
        setFieldErrors({});
        setProblem(null);
        setStatus("saved");
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => {
          if (mounted.current) setStatus((now) => (now === "saved" ? "idle" : now));
        }, SAVED_MS);
      } else {
        // Put back only what this attempt touched.
        const reverted: Record<string, ProfileValue> = {};
        for (const id of Object.keys(patch)) reverted[id] = confirmed.current[id] ?? null;
        setValues((current) => ({ ...current, ...reverted }));
        setFieldErrors(result.errors);
        setProblem(result.errors._ ?? "That answer was not accepted.");
        setStatus("error");
      }
    } catch {
      if (!mounted.current) return;
      const reverted: Record<string, ProfileValue> = {};
      for (const id of Object.keys(patch)) reverted[id] = confirmed.current[id] ?? null;
      setValues((current) => ({ ...current, ...reverted }));
      setProblem("Could not reach the server. Nothing was saved.");
      setStatus("error");
    } finally {
      inFlight.current = false;
    }

    if (mounted.current && Object.keys(pending.current).length > 0) void flush();
  }, [section.gameId]);

  const change = useCallback(
    (fieldId: string, value: ProfileValue, options?: { debounce?: boolean }) => {
      setValues((current) => ({ ...current, [fieldId]: value }));
      pending.current[fieldId] = value;
      setStatus("dirty");
      setFieldErrors((current) => {
        if (!current[fieldId]) return current;
        const next = { ...current };
        delete next[fieldId];
        return next;
      });

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), options?.debounce ? TYPING_SETTLE_MS : 0);
    },
    [flush]
  );

  /** Send whatever is waiting right now — used when a typed field loses focus. */
  const commit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  const completeness = sectionCompleteness(
    section.fields.map((field) => ({
      label: field.label,
      required: field.required,
      value: values[field.id] ?? null,
    }))
  );

  return (
    <Section
      icon="clipboard"
      title={section.name}
      description={
        section.gameId === null
          ? "Asked of everybody, whatever they play. Answered once, kept for good."
          : `Answered once here, then pre-filled into every ${section.name} application.`
      }
      aside={
        <div className="flex flex-wrap items-center gap-3">
          {section.rankLadder.length > 0 && (
            <Badge>{section.rankLadder.length}-rank ladder</Badge>
          )}
          {completeness.required > 0 && (
            <Eyebrow
              as="span"
              className={completeness.complete ? "text-signal" : undefined}
            >
              {completeness.answered}/{completeness.required} required
            </Eyebrow>
          )}
          <SaveIndicator status={status} />
        </div>
      }
    >
      {problem && (
        <div className="pb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {section.fields.length === 0 ? (
        <div className="py-4">
          <EmptyState>
            No questions for {section.name} yet. Nothing to fill in until an admin adds
            some.
          </EmptyState>
        </div>
      ) : (
        <div className="divide-y divide-hair/60">
          {section.fields.map((field) => (
            <div key={field.id} className="py-5 first:pt-0">
              <div className="mb-3 flex flex-wrap items-baseline gap-2">
                <span className="eyebrow text-chalk/70">{field.label}</span>
                {field.required && !hasAnswer(values[field.id] ?? null) && (
                  <Badge tone="gold">Needed</Badge>
                )}
              </div>

              <FieldControl
                field={field}
                value={values[field.id] ?? null}
                onChange={(value, options) => change(field.id, value, options)}
                onCommit={commit}
              />

              {fieldErrors[field.id] && (
                <p className="mt-2 text-xs text-ember">{fieldErrors[field.id]}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** The quiet line that says whether the last tap made it to Postgres. */
function SaveIndicator({ status }: { status: Status }) {
  if (status === "saving") {
    return (
      <Eyebrow as="span" className="animate-pulse text-gold">
        Saving…
      </Eyebrow>
    );
  }
  if (status === "saved") {
    return (
      <Eyebrow as="span" className="text-signal">
        ✓ Saved
      </Eyebrow>
    );
  }
  if (status === "error") {
    return (
      <Eyebrow as="span" className="text-ember">
        Not saved
      </Eyebrow>
    );
  }
  if (status === "dirty") {
    return (
      <Eyebrow as="span" className="text-muted">
        …
      </Eyebrow>
    );
  }
  return null;
}
