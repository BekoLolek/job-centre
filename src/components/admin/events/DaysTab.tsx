"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Panel,
  plural,
} from "@/components/ui";
import { localInput } from "@/components/events";
import type { EventDaysImpact, EventDetail } from "@/lib/events";
import { toInstant, zoneLabel } from "@/lib/time";
import {
  type DayFields,
  previewEventDaysAction,
  saveEventDaysAction,
} from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Days — up to four, each with a time and a label, reorderable.
 *
 * ## The destructive bit, and why it has its own round trip
 *
 * Every applicant answers "can you make it?" per day, and those answers hang
 * off `event_days.id` with a cascade delete. Drop a day and the answers go with
 * it. `setEventDays` reports `clearedAvailability` — but it reports it in the
 * *result*, which is one moment too late to put on a confirm dialog: by the
 * time the number is readable the answers are gone.
 *
 * So this tab asks first. `previewEventDays` runs the same validation and the
 * same arithmetic against the database without writing anything, and the number
 * it returns is what the confirm dialog says. That is checklist.md's standing
 * "nothing destructive, ever" rule applied to the one screen on this page that
 * really can destroy something.
 *
 * ## Reordering is free, and the screen says so
 *
 * A day keeps its identity as long as its id is passed back, so moving Saturday
 * above Friday moves the row rather than replacing it — everyone's answers come
 * with it. That is worth stating out loud, because "reordering days" sounds
 * exactly like the kind of thing that would quietly reset them.
 */

type DraftDay = {
  /** Stable across reorders, so React does not reuse a row's input state. */
  key: string;
  /** Present for a day that already exists. Its absence is what makes a delete. */
  id?: string;
  startsAt: string;
  label: string;
};

let counter = 0;
const nextKey = () => `new-${(counter += 1)}`;

export default function DaysTab({
  event,
  maxDays,
}: {
  event: EventDetail;
  maxDays: number;
}) {
  const router = useRouter();

  const [days, setDays] = useState<DraftDay[]>(() =>
    event.days.map((day) => ({
      key: day.id,
      id: day.id,
      startsAt: localInput(day.startsAt),
      label: day.label ?? "",
    }))
  );

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [impact, setImpact] = useState<EventDaysImpact | null>(null);

  const touch = () => {
    setState("dirty");
    setError(null);
    setNote(null);
  };

  const kept = new Set(days.map((day) => day.id).filter(Boolean));
  const dropping = event.days.filter((day) => !kept.has(day.id));

  const patch = (key: string, change: Partial<DraftDay>) => {
    setDays((current) =>
      current.map((day) => (day.key === key ? { ...day, ...change } : day))
    );
    touch();
  };

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= days.length) return;
    setDays((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  const add = () => {
    if (days.length >= maxDays) return;
    setDays((current) => [...current, { key: nextKey(), startsAt: "", label: "" }]);
    touch();
  };

  const remove = (key: string) => {
    setDays((current) => current.filter((day) => day.key !== key));
    touch();
  };

  const fields = (): DayFields[] =>
    days.map((day) => ({
      id: day.id,
      startsAt: toInstant(day.startsAt),
      label: day.label.trim() || null,
    }));

  /** Ask what this would cost. Only writes once the answer has been read. */
  const attemptSave = async () => {
    setState("saving");
    setError(null);
    try {
      const preview = await previewEventDaysAction(event.id, fields());

      if (preview.problem) {
        setError(preview.problem);
        setState("error");
        return;
      }
      if (preview.clearedAvailability > 0) {
        setImpact(preview);
        setState("dirty");
        return;
      }
      await commit();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const commit = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveEventDaysAction(event.id, fields());
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setImpact(null);
      // Adopt the ids the server just wrote. Without this the tab still thinks
      // every day is new, so the next save would delete these rows and insert
      // fresh ones — and take every availability answer with them.
      setDays(
        result.data.days.map((day) => ({
          key: day.id as string,
          id: day.id,
          startsAt: localInput(day.startsAt),
          label: day.label ?? "",
        }))
      );
      setNote(
        result.data.clearedAvailability > 0
          ? `Saved · ${plural(result.data.clearedAvailability, "answer")} cleared`
          : null
      );
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Panel as="section" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Days</Eyebrow>
          <Badge>
            {days.length}/{maxDays}
          </Badge>
          <span className="eyebrow text-muted/70">Times in {zoneLabel()}</span>
        </div>

        {days.length === 0 ? (
          <EmptyState>
            No days yet. An event with no days simply has no availability question —
            add one if you want to ask people which nights they can make.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hair/60 border border-hair">
            {days.map((day, index) => (
              <li key={day.key} className="flex flex-wrap items-end gap-3 p-3">
                <span className="num w-10 shrink-0 self-center text-xs text-muted">
                  Day {index + 1}
                </span>

                <Field
                  label="Starts"
                  type="datetime-local"
                  value={day.startsAt}
                  wrapperClassName="min-w-[13rem] flex-1"
                  onChange={(input) => patch(day.key, { startsAt: input.target.value })}
                />

                <Field
                  label="Label"
                  placeholder="Group stage"
                  value={day.label}
                  maxLength={60}
                  wrapperClassName="min-w-[10rem] flex-1"
                  onChange={(input) => patch(day.key, { label: input.target.value })}
                />

                <span className="flex shrink-0 items-center gap-1 self-center pt-5">
                  <Button
                    size="sm"
                    aria-label={`Move day ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, "up")}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Move day ${index + 1} down`}
                    disabled={index === days.length - 1}
                    onClick={() => move(index, "down")}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ember"
                    aria-label={`Remove day ${index + 1}`}
                    onClick={() => remove(day.key)}
                  >
                    Remove
                  </Button>
                </span>

                {day.id === undefined && (
                  <Badge tone="gold" className="self-center">
                    New
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        {dropping.length > 0 && (
          <Alert tone="gold">
            <span className="block font-medium">
              {plural(dropping.length, "day")} will be deleted when you save
            </span>
            <span className="mt-1 block opacity-90">
              Nothing has been removed yet. Saving asks what it costs first, and says the
              number of availability answers that go with them.
            </span>
          </Alert>
        )}

        <SaveRow
          state={state}
          note={note}
          onSave={() => void attemptSave()}
          label="Save days"
        >
          <Button size="sm" disabled={days.length >= maxDays} onClick={add}>
            + Add a day
          </Button>
          <span className="text-xs text-muted">
            Reordering keeps every answer — a day carries its identity with it.
          </span>
        </SaveRow>
      </Panel>

      {/* --- The confirm ------------------------------------------- */}
      <Modal
        open={impact !== null}
        onClose={() => setImpact(null)}
        size="sm"
        eyebrow="Before this is saved"
        title="This clears availability answers"
        footer={
          <>
            <Button size="sm" onClick={() => setImpact(null)}>
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
        {impact && (
          <>
            <Alert tone="ember">
              <span className="block font-medium">
                {plural(impact.clearedAvailability, "answer")} from{" "}
                {plural(impact.affectedApplicants, "applicant")}
              </span>
              <span className="mt-1 block opacity-90">
                Removing {plural(impact.removed.length, "day")} deletes what everyone said
                about {impact.removed.length === 1 ? "it" : "them"}. There is no undo, and
                nothing has been changed yet.
              </span>
            </Alert>

            <ul className="space-y-1 text-sm">
              {impact.removed.map((day) => (
                <li key={day.id} className="flex items-baseline gap-2">
                  <span className="num text-xs text-muted">Day {day.dayIndex + 1}</span>
                  <span>{day.label ?? "No label"}</span>
                </li>
              ))}
            </ul>

            {impact.moved.length > 0 && (
              <p className="text-xs leading-relaxed text-muted">
                {plural(impact.moved.length, "other day")} also{" "}
                {impact.moved.length === 1 ? "moves" : "move"} position. That part costs
                nothing — those days keep their answers.
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
