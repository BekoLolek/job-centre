"use client";

import LocalTime from "@/components/format/LocalTime";
import ZoneNote from "@/components/format/ZoneNote";
import { matchStatusLabel, seriesLabel } from "@/components/format/labels";
import {
  type ScheduleDay,
  groupByDay,
  matchTone,
  matchToneClass,
  matchToneNote,
  upNext,
} from "@/components/format/board";
import { EmptyState, Eyebrow, Panel, cx, plural } from "@/components/ui";
import type { ResolvedMatch } from "@/lib/format-resolve";

/**
 * The Schedule tab (§4, §10): day by day, every time in the reader's own zone,
 * with what is next called out.
 *
 * **A client component, and it has to be.** Instants are stored absolute, so
 * the only honest zone to print one in is the reader's — which the server does
 * not know, and which on Vercel would come out as UTC. Every clock on this page
 * is therefore rendered below this boundary, and the zone used is stated at the
 * top so nobody has to guess whose evening 19:40 is.
 *
 * **The days are the organiser's, not the reader's calendar.** A Saturday
 * session that overruns to 00:20 is still Saturday to everybody playing it, so
 * the day comes from the block plan rather than from `Date#getDate` — which
 * would also have split the page differently on the server and in the browser,
 * and a *structural* hydration mismatch is not something a suppressed text node
 * can fix. See `groupByDay`.
 *
 * Two things are deliberately not hidden. A match with no time yet is listed
 * under "not scheduled" rather than dropped, because a bracket slot waiting on
 * a time is information. And the running order comes from the *matches*, not
 * from the `event_days` rows — those are the plan, and this is what is actually
 * happening. With no matches at all the plan is all there is, so that is what
 * it falls back to.
 */

export type ScheduleDayRow = {
  id: string;
  dayIndex: number;
  label: string | null;
  startsAt: string | null;
};

export type ScheduleTabProps = {
  matches: ResolvedMatch[];
  /** Which day each slot runs on, from the block plan. */
  dayBySlot: Record<string, number>;
  /** The organiser's `event_days`, for an event with no matches drawn yet. */
  days: ScheduleDayRow[];
};

export default function ScheduleTab({ matches, dayBySlot, days }: ScheduleTabProps) {
  const { days: playDays, undated } = groupByDay(matches, dayBySlot);
  const next = upNext(matches, 1)[0] ?? null;

  if (playDays.length === 0 && undated.length === 0) {
    return <PlannedDays days={days} />;
  }

  return (
    <section className="space-y-6">
      <Panel padding="md">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <Eyebrow>Running order</Eyebrow>
          <ZoneNote />
        </div>

        {next ? (
          <div className="mt-4 border border-gold/40 bg-gold/5 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <Eyebrow
                as="span"
                className={next.needsDecision ? "text-ember" : "text-gold"}
              >
                {/* A stalled series is at the front of the queue because it is
                    blocking, not because it is about to be played. */}
                {next.needsDecision
                  ? "Waiting on a decision"
                  : next.status === "live"
                    ? "On now"
                    : "Up next"}
              </Eyebrow>
              <LocalTime
                at={next.scheduledAt}
                className="text-xs text-chalk/80"
                fallback="Time to be confirmed"
              />
            </div>
            <p className="mt-2 text-lg">
              {next.nameA} <span className="text-muted">vs</span> {next.nameB}
            </p>
            <Eyebrow className="mt-1 text-muted/80">
              {next.displayLabel} · {seriesLabel(next.bestOf)}
            </Eyebrow>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted">
            Every match is in. Waiting on the last result to settle.
          </p>
        )}
      </Panel>

      {playDays.map((day) => (
        <DayPanel key={day.day} day={day} total={playDays.length} nextSlot={next?.slot} />
      ))}

      {undated.length > 0 && (
        <Panel as="section">
          <Eyebrow className="mb-1">Not scheduled yet</Eyebrow>
          <p className="mb-4 text-xs text-muted">
            {plural(undated.length, "match", "matches")} without a time. They take one as soon as
            the day in front of them is laid out.
          </p>
          <ul className="divide-y divide-hair/60">
            {undated.map((match) => (
              <MatchRow key={match.slot} match={match} />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}

function DayPanel({
  day,
  total,
  nextSlot,
}: {
  day: ScheduleDay;
  total: number;
  nextSlot?: string;
}) {
  return (
    <Panel as="section" padding="none">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hair px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          {total > 1 && <Eyebrow as="h3">Day {day.day}</Eyebrow>}
          <LocalTime at={day.startsAt} format="day" className="text-sm text-chalk" />
        </div>
        <Eyebrow as="span">
          {plural(day.matches.length, "match", "matches")} · from{" "}
          <LocalTime at={day.startsAt} format="clock" />
        </Eyebrow>
      </div>

      <ul className="divide-y divide-hair/60 px-5">
        {day.matches.map((match) => (
          <MatchRow key={match.slot} match={match} highlighted={match.slot === nextSlot} />
        ))}
      </ul>
    </Panel>
  );
}

/**
 * One line of the running order.
 *
 * A row, not a card: a schedule is read down the clock column, and four days of
 * full match cards is a page nobody scrolls to the bottom of. The bracket tab
 * is where the cards live.
 */
function MatchRow({ match, highlighted }: { match: ResolvedMatch; highlighted?: boolean }) {
  const tone = matchTone(match);
  const note = matchToneNote(match);

  return (
    <li
      className={cx(
        "-mx-5 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3",
        highlighted && "bg-gold/5"
      )}
    >
      <LocalTime
        at={match.scheduledAt}
        format="clock"
        fallback="--:--"
        className={cx("w-14 shrink-0 text-sm", highlighted ? "text-gold" : "text-chalk/80")}
      />

      <span className="min-w-0 flex-1 basis-56 text-sm">
        <span className={match.teamAId ? undefined : "italic text-muted"}>{match.nameA}</span>
        <span className="text-muted"> vs </span>
        <span className={match.teamBId ? undefined : "italic text-muted"}>{match.nameB}</span>
      </span>

      <Eyebrow as="span" className="shrink-0 text-muted/80">
        {match.displayLabel} · {seriesLabel(match.bestOf)}
      </Eyebrow>

      <Eyebrow as="span" className={cx("w-24 shrink-0 text-right", matchToneClass(tone))}>
        {note ?? (match.status === "done" ? matchStatusLabel(match) : "")}
      </Eyebrow>
    </li>
  );
}

/** No matches drawn yet — so the organiser's day plan is the whole schedule. */
function PlannedDays({ days }: { days: ScheduleDayRow[] }) {
  return (
    <Panel as="section">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <Eyebrow>Running order</Eyebrow>
        <ZoneNote />
      </div>

      {days.length === 0 ? (
        <EmptyState>No days set yet.</EmptyState>
      ) : (
        <ol className="space-y-2">
          {days.map((day) => (
            <li
              key={day.id}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-hair bg-raised px-4 py-3"
            >
              <span className="eyebrow">Day {day.dayIndex + 1}</span>
              <span className="text-sm">{day.label ?? `Day ${day.dayIndex + 1}`}</span>
              <LocalTime
                at={day.startsAt}
                className="ml-auto text-xs"
                fallback="Time to be confirmed"
              />
            </li>
          ))}
        </ol>
      )}

      <p className="mt-4 text-xs text-muted">
        The match-by-match running order appears here once the bracket has been drawn and given
        start times.
      </p>
    </Panel>
  );
}
