"use client";

import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, cx, plural } from "@/components/ui";
import {
  type PersonAvailability,
  type SlotTally,
  SLOT_MINUTES,
  tallyWeek,
  weekDays,
} from "@/lib/availability-resolve";
import {
  type PlainDate,
  addDays,
  clockOf,
  clockWithDay,
  formatDate,
  localZone,
  todayIn,
  weekStart,
} from "@/lib/zoned-time";

/**
 * When everybody is free, as one week at a glance.
 *
 * The whole point of collecting general availability is this picture: the
 * darkest column is the evening to run the thing on, and it takes no reading.
 * A table of names and times would hold the same facts and answer nothing.
 *
 * ## Why the counting happens here and not on the server
 *
 * The grid is drawn in the *reader's* zone, and the server has no idea what
 * that is. Rendering it server-side would mean picking a zone for everybody —
 * which is exactly the bug this codebase already fixed once, when times were
 * rendered in the server's clock under a heading claiming the reader's.
 *
 * So the page sends raw rules and the browser resolves them. It is a few dozen
 * people times a few windows; the arithmetic is nothing next to the round trip
 * it saves on every week you page through.
 *
 * ## Reading the colours
 *
 * Darkness is share-of-the-best, not share-of-everybody. Against everybody,
 * a community where half the members never answer would render as a uniform
 * dark wash with no shape in it. Against the best slot of the week, the
 * strongest cell is always full strength and every other cell says how it
 * compares — which is the question being asked.
 *
 * Maybes are counted at half weight and drawn in the same hue. Splitting them
 * into a second colour turns a heatmap into something you have to consult a
 * key for, and the hover list says exactly who is a maybe anyway.
 */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Sensible for a community that plays in the evening; both ends adjustable. */
const DEFAULT_WINDOW = { startMinute: 14 * 60, endMinute: 25 * 60 };

/*
 * Starts stop at 23:00, not midnight: `clockOf(1440)` reads "00:00", which
 * would put the same face at both ends of the list. Ends run past it, to 05:00
 * the next morning, and say which day they land on.
 */
const WINDOW_STARTS = Array.from({ length: 24 }, (_unused, hour) => hour * 60);
const WINDOW_ENDS = Array.from({ length: 25 }, (_unused, index) => (index + 5) * 60);

export default function AvailabilityGrid({
  people,
  /** Monday of the week the server read, as "YYYY-MM-DD". */
  weekOf,
  onWeek,
}: {
  people: PersonAvailability[];
  weekOf: string;
  onWeek: (monday: string) => void;
}) {
  const [window, setWindow] = useState(DEFAULT_WINDOW);
  const [hovered, setHovered] = useState<{ day: number; slot: number } | null>(null);

  const zone = localZone();
  const monday = useMemo<PlainDate>(() => {
    const [year, month, day] = weekOf.split("-").map(Number);
    return weekStart({ year, month, day });
  }, [weekOf]);

  const days = useMemo(() => weekDays(monday), [monday]);

  const grid = useMemo(
    () => tallyWeek(people, days, window, zone),
    [people, days, window, zone]
  );

  const rows = grid[0]?.length ?? 0;
  const best = useMemo(() => {
    let top = 0;
    for (const column of grid) {
      for (const slot of column) top = Math.max(top, weight(slot));
    }
    return top;
  }, [grid]);

  const today = todayIn(zone);
  const active = hovered ? grid[hovered.day]?.[hovered.slot] : null;

  if (people.length === 0) {
    return (
      <EmptyState>
        Nobody has filled in their general availability yet. It lives on their profile, under
        “When are you generally free?”.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      {/* --- Controls ------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => onWeek(formatDate(addDays(monday, -7)))}>
            ←
          </Button>
          <Button size="sm" onClick={() => onWeek(formatDate(weekStart(today)))}>
            This week
          </Button>
          <Button size="sm" onClick={() => onWeek(formatDate(addDays(monday, 7)))}>
            →
          </Button>
        </div>

        <span className="text-[14px] text-chalk">
          {rangeLabel(monday)}
        </span>

        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          Show
          <select
            className="field w-auto py-1 text-[12.5px]"
            value={window.startMinute}
            onChange={(input) => {
              const start = Number(input.target.value);
              setWindow((was) => ({
                startMinute: start,
                endMinute: Math.max(was.endMinute, start + 60),
              }));
            }}
          >
            {WINDOW_STARTS.map((minute) => (
              <option key={minute} value={minute}>
                {clockOf(minute)}
              </option>
            ))}
          </select>
          to
          <select
            className="field w-auto py-1 text-[12.5px]"
            value={window.endMinute}
            onChange={(input) => {
              const end = Number(input.target.value);
              setWindow((was) => ({
                startMinute: Math.min(was.startMinute, end - 60),
                endMinute: end,
              }));
            }}
          >
            {WINDOW_ENDS.filter((minute) => minute > window.startMinute).map((minute) => (
              <option key={minute} value={minute}>
                {clockWithDay(minute)}
              </option>
            ))}
          </select>
        </label>

        <Badge>{plural(people.length, "member")} answered</Badge>
        <span className="text-[12.5px] text-dim">Times are {zone}</span>
      </div>

      {/* --- The grid ------------------------------------------------ */}
      <div className="overflow-x-auto overflow-y-hidden">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-px">
            <div />
            {days.map((day, index) => {
              const isToday = formatDate(day) === formatDate(today);
              return (
                <div key={index} className="pb-2 text-center">
                  <div
                    className={cx(
                      "text-[12.5px] font-medium",
                      isToday ? "text-union" : "text-muted"
                    )}
                  >
                    {DAY_LABELS[index]}
                  </div>
                  <div className="num text-[11px] text-dim">{day.day}</div>
                </div>
              );
            })}

            {Array.from({ length: rows }, (_unused, slot) => {
              const minute = window.startMinute + slot * SLOT_MINUTES;
              // Label the hours only; a label on every half hour is a wall of
              // numbers you stop reading after the third one.
              const onTheHour = minute % 60 === 0;
              return [
                <div
                  key={`t-${slot}`}
                  className="num pr-2 text-right text-[11px] leading-[1.6rem] text-dim"
                >
                  {onTheHour ? clockWithDay(minute) : ""}
                </div>,
                ...days.map((day, dayIndex) => {
                  const cell = grid[dayIndex][slot];
                  const isHovered =
                    hovered?.day === dayIndex && hovered?.slot === slot;
                  return (
                    <button
                      key={`${dayIndex}-${slot}`}
                      type="button"
                      onMouseEnter={() => setHovered({ day: dayIndex, slot })}
                      onFocus={() => setHovered({ day: dayIndex, slot })}
                      onMouseLeave={() => setHovered(null)}
                      onBlur={() => setHovered(null)}
                      aria-label={`${DAY_LABELS[dayIndex]} ${clockWithDay(minute)}: ${
                        cell.yes.length
                      } free${cell.maybe.length > 0 ? `, ${cell.maybe.length} maybe` : ""}`}
                      className={cx(
                        "h-[1.6rem] w-full rounded-[3px] transition-[background-color,box-shadow] duration-100",
                        isHovered && "ring-1 ring-union",
                        onTheHour && "border-t border-t-hair/60"
                      )}
                      style={{ backgroundColor: shade(weight(cell), best) }}
                    />
                  );
                }),
              ];
            })}
          </div>
        </div>
      </div>

      {/* --- Who -----------------------------------------------------
        A panel under the grid rather than a floating tooltip: forty names do
        not fit in a tooltip, and a tooltip that scrolls is one you cannot
        reach without losing it. It keeps the last slot you pointed at, so the
        list is still there when your mouse has moved to read it.
      */}
      <div className="min-h-[5.5rem] rounded-xl bg-panel px-5 py-4">
        {!active ? (
          <p className="text-[13px] text-dim">
            Point at a slot to see who is free in it. The darker the cell, the more people.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[14px] text-chalk">
                {DAY_LABELS[hovered!.day]} {days[hovered!.day].day}{" "}
                {clockOf(window.startMinute + hovered!.slot * SLOT_MINUTES)} –{" "}
                {clockOf(window.startMinute + (hovered!.slot + 1) * SLOT_MINUTES)}
              </span>
              <Badge tone={active.yes.length > 0 ? "gold" : undefined}>
                {plural(active.yes.length, "free")}
              </Badge>
              {active.maybe.length > 0 && <Badge>{active.maybe.length} maybe</Badge>}
            </div>

            {active.yes.length === 0 && active.maybe.length === 0 ? (
              <p className="text-[13px] text-muted">Nobody.</p>
            ) : (
              <div className="flex flex-wrap gap-x-2 gap-y-1.5">
                {active.yes.map((name) => (
                  <span
                    key={`y-${name}`}
                    className="rounded bg-union/15 px-2 py-0.5 text-[12.5px] text-chalk"
                  >
                    {name}
                  </span>
                ))}
                {active.maybe.map((name) => (
                  <span
                    key={`m-${name}`}
                    className="rounded bg-white/[0.05] px-2 py-0.5 text-[12.5px] text-muted"
                    title="Said maybe"
                  >
                    {name} ·
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A maybe is half a yes — enough to shade a cell, not enough to plan on. */
function weight(slot: SlotTally): number {
  return slot.yes.length + slot.maybe.length * 0.5;
}

/**
 * The cell colour.
 *
 * One hue, opacity carrying the count, on the page's own ground. A rainbow
 * scale would need a key; a single deepening blue is read without one, and it
 * keeps the accent meaning what it means everywhere else on the site.
 *
 * The floor at 0.06 is deliberate: an empty slot still has to look like a
 * cell, or the grid dissolves into its own background and stops reading as a
 * calendar at all.
 */
function shade(value: number, best: number): string {
  if (best <= 0 || value <= 0) return "rgba(255, 255, 255, 0.035)";
  const share = Math.min(1, value / best);
  // Square-rooted, so the difference between one person and three is visible
  // rather than crushed into the bottom of a linear ramp.
  const alpha = 0.1 + Math.sqrt(share) * 0.62;
  return `rgba(77, 127, 255, ${alpha.toFixed(3)})`;
}

function rangeLabel(monday: PlainDate): string {
  const sunday = addDays(monday, 6);
  const month = (date: PlainDate) =>
    new Date(Date.UTC(date.year, date.month - 1, date.day)).toLocaleDateString(undefined, {
      month: "short",
      timeZone: "UTC",
    });
  return monday.month === sunday.month
    ? `${monday.day}–${sunday.day} ${month(monday)} ${monday.year}`
    : `${monday.day} ${month(monday)} – ${sunday.day} ${month(sunday)} ${monday.year}`;
}
