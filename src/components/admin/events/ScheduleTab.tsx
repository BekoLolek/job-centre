"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  Select,
  Stepper,
  plural,
} from "@/components/ui";
import { localInput } from "@/components/events";
import { BlockList, dayTotalsText, hhmm, modeLabel } from "@/components/format";
import type { EventDetail } from "@/lib/events";
import type { FormatView, ScheduleSettings } from "@/lib/format";
import {
  type FormatTiming,
  DEFAULT_FORMAT_TIMING,
  MAX_DAYS,
  normaliseFormatTiming,
} from "@/lib/format-policy";
import { dayMinutes, planBlocks, schedulePreview } from "@/lib/format-schedule";
import { toInstant, zoneLabel } from "@/lib/time";
import {
  type ScheduleSettingsFields,
  applyScheduleAction,
  saveScheduleSettingsAction,
} from "@/app/admin/events/format-actions";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Schedule — up to four days, a start time each, and the running order they
 * produce (plan §10).
 *
 * ## This is `AdminTools`, generalised
 *
 * The old board's schedule panel is the design that has actually been used on
 * the night, and it is kept: the timing fields across the top, the day starts
 * under them, then a preview of every block with its clock window and the day
 * totals in the header. What changes is that none of it is written for two
 * days and two modes any more. The days are a setting, the modes come from
 * whatever the format tab typed, and the blocks come from `planBlocks` rather
 * than a hardcoded phase list.
 *
 * ## The preview is the planner
 *
 * `planBlocks`, `schedulePreview` and `dayMinutes` are pure — no database, no
 * results — so the preview calls them with what is currently typed. It is the
 * same code the write goes through, so "what it will do" and "what it did"
 * cannot disagree.
 *
 * ## Day starts are not stored twice
 *
 * There is already a home for "when does day 2 begin": `event_days.starts_at`,
 * owned by the Days tab. So this prefills from there, and where a day has no
 * row it falls back to the earliest start already on that day's board — which
 * is derived from what was actually scheduled rather than a second copy of it.
 * Filling the times writes `matches.scheduled_at`, and that is the only record
 * of the running order there is.
 */

type TimingFields = {
  modeMinutes: Record<string, string>;
  defaultMinutes: string;
  betweenGames: string;
  betweenSeries: string;
};

const digits = (raw: string) => raw.replace(/[^0-9]/g, "");

/** In-use modes sort first, in board order; leftovers from an older config last. */
function modeRank(modes: string[], mode: string): number {
  const index = modes.indexOf(mode);
  return index < 0 ? modes.length + 1 : index;
}

function timingFieldsFrom(timing: FormatTiming, modes: string[]): TimingFields {
  const modeMinutes: Record<string, string> = {};
  for (const mode of modes) {
    modeMinutes[mode] = String(timing.modeMinutes[mode] ?? timing.defaultMinutes);
  }
  // Keep anything configured for a mode this format no longer plays: deleting
  // it here would silently lose the number the moment somebody re-adds the mode.
  for (const [mode, minutes] of Object.entries(timing.modeMinutes)) {
    if (!(mode in modeMinutes)) modeMinutes[mode] = String(minutes);
  }
  return {
    modeMinutes,
    defaultMinutes: String(timing.defaultMinutes),
    betweenGames: String(timing.betweenGames),
    betweenSeries: String(timing.betweenSeries),
  };
}

function timingFrom(fields: TimingFields): FormatTiming {
  return normaliseFormatTiming({
    modeMinutes: Object.fromEntries(
      Object.entries(fields.modeMinutes).map(([mode, value]) => [mode, Number(value || 0)])
    ),
    defaultMinutes: Number(fields.defaultMinutes || 0),
    betweenGames: Number(fields.betweenGames || 0),
    betweenSeries: Number(fields.betweenSeries || 0),
  });
}

export default function ScheduleTab({
  eventId,
  event,
  format,
  settings,
  matchIds,
}: {
  eventId: string;
  event: EventDetail;
  format: FormatView;
  /**
   * Slot to row id. `formatFor` resolves a stage's matches from its spec
   * whether or not a row exists, so this is the only thing that can say
   * whether there is anything to schedule yet.
   */
  matchIds: Record<string, string>;
  /**
   * `scheduleSettingsFrom(event.config)`, read on the server.
   *
   * `FormatView` carries the three numbers the board needs but not
   * `blockDays`, which only this screen edits — so the page reads the settings
   * once and hands them over rather than this tab guessing at them.
   */
  settings: ScheduleSettings;
}) {
  const router = useRouter();

  const specs = useMemo(() => format.stages.map((stage) => stage.spec), [format.stages]);
  const modes = useMemo(() => {
    const seen: string[] = [];
    for (const spec of specs) {
      for (const match of spec.matches) {
        for (const mode of match.modes) if (!seen.includes(mode)) seen.push(mode);
      }
    }
    return seen;
  }, [specs]);

  const [days, setDays] = useState(settings.days);
  const [lobbies, setLobbies] = useState(settings.concurrentLobbies);
  const [timing, setTiming] = useState<TimingFields>(() =>
    timingFieldsFrom(settings.timing, modes)
  );
  const [blockDays, setBlockDays] = useState<number[] | null>(settings.blockDays);
  const [starts, setStarts] = useState<string[]>(() => initialStarts(event, format));

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const touch = () => {
    setState("dirty");
    setError(null);
    setNote(null);
  };

  const numeric = timingFrom(timing);

  // The planner itself, called on what is typed. Nothing here re-implements it.
  const blocks = useMemo(
    () =>
      planBlocks(specs, {
        timing: numeric,
        concurrentLobbies: lobbies,
        days,
        blockDays: blockDays && blockDays.length === 0 ? null : blockDays,
      }),
    [specs, numeric, lobbies, days, blockDays]
  );

  const preview = useMemo(
    () => schedulePreview(blocks, starts.slice(0, days).map((value) => toInstant(value))),
    [blocks, starts, days]
  );
  const totals = useMemo(() => dayMinutes(blocks), [blocks]);

  const generated = format.stages
    .flatMap((stage) => stage.matches)
    .filter((match) => matchIds[match.slot]).length;
  const staleOverrides = blockDays !== null && blockDays.length !== blocks.length;
  const anyStart = starts.slice(0, days).some((value) => value.trim() !== "");

  const fields = (): ScheduleSettingsFields => ({
    timing: numeric,
    concurrentLobbies: lobbies,
    days,
    blockDays: staleOverrides ? null : blockDays,
  });

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveScheduleSettingsAction(eventId, fields());
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      adopt(result.data.settings);
      setNote("Saved");
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const fill = async () => {
    setBusy(true);
    setState("saving");
    setError(null);
    try {
      const result = await applyScheduleAction(
        eventId,
        starts.slice(0, days).map((value) => toInstant(value)),
        fields()
      );
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setNote(`${plural(result.data.scheduled, "match", "matches")} given a start time`);
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    } finally {
      setBusy(false);
    }
  };

  /** Show what was *stored*, clamps and all, rather than what was typed. */
  const adopt = (stored: ScheduleSettingsFields) => {
    setDays(stored.days);
    setLobbies(stored.concurrentLobbies);
    setTiming(timingFieldsFrom(stored.timing, modes));
    setBlockDays(stored.blockDays);
  };

  if (generated === 0) {
    return (
      <Panel as="section" className="space-y-3">
        <Eyebrow>Schedule</Eyebrow>
        <EmptyState>
          There is nothing to lay out yet. Choose a format and generate the matches on the
          Format tab; the running order is built from them, not typed in here.
        </EmptyState>
        <div>
          <Badge>{plural(format.stages.length, "stage")}</Badge>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- The shape of a day ------------------------------------ */}
      <Panel as="section" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Days and lobbies</Eyebrow>
          <span className="eyebrow text-muted/70">Times in {zoneLabel()}</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className="eyebrow mb-1 block">Days</span>
            <Stepper
              value={days}
              min={1}
              max={MAX_DAYS}
              aria-label="How many days the event runs"
              onChange={(value) => {
                setDays(Math.min(MAX_DAYS, Math.max(1, value ?? 1)));
                touch();
              }}
            />
            <span className="eyebrow mt-1 block text-muted/70">
              Each day has its own start. One overrunning never moves another.
            </span>
          </label>

          <label>
            <span className="eyebrow mb-1 block">Concurrent lobbies</span>
            <Stepper
              value={lobbies}
              min={1}
              max={8}
              aria-label="How many matches share a start time"
              onChange={(value) => {
                setLobbies(Math.min(8, Math.max(1, value ?? 1)));
                touch();
              }}
            />
            <span className="eyebrow mt-1 block text-muted/70">
              How many matches share a start time. One means back to back.
            </span>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: days }, (_, index) => (
            <Field
              key={index}
              label={`Day ${index + 1} start`}
              type="datetime-local"
              value={starts[index] ?? ""}
              hint={event.days[index]?.label ?? undefined}
              onChange={(input) => {
                setStarts((current) => {
                  const next = [...current];
                  next[index] = input.target.value;
                  return next;
                });
                touch();
              }}
            />
          ))}
        </div>
      </Panel>

      {/* --- Timing ------------------------------------------------ */}
      <Panel as="section" className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>How long things take</Eyebrow>
          <span className="eyebrow text-muted/70">Minutes · the longest case</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Object.keys(timing.modeMinutes)
            // The modes this format actually plays first, in board order; the
            // ones kept from an older config after them.
            .sort((x, y) => modeRank(modes, x) - modeRank(modes, y))
            .map((mode) => (
              <Field
                key={mode}
                label={modeLabel(mode)}
                inputMode="numeric"
                value={timing.modeMinutes[mode]}
                hint={modes.includes(mode) ? "per map" : "not played in this format"}
                onChange={(input) => {
                  setTiming((current) => ({
                    ...current,
                    modeMinutes: {
                      ...current.modeMinutes,
                      [mode]: digits(input.target.value),
                    },
                  }));
                  touch();
                }}
              />
            ))}

          <Field
            label="Any other mode"
            inputMode="numeric"
            value={timing.defaultMinutes}
            hint="the fallback"
            onChange={(input) => {
              setTiming((current) => ({ ...current, defaultMinutes: digits(input.target.value) }));
              touch();
            }}
          />
          <Field
            label="Between games"
            inputMode="numeric"
            value={timing.betweenGames}
            hint="inside a series"
            onChange={(input) => {
              setTiming((current) => ({ ...current, betweenGames: digits(input.target.value) }));
              touch();
            }}
          />
          <Field
            label="Between series"
            inputMode="numeric"
            value={timing.betweenSeries}
            hint="between blocks"
            onChange={(input) => {
              setTiming((current) => ({ ...current, betweenSeries: digits(input.target.value) }));
              touch();
            }}
          />
        </div>

        <div>
          <Button
            size="sm"
            onClick={() => {
              setTiming(timingFieldsFrom(DEFAULT_FORMAT_TIMING, modes));
              touch();
            }}
          >
            Reset to defaults
          </Button>
        </div>
      </Panel>

      {/* --- The preview ------------------------------------------- */}
      <Panel as="section" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Eyebrow>Running order · longest case</Eyebrow>
          <Eyebrow as="span">{dayTotalsText(totals)}</Eyebrow>
        </div>

        {staleOverrides && (
          <Alert tone="gold">
            <span className="block font-medium">The day overrides no longer fit the plan</span>
            <span className="mt-1 block opacity-90">
              There {blocks.length === 1 ? "is" : "are"} now {plural(blocks.length, "block")}{" "}
              and {plural(blockDays?.length ?? 0, "override")}. They are being ignored until
              you set them again, or clear them.
            </span>
          </Alert>
        )}

        <BlockList
          blocks={preview}
          dayMinutes={totals}
          renderAction={(block) => (
            <Select
              className="px-2 py-0.5 text-[11px]"
              aria-label={`Day for ${block.label}`}
              value={String(block.day)}
              onChange={(input) => {
                const chosen = Number(input.target.value);
                setBlockDays(() => {
                  const next = blocks.map((row) => row.day);
                  next[block.index] = chosen;
                  return next;
                });
                touch();
              }}
            >
              {Array.from({ length: days }, (_, index) => (
                <option key={index} value={index + 1}>
                  Day {index + 1}
                </option>
              ))}
            </Select>
          )}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={blockDays === null} onClick={() => {
            setBlockDays(null);
            touch();
          }}>
            Balance the days automatically
          </Button>
          <span className="text-xs text-muted">
            {blockDays === null
              ? `Blocks are split into ${plural(days, "day")} so the longest day is as short as it can be — they cannot be reordered, so the only choice is where the cuts go.`
              : "Following your overrides. A block with no override stays with the one before it."}
          </span>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Matches inside a block run in parallel and share a start time, so a block lasts as
          long as its slowest series — {hhmm(Math.max(0, ...blocks.map((b) => b.lengthMin)))}{" "}
          at the worst here. Once a block is complete the rest of that day re-flows from when
          it actually finished, so running late or early carries forward on its own.
        </p>
      </Panel>

      <Panel as="section">
        <SaveRow
          state={state}
          note={note}
          onSave={() => void save()}
          label="Save settings"
        >
          <Button
            size="sm"
            variant="gold"
            disabled={busy || !anyStart}
            onClick={() => void fill()}
          >
            {busy ? "Filling…" : "Fill start times"}
          </Button>
          <span className="text-xs text-muted">
            Filling also saves these settings. A day left blank is skipped rather than
            guessed at, and a match that has already been played keeps the slot it ran in.
          </span>
        </SaveRow>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Where the initial values come from                                 */
/* ------------------------------------------------------------------ */

/**
 * A start per day: the event's own day rows first, then the earliest start
 * already on that day's board.
 *
 * The fallback is derived rather than stored — `matches.scheduled_at` is the
 * only record of when the running order actually begins, so reading it back is
 * what makes re-opening this tab show the times that are on the board rather
 * than an empty form.
 */
function initialStarts(event: EventDetail, format: FormatView): string[] {
  const scheduledBySlot = new Map<string, string>();
  for (const stage of format.stages) {
    for (const match of stage.matches) {
      if (match.scheduledAt) scheduledBySlot.set(match.slot, match.scheduledAt);
    }
  }

  return Array.from({ length: MAX_DAYS }, (_, index) => {
    const fromDays = event.days[index]?.startsAt;
    if (fromDays) return localInput(fromDays);

    const onDay = format.blocks
      .filter((block) => block.day === index + 1)
      .flatMap((block) => block.slots)
      .map((slot) => scheduledBySlot.get(slot))
      .filter((stamp): stamp is string => Boolean(stamp))
      .sort();
    return onDay.length > 0 ? localInput(onDay[0]) : "";
  });
}
