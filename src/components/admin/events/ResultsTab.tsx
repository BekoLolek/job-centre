"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  Select,
  Tabs,
  plural,
} from "@/components/ui";
import {
  BracketCanvas,
  MatchCard,
  PLAY_SIDE_CHOICES,
  StandingsTable,
  choiceLine,
  dayBySlot,
  hhmm,
  modeLabel,
  scheduleShifts,
  seriesLabel,
  shiftText,
  type ScheduleShift,
} from "@/components/format";
import type { FormatView } from "@/lib/format";
import { type MatchSlot, otherSlot } from "@/lib/format-policy";
import type { ResolvedMatch } from "@/lib/format-resolve";
import { formatClock, toInstant, toLocalInput } from "@/lib/time";
import {
  type RecordFields,
  clearMatchAction,
  recordGamesAction,
  reflipMatchAction,
  setWinnerOverrideAction,
} from "@/app/admin/events/format-actions";

/**
 * Results — the match cards, and what recording one does to the rest of the day.
 *
 * ## The interaction is the old board's, deliberately
 *
 * The card, the expanding editor, the fields in it and the rule that typing a
 * score marks the game played have all been used live and are kept exactly.
 * What changes is where the data comes from: the old card posted a
 * `saveMatch` blob at one JSON endpoint that owned a four-team tournament, and
 * this calls the format engine's server actions against a stage of any shape.
 * That is the whole of the port — no behaviour was redesigned on the way.
 *
 * ## The re-flow is shown, not just done
 *
 * Recording a result finishes the match, which fixes its duration, which moves
 * every later block that day (§10). All three happen inside one transaction and
 * the action hands the whole re-read board back, so this diffs the board it had
 * against the one it got and says which matches moved and by how much. A
 * schedule that quietly rearranges itself while you are typing is a schedule
 * nobody trusts, and "nine matches moved" is exactly the sort of thing an admin
 * needs to see before they tell nine teams a time.
 *
 * ## The coin is here too, because this is where it goes wrong
 *
 * §8.4 gives one team the side choice and the other the map, swapping every
 * game, and a coin decides who starts. Coins get called in front of a room and
 * rooms get them wrong, so the card carries a re-flip and a "give it to the
 * other team" next to the result it belongs with. Both are refused by
 * `reflipMatch` once a game of that series has been ticked off — the whole
 * series was played under that coin, and moving it afterwards would silently
 * re-attribute every map in it.
 *
 * ## A drawn series is not a finished one
 *
 * Every game in and nobody ahead is a *stall*, not a result: somebody has to
 * advance, and nothing downstream resolves until an admin says who. Those
 * matches are collected at the top of the tab rather than left to be found, and
 * the override is one tap from there as well as from inside the card.
 */

type View = "day" | "bracket";

export default function ResultsTab({
  eventId,
  format,
  matchIds,
}: {
  eventId: string;
  format: FormatView;
  /**
   * Slot to row id — `matchIdsFor`, read on the server.
   *
   * A `ResolvedMatch` carries no id, because it is a generated slot plus
   * whatever is stored against it and the generated half has no row. The
   * writes need the row, so the page hands the mapping down. It only changes
   * when a stage is regenerated, which re-renders this page anyway.
   */
  matchIds: Record<string, string>;
}) {
  const router = useRouter();

  /**
   * The board, owned locally so a save can be compared with what was on screen
   * a moment ago. It is re-seeded whenever the server page re-renders, which is
   * what keeps it from drifting away from the database.
   */
  const [board, setBoard] = useState<FormatView>(format);
  useEffect(() => setBoard(format), [format]);

  const [view, setView] = useState<View>("day");
  const [day, setDay] = useState<number | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [shifts, setShifts] = useState<ScheduleShift[] | null>(null);
  const [openSlot, setOpenSlot] = useState<string | null>(null);

  /**
   * Only the matches that actually exist as rows.
   *
   * `formatFor` resolves a stage's matches from its generated spec whether or
   * not it has been generated — which is what makes the Format tab's preview
   * possible, and what would otherwise put uneditable cards on this tab for a
   * bracket that has never been written.
   */
  const matches = useMemo(
    () => board.stages.flatMap((stage) => stage.matches).filter((match) => matchIds[match.slot]),
    [board.stages, matchIds]
  );
  const bySlot = useMemo(() => new Map(matches.map((match) => [match.slot, match])), [matches]);
  const idBySlot = useMemo(() => new Map(Object.entries(matchIds)), [matchIds]);
  const days = useMemo(() => dayBySlot(board.blocks), [board.blocks]);
  const dayList = useMemo(
    () => [...new Set(board.blocks.map((block) => block.day))].sort((x, y) => x - y),
    [board.blocks]
  );

  const undecided = matches.filter((match) => match.needsDecision);
  const played = matches.filter((match) => match.status === "done").length;

  if (matches.length === 0) {
    return (
      <Panel as="section" padding="none" className="space-y-3 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>Results</Eyebrow>
        <EmptyState>
          No matches yet. Choose a format and generate them on the Format tab — the cards
          here are the generated matches, not something typed in twice.
        </EmptyState>
      </Panel>
    );
  }

  /** Apply a board the server just handed back, and say what moved. */
  const adopt = (next: FormatView | null, editedSlot: string) => {
    if (!next) return;
    const moved = scheduleShifts(board, next).filter((shift) => shift.slot !== editedSlot);
    setBoard(next);
    setShifts(moved.length > 0 ? moved : []);
    router.refresh();
  };

  const record = async (match: ResolvedMatch, fields: RecordFields, override?: string | null) => {
    const id = idBySlot.get(match.slot);
    if (!id) {
      setError("That match is not in the database yet — generate the stage first.");
      return;
    }
    setBusySlot(match.slot);
    setError(null);
    try {
      const result = await recordGamesAction(eventId, id, fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      let next = result.data.view;

      // The override is its own write because it is its own decision: the games
      // say what happened, the override says who advances anyway.
      if (override !== undefined && override !== (match.winnerOverrideId ?? "")) {
        const decided = await setWinnerOverrideAction(eventId, id, override || null);
        if (!decided.ok) {
          setError(decided.error);
          return;
        }
        next = decided.data.view;
      }

      adopt(next, match.slot);
      setOpenSlot(null);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusySlot(null);
    }
  };

  const decide = async (match: ResolvedMatch, teamId: string | null) => {
    const id = idBySlot.get(match.slot);
    if (!id) return;
    setBusySlot(match.slot);
    setError(null);
    try {
      const result = await setWinnerOverrideAction(eventId, id, teamId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      adopt(result.data.view, match.slot);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusySlot(null);
    }
  };

  const reflip = async (match: ResolvedMatch, slot: MatchSlot | null) => {
    const id = idBySlot.get(match.slot);
    if (!id) return;
    setBusySlot(match.slot);
    setError(null);
    try {
      const result = await reflipMatchAction(eventId, id, slot);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      adopt(result.data.view, match.slot);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusySlot(null);
    }
  };

  const clear = async (match: ResolvedMatch) => {
    const id = idBySlot.get(match.slot);
    if (!id) return;
    setBusySlot(match.slot);
    setError(null);
    try {
      const result = await clearMatchAction(eventId, id, match.games.length);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      adopt(result.data.view, match.slot);
      setOpenSlot(null);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusySlot(null);
    }
  };

  const editorFor = (match: ResolvedMatch) => (
    <MatchEditor
      match={match}
      open={openSlot === match.slot}
      busy={busySlot === match.slot}
      onOpen={() => setOpenSlot(openSlot === match.slot ? null : match.slot)}
      onSave={(fields, override) => void record(match, fields, override)}
      onDecide={(teamId) => void decide(match, teamId)}
      onClear={() => void clear(match)}
      onReflip={(slot) => void reflip(match, slot)}
    />
  );

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- What the last save moved ------------------------------ */}
      {shifts !== null && (
        <Alert tone={shifts.length > 0 ? "gold" : "signal"}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {shifts.length === 0
                ? "Saved · nothing later moved"
                : `Saved · ${plural(shifts.length, "later match", "later matches")} moved`}
            </span>
            <button
              type="button"
              className="eyebrow underline decoration-dotted"
              onClick={() => setShifts(null)}
            >
              Dismiss
            </button>
          </div>
          {shifts.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs opacity-90">
              {shifts.slice(0, 8).map((shift) => (
                <li key={shift.slot} className="flex flex-wrap items-baseline gap-2">
                  <span>{shift.label}</span>
                  <span className="num">
                    {shift.from ? formatClock(shift.from) : "—"} →{" "}
                    {shift.to ? formatClock(shift.to) : "—"}
                  </span>
                  <span className="opacity-70">({shiftText(shift)})</span>
                </li>
              ))}
              {shifts.length > 8 && (
                <li className="opacity-70">and {shifts.length - 8} more</li>
              )}
            </ul>
          )}
        </Alert>
      )}

      {/* --- Drawn series waiting on a decision --------------------- */}
      {undecided.length > 0 && (
        <Panel as="section" padding="none" className="space-y-3 border-ember/40 border-t border-hair pt-12 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <Eyebrow className="text-ember">Needs a winner</Eyebrow>
            <Badge tone="ember">{undecided.length}</Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Every game is in and nobody is ahead. A drawn table game is a finished match worth
            a point each, but a drawn knockout series is not finished at all — somebody has to
            advance, and nothing after it resolves until you say who.
          </p>
          <ul className="space-y-2">
            {undecided.map((match) => (
              <li
                key={match.slot}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-hair p-2"
              >
                <Eyebrow as="span" className="w-40 shrink-0 truncate">
                  {match.displayLabel}
                </Eyebrow>
                <span className="num min-w-0 flex-1 truncate text-sm">
                  {match.nameA} {match.gamesWonA}–{match.gamesWonB} {match.nameB}
                </span>
                <Button
                  size="sm"
                  disabled={busySlot === match.slot || !match.teamAId}
                  onClick={() => void decide(match, match.teamAId)}
                >
                  {match.nameA} through
                </Button>
                <Button
                  size="sm"
                  disabled={busySlot === match.slot || !match.teamBId}
                  onClick={() => void decide(match, match.teamBId)}
                >
                  {match.nameB} through
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* --- The board --------------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow>Results</Eyebrow>
          <Badge>
            {played}/{matches.length} played
          </Badge>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Tabs
              aria-label="Grouping"
              rule={false}
              size="sm"
              items={[
                { value: "day", label: "By day" },
                { value: "bracket", label: "By bracket" },
              ]}
              value={view}
              onChange={setView}
            />
          </span>
        </div>

        {view === "day" ? (
          <>
            {dayList.length > 1 && (
              <Tabs
                items={[
                  { value: "all", label: "All days" },
                  ...dayList.map((entry) => ({
                    value: String(entry),
                    label: `Day ${entry}`,
                  })),
                ]}
                aria-label="Day"
                size="sm"
                value={day === "all" ? "all" : String(day)}
                onChange={(value) => setDay(value === "all" ? "all" : Number(value))}
                className="overflow-x-auto"
              />
            )}

            <div className="space-y-6">
              {board.blocks
                .filter((block) => day === "all" || block.day === day)
                .map((block) => {
                  const inBlock = block.slots
                    .map((slot) => bySlot.get(slot))
                    .filter((match): match is ResolvedMatch => Boolean(match));
                  if (inBlock.length === 0) return null;
                  const opens = inBlock
                    .map((match) => match.scheduledAt)
                    .filter((stamp): stamp is string => Boolean(stamp))
                    .sort()[0];

                  return (
                    <div key={block.index}>
                      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair pb-2">
                        <Eyebrow as="span" className="text-dim">
                          Day {block.day}
                        </Eyebrow>
                        <span className="min-w-0 flex-1 truncate text-sm text-chalk/80">
                          {block.label}
                        </span>
                        <span className="num text-[11px] text-muted">
                          {opens ? formatClock(opens) : "not scheduled"} · {hhmm(block.lengthMin)}
                        </span>
                      </div>

                      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {inBlock.map((match) => (
                          <li key={match.slot}>
                            <MatchCard match={match}>{editorFor(match)}</MatchCard>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
            </div>
          </>
        ) : (
          <div className="space-y-10">
            {board.stages
              .filter((stage) => stage.matches.some((match) => matchIds[match.slot]))
              .map((stage) => (
              <div key={stage.id} className="space-y-4">
                <div className="flex flex-wrap items-baseline gap-3">
                  <h3 className="font-display text-2xl leading-none">
                    {stage.name}
                  </h3>
                  {stage.champion && (
                    <Badge tone="gold">
                      Champion ·{" "}
                      {board.teams.find((team) => team.id === stage.champion)?.name ?? "—"}
                    </Badge>
                  )}
                </div>
                <BracketCanvas
                  matches={stage.matches}
                  featuredSlot={stage.spec.championSlot}
                  renderExtra={editorFor}
                />
              </div>
              ))}
          </div>
        )}
      </Panel>

      {/* --- The tables -------------------------------------------- */}
      {board.stages.some((stage) => stage.matches.some((match) => match.bracket === "rr")) && (
        <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
          <Eyebrow>Tables</Eyebrow>
          {board.stages
            .filter((stage) => stage.matches.some((match) => match.bracket === "rr"))
            .map((stage) => (
              <div key={stage.id} className="space-y-4">
                {stage.groups.length > 0 ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {stage.groups.map((group) => (
                      <div key={group.key} className="space-y-2">
                        <Eyebrow>
                          {stage.name} · Group {group.key.toUpperCase()}
                        </Eyebrow>
                        <StandingsTable rows={group.standings} showGames />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Eyebrow>{stage.name}</Eyebrow>
                    <StandingsTable rows={stage.standings} showGames />
                  </div>
                )}
              </div>
            ))}
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The editor                                                         */
/* ------------------------------------------------------------------ */

type Draft = {
  scheduledAt: string;
  durationMin: string;
  winnerOverride: string;
  games: Array<{
    map: string;
    referee: string;
    scoreA: string;
    scoreB: string;
    played: boolean;
    /** `attack`, `defence`, or "" for not recorded. A note, never the rule. */
    sideChosen: string;
  }>;
};

function draftFrom(match: ResolvedMatch): Draft {
  return {
    // The input is naive; it shows the instant in the admin's own zone.
    scheduledAt: toLocalInput(match.scheduledAt),
    durationMin: match.durationMin === null ? "" : String(match.durationMin),
    winnerOverride: match.winnerOverrideId ?? "",
    games: match.games.map((game) => ({
      map: game.map,
      referee: game.referee,
      scoreA: String(game.scoreA),
      scoreB: String(game.scoreB),
      played: game.played,
      sideChosen: game.sideChosen ?? "",
    })),
  };
}

function MatchEditor({
  match,
  open,
  busy,
  onOpen,
  onSave,
  onDecide,
  onClear,
  onReflip,
}: {
  match: ResolvedMatch;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onSave: (fields: RecordFields, override: string) => void;
  onDecide: (teamId: string | null) => void;
  onClear: () => void;
  /** A slot sets the coin outright; null tosses it again. */
  onReflip: (slot: MatchSlot | null) => void;
}) {
  const [form, setForm] = useState<Draft>(() => draftFrom(match));

  // A card that is not being edited follows the board. One that is does not —
  // a re-flow landing mid-sentence must not overwrite what is being typed.
  useEffect(() => {
    if (!open) setForm(draftFrom(match));
  }, [match, open]);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button className="w-full py-1.5" disabled={busy} onClick={onOpen}>
          {busy ? "Saving…" : match.status === "pending" ? "Record result" : "Edit result"}
        </Button>
        {match.needsDecision && (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={busy || !match.teamAId}
              onClick={() => onDecide(match.teamAId)}
            >
              {match.nameA} through
            </Button>
            <Button
              size="sm"
              className="flex-1"
              disabled={busy || !match.teamBId}
              onClick={() => onDecide(match.teamBId)}
            >
              {match.nameB} through
            </Button>
          </div>
        )}
      </div>
    );
  }

  /**
   * Typing a score marks the game as played. Without this an admin can fill in a
   * whole series, hit save, and have nothing count because a checkbox was left
   * untouched.
   */
  const setScore = (index: number, key: "scoreA" | "scoreB", raw: string) => {
    const value = raw.replace(/[^0-9]/g, "");
    setForm((current) => ({
      ...current,
      games: current.games.map((game, position) =>
        position === index
          ? { ...game, [key]: value, played: value !== "" ? true : game.played }
          : game
      ),
    }));
  };

  const patchGame = (index: number, change: Partial<Draft["games"][number]>) => {
    setForm((current) => ({
      ...current,
      games: current.games.map((game, position) =>
        position === index ? { ...game, ...change } : game
      ),
    }));
  };

  // The coin is fixed once anything has been played: the whole series was
  // played under it, so moving it afterwards would silently re-attribute every
  // map in it. `reflipMatch` refuses it too — this only stops the click.
  const started = match.games.some((game) => game.played);
  const first = match.choices[0];

  const save = () => {
    onSave(
      {
        scheduledAt: form.scheduledAt ? toInstant(form.scheduledAt) : null,
        durationMin: form.durationMin === "" ? null : Number(form.durationMin),
        games: form.games.map((game, index) => ({
          index,
          map: game.map,
          referee: game.referee,
          scoreA: Number(game.scoreA || 0),
          scoreB: Number(game.scoreB || 0),
          played: game.played,
          sideChosen: game.sideChosen || null,
        })),
      },
      form.winnerOverride
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="eyebrow mb-1 block">Start</span>
          <Field
            type="datetime-local"
            className="py-1.5 text-[11px]"
            value={form.scheduledAt}
            onChange={(input) => setForm({ ...form, scheduledAt: input.target.value })}
          />
        </label>
        <label className="w-24">
          <span className="eyebrow mb-1 block">Mins</span>
          <Field
            inputMode="numeric"
            className="py-1.5 text-[11px]"
            value={form.durationMin}
            onChange={(input) =>
              setForm({ ...form, durationMin: input.target.value.replace(/[^0-9]/g, "") })
            }
          />
        </label>
      </div>

      {/* --- The coin (§8.4) ----------------------------------- */}
      <div className="rounded-xl border border-hair p-2">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <Eyebrow as="span">Coin</Eyebrow>
          {started && <span className="text-[11px] text-dim">fixed</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          {first ? choiceLine(first) : "—"} in game 1. The two swap every game after it.
        </p>
        <div className="mt-1.5 flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={busy || started}
            onClick={() => onReflip(null)}
          >
            Re-flip
          </Button>
          <Button
            size="sm"
            className="min-w-0 flex-1 truncate"
            disabled={busy || started}
            onClick={() => onReflip(otherSlot(match.firstSideChoice))}
          >
            Give it to {first?.mapName ?? "the other team"}
          </Button>
        </div>
        {started && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
            A game has been played under this coin. Clear the series first if it really was
            called wrongly.
          </p>
        )}
      </div>

      {form.games.map((game, index) => (
        <div key={index} className="rounded-xl border border-hair p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <Eyebrow as="span">
              G{index + 1} · {modeLabel(match.games[index]?.mode ?? match.modes[index] ?? "")}
            </Eyebrow>
            <label className="eyebrow flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={game.played}
                onChange={(input) => patchGame(index, { played: input.target.checked })}
              />
              Played
            </label>
          </div>

          {match.choices[index] && (
            <p className="mb-1.5 text-[11px] leading-relaxed text-dim">
              {choiceLine(match.choices[index])}
            </p>
          )}

          <Field
            className="mb-1.5 py-1.5 text-[11px]"
            placeholder="Map"
            value={game.map}
            onChange={(input) => patchGame(index, { map: input.target.value })}
          />
          <Field
            className="mb-1.5 py-1.5 text-[11px]"
            placeholder="Referee"
            value={game.referee}
            onChange={(input) => patchGame(index, { referee: input.target.value })}
          />
          {/*
            What was taken, not who was entitled to take it — the second is
            derived and never typed. Leaving it blank changes nothing about the
            rule; it is a note on a card, and plenty of games are played without
            anybody writing it down.
          */}
          <Select
            className="mb-1.5 py-1.5 text-[11px]"
            aria-label={`Side taken by ${match.choices[index]?.sideName ?? "the choosing team"}, game ${index + 1}`}
            value={game.sideChosen}
            onChange={(input) => patchGame(index, { sideChosen: input.target.value })}
          >
            <option value="">Side not recorded</option>
            {PLAY_SIDE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {match.choices[index]?.sideName ?? "Chose"} took {choice.label.toLowerCase()}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2">
            <Field
              inputMode="numeric"
              className="py-1.5 text-[11px]"
              aria-label={`${match.nameA} score, game ${index + 1}`}
              value={game.scoreA}
              onChange={(input) => setScore(index, "scoreA", input.target.value)}
            />
            <Eyebrow as="span" className="shrink-0">
              vs
            </Eyebrow>
            <Field
              inputMode="numeric"
              className="py-1.5 text-[11px]"
              aria-label={`${match.nameB} score, game ${index + 1}`}
              value={game.scoreB}
              onChange={(input) => setScore(index, "scoreB", input.target.value)}
            />
          </div>
        </div>
      ))}

      <label className="block">
        <span className="eyebrow mb-1 block">
          Winner override {match.needsDecision && <span className="text-ember">· needed</span>}
        </span>
        <Select
          className="py-1.5 text-[11px]"
          value={form.winnerOverride}
          onChange={(input) => setForm({ ...form, winnerOverride: input.target.value })}
        >
          <option value="">Decide from the games</option>
          {match.teamAId && <option value={match.teamAId}>{match.nameA}</option>}
          {match.teamBId && <option value={match.teamBId}>{match.nameB}</option>}
        </Select>
      </label>

      <p className="text-[11px] leading-relaxed text-muted">
        {seriesLabel(match.bestOf)} · typing a score ticks the game off. Saving finishes the
        match once it is decided, and re-flows the rest of that day.
      </p>

      <div className="flex gap-2">
        <Button variant="gold" className="flex-1 py-1.5" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button className="py-1.5" disabled={busy} onClick={onOpen}>
          Cancel
        </Button>
        <Button
          variant="ember"
          className="py-1.5"
          disabled={busy}
          onClick={() => {
            if (confirm(`Clear every recorded game for ${match.displayLabel}?`)) onClear();
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
