"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  Field,
  Icon,
  Panel,
  Select,
  plural,
} from "@/components/ui";
import {
  type AvailabilityAnswer,
  type AvailabilityException,
  type AvailabilityRule,
  LATEST_MINUTE,
  rangeRefusal,
  weekdayName,
} from "@/lib/availability-resolve";
import { clockSteps, clockWithDay, formatDate, localZone, todayIn } from "@/lib/zoned-time";
import { saveAvailabilityAction } from "@/app/me/availability-actions";

/**
 * "When are you generally free?" — asked once, not once per event.
 *
 * The per-event question ("can you make these three dates") is the wrong one
 * to build a calendar from, because by the time it is asked the dates are
 * already chosen. This is the question that comes first, and the answer to it
 * is what lets an organiser pick a date that most people can actually make.
 *
 * ## The shape of the form
 *
 * A day is one of three things, and the dropdown says which: not free, free
 * all day, or free at particular times. That third state is the only one that
 * opens anything, so a person whose answer is "Tuesdays and Thursdays, all
 * evening" fills this in with four clicks and never sees a time picker.
 *
 * Times are half-hourly. Fifteen-minute granularity on a question like "when
 * are you around in the evening" is precision nobody has, and it doubles the
 * length of every dropdown.
 *
 * ## Maybe
 *
 * Every window can be a maybe. It is not a hedge — "I could probably do
 * Thursdays" is real information and the alternative is that it gets recorded
 * as a yes and somebody is disappointed, or as nothing and the slot looks
 * emptier than it is. The grid keeps the two apart.
 *
 * ## What happens when a range is backwards (UC-06 7b)
 *
 * It is shown, by name, and the save is held. This panel used to shunt the end
 * forward the instant it landed before the start: pick 22:00 as a start on a
 * window ending at 21:00 and the end silently became 22:30. That wrote a time
 * the member never chose, and it hid the mis-click that caused it — the row
 * looked fine afterwards, so there was nothing to notice and nothing to undo.
 *
 * The check is `rangeRefusal`, the same function the server refuses with, so
 * the sentence on screen is the sentence the action would have returned.
 * Overlaps are the opposite case and are left entirely alone here: the server
 * merges them (7d) and merging loses nothing, so there is nothing to warn
 * about.
 *
 * ## The zone
 *
 * Captured from the browser and stored with the answer, because a weekly
 * pattern is a wall-clock claim: "Tuesdays after eight" is not a moment until
 * there is a date to hang it on. Somebody who fills this in from Warsaw is
 * free from 19:00 as far as London is concerned, and the grid says so.
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** 05:00 the next morning is as late as a window may run. */
const LATEST = LATEST_MINUTE;
const ALL_DAY = { startMinute: 0, endMinute: 1440 };

type DayMode = "none" | "all" | "times";

type Draft = {
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
};

export default function AvailabilityPanel({ initial }: { initial: AvailabilityAnswer }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    rules: initial.rules.map((rule) => ({ ...rule })),
    exceptions: initial.exceptions.map((exception) => ({ ...exception })),
  }));
  const [saved, setSaved] = useState<Draft>(() => ({
    rules: initial.rules.map((rule) => ({ ...rule })),
    exceptions: initial.exceptions.map((exception) => ({ ...exception })),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  );

  const zone = initial.timezone ?? localZone();

  /*
   * Dates the member already had when the page loaded. A stored date that has
   * since been and gone is history rather than something they are adding, and
   * the server takes the same view — so it does not hold the save hostage.
   */
  const stored = useMemo(
    () => new Set(initial.exceptions.map((exception) => exception.date)),
    [initial.exceptions]
  );

  /** Every range the server would refuse, named (UC-06 7b, 7c). */
  const problems = useMemo(() => {
    const today = formatDate(todayIn(zone));
    const found: string[] = [];
    for (const rule of draft.rules) {
      const bad = rangeRefusal(weekdayName(rule.weekday), rule.startMinute, rule.endMinute);
      if (bad) found.push(bad);
    }
    for (const exception of draft.exceptions) {
      if (exception.date < today && !stored.has(exception.date)) {
        found.push(`${exception.date} has already been — pick a date from today on.`);
      }
      const bad = rangeRefusal(exception.date, exception.startMinute, exception.endMinute);
      if (bad) found.push(bad);
    }
    return found;
  }, [draft, stored, zone]);

  const rulesFor = (weekday: number) =>
    draft.rules.filter((rule) => rule.weekday === weekday);

  const modeFor = (weekday: number): DayMode => {
    const windows = rulesFor(weekday);
    if (windows.length === 0) return "none";
    if (
      windows.length === 1 &&
      windows[0].startMinute === ALL_DAY.startMinute &&
      windows[0].endMinute === ALL_DAY.endMinute
    ) {
      return "all";
    }
    return "times";
  };

  const touch = (next: Draft) => {
    setDraft(next);
    setError(null);
    setNote(null);
  };

  const setMode = (weekday: number, mode: DayMode) => {
    const others = draft.rules.filter((rule) => rule.weekday !== weekday);
    if (mode === "none") return touch({ ...draft, rules: others });
    if (mode === "all") {
      return touch({
        ...draft,
        rules: [...others, { weekday, ...ALL_DAY, state: "yes" }],
      });
    }
    // Straight into a sensible evening rather than 00:00–00:30, which nobody
    // means and everybody then has to correct.
    const existing = rulesFor(weekday);
    const seeded =
      existing.length > 0 && modeFor(weekday) === "all"
        ? [{ weekday, startMinute: 18 * 60, endMinute: 23 * 60, state: "yes" as const }]
        : existing.length > 0
          ? existing
          : [{ weekday, startMinute: 18 * 60, endMinute: 23 * 60, state: "yes" as const }];
    touch({ ...draft, rules: [...others, ...seeded] });
  };

  const patchWindow = (weekday: number, index: number, change: Partial<AvailabilityRule>) => {
    let seen = -1;
    touch({
      ...draft,
      rules: draft.rules.map((rule) => {
        if (rule.weekday !== weekday) return rule;
        seen += 1;
        if (seen !== index) return rule;
        // Stored exactly as chosen. Dragging the start past the end is a
        // slip, and `problems` below says so by name — moving the end to
        // cover it up is how the slip used to survive into the database.
        return { ...rule, ...change };
      }),
    });
  };

  const addWindow = (weekday: number) => {
    const windows = rulesFor(weekday);
    const last = windows[windows.length - 1];
    const start = last ? Math.min(last.endMinute + 60, LATEST - 30) : 18 * 60;
    touch({
      ...draft,
      rules: [
        ...draft.rules,
        { weekday, startMinute: start, endMinute: Math.min(start + 180, LATEST), state: "yes" },
      ],
    });
  };

  const removeWindow = (weekday: number, index: number) => {
    let seen = -1;
    touch({
      ...draft,
      rules: draft.rules.filter((rule) => {
        if (rule.weekday !== weekday) return true;
        seen += 1;
        return seen !== index;
      }),
    });
  };

  /* --- Odd days ------------------------------------------------- */

  const addException = () => {
    const today = new Date();
    const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    touch({
      ...draft,
      exceptions: [
        ...draft.exceptions,
        { date: iso, startMinute: 0, endMinute: 1440, state: "no", note: null },
      ],
    });
  };

  const patchException = (index: number, change: Partial<AvailabilityException>) => {
    touch({
      ...draft,
      exceptions: draft.exceptions.map((exception, at) => {
        if (at !== index) return exception;
        return { ...exception, ...change };
      }),
    });
  };

  const removeException = (index: number) =>
    touch({ ...draft, exceptions: draft.exceptions.filter((_unused, at) => at !== index) });

  /* --- Saving ---------------------------------------------------- */

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveAvailabilityAction({
        timezone: localZone(),
        rules: draft.rules,
        exceptions: draft.exceptions,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved({
        rules: draft.rules.map((rule) => ({ ...rule })),
        exceptions: draft.exceptions.map((exception) => ({ ...exception })),
      });
      setNote("Saved");
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  const days = draft.rules.reduce(
    (set, rule) => set.add(rule.weekday),
    new Set<number>()
  ).size;

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {problems.length > 0 && (
        <Alert tone="flare">
          <span className="block font-medium">
            {problems.length === 1 ? "One range is wrong" : `${problems.length} ranges are wrong`}
          </span>
          <ul className="mt-1 space-y-0.5 opacity-90">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <span className="mt-2 block opacity-90">
            Nothing is saved until they are fixed.
          </span>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={days > 0 ? "union" : undefined}>
          {days > 0 ? `${plural(days, "day")} a week` : "Nothing set"}
        </Badge>
        {draft.exceptions.length > 0 && (
          <Badge>{plural(draft.exceptions.length, "odd day")}</Badge>
        )}
        <span className="text-13 text-dim">Times are {zone}</span>
      </div>

      {/* --- The week ------------------------------------------------ */}
      <Panel tone="wash" padding="none" className="overflow-hidden">
        {DAYS.map((label, weekday) => {
          const mode = modeFor(weekday);
          const windows = rulesFor(weekday);
          return (
            <div
              key={label}
              className="flex flex-wrap items-start gap-x-4 gap-y-3 border-t border-hair px-5 py-4 first:border-t-0"
            >
              <span className="w-[6.5rem] shrink-0 pt-2 text-14 text-chalk">{label}</span>

              {/*
               * The sizing goes on a wrapper, not on the control. This Select
               * has no label, hint or error, so FieldShell hands back the bare
               * `<select>` and drops `wrapperClassName` on the floor — which is
               * why this dropdown had been rendering full-width. Moving the
               * classes to `className` does not fix it either: `.field` sets
               * `width: 100%` and is defined after `@tailwind utilities` at the
               * same specificity, so it beats any `w-*` utility on the element
               * itself. A wrapper the field can fill is the one thing that works.
               */}
              <div className="w-[11rem] shrink-0">
                <Select
                  aria-label={`${label} availability`}
                  value={mode}
                  onChange={(input) => setMode(weekday, input.target.value as DayMode)}
                >
                  <option value="none">Not free</option>
                  <option value="all">Free all day</option>
                  <option value="times">Free at these times</option>
                </Select>
              </div>

              {mode === "times" && (
                <div className="min-w-0 flex-1 space-y-2">
                  {windows.map((window, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      {/*
                        Both lists run the whole day. Hiding the times that
                        would make this range backwards is the same repair as
                        moving the end, one step earlier: it makes the wrong
                        choice unreachable instead of answerable, and a member
                        who meant to move the start first then cannot.
                      */}
                      <TimeSelect
                        label={`${label} window ${index + 1} start`}
                        value={window.startMinute}
                        onChange={(minute) => patchWindow(weekday, index, { startMinute: minute })}
                      />
                      <span className="text-dim">–</span>
                      <TimeSelect
                        label={`${label} window ${index + 1} end`}
                        value={window.endMinute}
                        onChange={(minute) => patchWindow(weekday, index, { endMinute: minute })}
                      />
                      <MaybeToggle
                        state={window.state}
                        onChange={(state) => patchWindow(weekday, index, { state })}
                      />
                      {windows.length > 1 && (
                        <Button
                          size="sm"
                          variant="flare"
                          aria-label="Remove this window"
                          onClick={() => removeWindow(weekday, index)}
                        >
                          ×
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button size="sm" onClick={() => addWindow(weekday)}>
                    Add another window
                  </Button>
                </div>
              )}

              {mode === "all" && (
                <MaybeToggle
                  state={windows[0]?.state ?? "yes"}
                  onChange={(state) => patchWindow(weekday, 0, { state })}
                />
              )}
            </div>
          );
        })}
      </Panel>

      {/* --- Odd days ------------------------------------------------ */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="flex items-center gap-2 text-16 text-chalk">
            <Icon name="calendar" className="text-dim" />
            Odd days
          </span>
          <p className="min-w-0 flex-1 text-13 leading-relaxed text-muted">
            One-off dates that do not follow the pattern above. A date named here replaces the
            week entirely for that day — so &ldquo;can&rsquo;t do the 14th&rsquo; sticks even if
            it is a Tuesday you are normally free.
          </p>
        </div>

        {draft.exceptions.length > 0 && (
          <Panel tone="wash" padding="none" className="overflow-hidden">
            {draft.exceptions.map((exception, index) => (
              <div
                key={index}
                className="flex flex-wrap items-end gap-x-3 gap-y-3 border-t border-hair px-5 py-4 first:border-t-0"
              >
                <Field
                  label="Date"
                  type="date"
                  value={exception.date}
                  wrapperClassName="w-[10.5rem] shrink-0"
                  onChange={(input) => patchException(index, { date: input.target.value })}
                />

                <Select
                  label="That day"
                  value={exception.state}
                  wrapperClassName="w-[10rem] shrink-0"
                  onChange={(input) =>
                    patchException(index, {
                      state: input.target.value as AvailabilityException["state"],
                    })
                  }
                >
                  <option value="no">I cannot do</option>
                  <option value="yes">I can do</option>
                  <option value="maybe">Maybe — not sure</option>
                </Select>

                {exception.state !== "no" && (
                  <div className="flex items-center gap-2 pb-1">
                    <TimeSelect
                      label="From"
                      value={exception.startMinute}
                      onChange={(minute) => patchException(index, { startMinute: minute })}
                    />
                    <span className="text-dim">–</span>
                    <TimeSelect
                      label="To"
                      value={exception.endMinute}
                      onChange={(minute) => patchException(index, { endMinute: minute })}
                    />
                  </div>
                )}

                <Field
                  label="Note"
                  placeholder="Optional"
                  value={exception.note ?? ""}
                  maxLength={80}
                  wrapperClassName="min-w-[8rem] flex-1"
                  onChange={(input) => patchException(index, { note: input.target.value })}
                />

                <Button
                  size="sm"
                  variant="flare"
                  className="mb-1"
                  aria-label="Remove this date"
                  onClick={() => removeException(index)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </Panel>
        )}

        <Button size="sm" onClick={addException}>
          Add a date
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          variant="union"
          disabled={busy || !dirty || problems.length > 0}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save availability"}
        </Button>
        {note && !dirty && <span className="text-13 text-success">{note}</span>}
        {dirty && <span className="text-13 text-muted">Unsaved changes</span>}
      </div>
    </div>
  );
}

/**
 * A half-hourly clock. Runs to 05:00 the next morning, and says so — a list
 * ending at "05:00" with no marker looks like the early hours of the same day.
 */
function TimeSelect({
  label,
  value,
  min = 0,
  max = LATEST,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (minute: number) => void;
}) {
  const steps = useMemo(() => clockSteps(min, max), [min, max]);
  return (
    <Select
      aria-label={label}
      className="w-auto py-1.5 text-13"
      value={value}
      onChange={(input) => onChange(Number(input.target.value))}
    >
      {/* A stored value off the half hour would otherwise vanish from its own
          dropdown and be silently rewritten on the next save. */}
      {!steps.includes(value) && <option value={value}>{clockWithDay(value)}</option>}
      {steps.map((minute) => (
        <option key={minute} value={minute}>
          {clockWithDay(minute)}
        </option>
      ))}
    </Select>
  );
}

/** Yes or maybe. Two states, so a switch rather than a third dropdown. */
function MaybeToggle({
  state,
  onChange,
}: {
  state: "yes" | "maybe";
  onChange: (state: "yes" | "maybe") => void;
}) {
  return (
    <ChoiceChip
      selected={state === "maybe"}
      onClick={() => onChange(state === "maybe" ? "yes" : "maybe")}
      title={
        state === "maybe"
          ? "Marked as a maybe — click to make it definite"
          : "Definite — click if you are not sure"
      }
    >
      {state === "maybe" ? "Maybe" : "Definite"}
    </ChoiceChip>
  );
}
