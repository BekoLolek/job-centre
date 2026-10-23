"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
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
import type { DependentFlag, FormatView } from "@/lib/format";
import { type MatchSlot, otherSlot, unresolvedSlotRefusal } from "@/lib/format-policy";
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
 * ## The mode a map was played on is recorded here (R-153 / UC-19 E1)
 *
 * `config.modeSequence` is the *plan* — "a Bo3 is convoy, convoy, domination"
 * — and the Format tab owns it. What the room actually played is a different
 * fact, and UC-19 E1 puts it on this card beside the map and the score. Every
 * game's mode field arrives filled in from the plan, so an untouched card
 * records exactly what was intended and only an edit says otherwise.
 *
 * ## A drawn series is not a finished one
 *
 * Every game in and nobody ahead is a *stall*, not a result: somebody has to
 * advance, and nothing downstream resolves until an admin says who. Those
 * matches are collected at the top of the tab rather than left to be found, and
 * the override is one tap from there as well as from inside the card.
 *
 * ## A card with nobody in it cannot be filled in (UC-19 precondition 1)
 *
 * "Upper final" exists as five empty game rows from the moment the bracket is
 * generated, long before anybody can play it. Recording against it would give
 * whichever teams arrive later a scoreline they did not play, so the editor does
 * not open: the card says what the slot is waiting on instead. `recordGames`
 * refuses it too — this only stops the click, exactly as the coin does.
 *
 * ## And a correction that moved a later team is said out loud
 *
 * Correcting a map re-propagates the bracket on the next read, which is the
 * whole design — but a *later* match that already had maps recorded is the one
 * case propagation cannot fix, because those maps were played by the team that
 * used to resolve there. The save hands those matches back (UC-19 3a) and they
 * are shown beside what moved in the schedule, because neither is something an
 * admin should have to go looking for.
 */

type View = "day" | "bracket";

export default function ResultsTab({
  format,
  matchIds,
}: {
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
  /** UC-19 3a — later matches the last save moved a team under. */
  const [flagged, setFlagged] = useState<DependentFlag[]>([]);
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
  const adopt = (next: FormatView | null, editedSlot: string, flags: DependentFlag[] = []) => {
    if (!next) return;
    const moved = scheduleShifts(board, next).filter((shift) => shift.slot !== editedSlot);
    setBoard(next);
    setShifts(moved.length > 0 ? moved : []);
    setFlagged(flags);
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
      const result = await recordGamesAction(id, fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      let next = result.data.view;
      let flags = result.data.flagged;

      // The override is its own write because it is its own decision: the games
      // say what happened, the override says who advances anyway.
      if (override !== undefined && override !== (match.winnerOverrideId ?? "")) {
        const decided = await setWinnerOverrideAction(id, override || null);
        if (!decided.ok) {
          setError(decided.error);
          return;
        }
        next = decided.data.view;
        // Both writes moved the board, so both their flags belong to this save.
        flags = [...flags, ...decided.data.flagged.filter((flag) => !flags.some((seen) => seen.slot === flag.slot))];
      }

      adopt(next, match.slot, flags);
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
      const result = await setWinnerOverrideAction(id, teamId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      adopt(result.data.view, match.slot, result.data.flagged);
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
      const result = await reflipMatchAction(id, slot);
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
      const result = await clearMatchAction(id, match.games.length);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      adopt(result.data.view, match.slot, result.data.flagged);
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
        <Alert tone={shifts.length > 0 ? "union" : "success"}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {shifts.length === 0
                ? "Saved · nothing later moved"
                : `Saved · ${plural(shifts.length, "later match", "later matches")} moved`}
            </span>
            <Eyebrow
              as="button"
              className="text-inherit underline decoration-dotted"
              onClick={() => setShifts(null)}
            >
              Dismiss
            </Eyebrow>
          </div>
          {shifts.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-12 opacity-90">
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

      {/* --- A later match whose team moved under recorded maps (3a) - */}
      <FlaggedAlert
        flagged={flagged}
        teams={board.teams}
        onDismiss={() => setFlagged([])}
      />

      {/* --- Drawn series waiting on a decision --------------------- */}
      {undecided.length > 0 && (
        <Panel as="section" padding="none" className="space-y-3 border-flare/40 border-t border-hair pt-12 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <Eyebrow className="text-flare">Needs a winner</Eyebrow>
            <Badge tone="flare">{undecided.length}</Badge>
          </div>
          <p className="text-12 leading-relaxed text-muted">
            Every game is in and nobody is ahead. A drawn table game is a finished match worth
            a point each, but a drawn knockout series is not finished at all — somebody has to
            advance, and nothing after it resolves until you say who.
          </p>
          <ul className="space-y-2">
            {undecided.map((match) => (
              <li
                key={match.slot}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-hair p-2"
              >
                <Eyebrow as="span" className="w-40 shrink-0 truncate">
                  {match.displayLabel}
                </Eyebrow>
                <span className="num min-w-0 flex-1 truncate text-14">
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
                className="overflow-x-auto overflow-y-hidden"
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
                        <span className="min-w-0 flex-1 truncate text-14 text-chalk/80">
                          {block.label}
                        </span>
                        <span className="num text-11 text-muted">
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
                  <h3 className="font-display text-24 leading-none">
                    {stage.name}
                  </h3>
                  {stage.champion && (
                    <Badge tone="union">
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
/* What a correction moved (UC-19 3a)                                 */
/* ------------------------------------------------------------------ */

/**
 * The later matches the last save moved a team under, said in full.
 *
 * Its own component rather than a branch inside the tab because this is the
 * message that has to be *right*: it is what a manager reads before deciding
 * whether a recorded series still happened. A component can be rendered and
 * read back in a test; a branch three hundred lines inside a client component
 * driven by state cannot.
 *
 * It names teams rather than ids, and "nobody" rather than a blank, because a
 * slot that has gone back to waiting is the same trouble as one that changed
 * hands and a gap in a sentence reads like a bug.
 */
export function FlaggedAlert({
  flagged,
  teams,
  onDismiss,
}: {
  flagged: DependentFlag[];
  teams: FormatView["teams"];
  onDismiss: () => void;
}) {
  if (flagged.length === 0) return null;
  const named = (id: string | null): string =>
    (id && teams.find((team) => team.id === id)?.name) || "nobody";
  const one = flagged.length === 1;

  return (
    <Alert tone="flare">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {plural(flagged.length, "later match", "later matches")} now{" "}
          {one ? "has" : "have"} a different team, and {one ? "has" : "have"} maps
          recorded already
        </span>
        <Eyebrow
          as="button"
          className="text-inherit underline decoration-dotted"
          onClick={onDismiss}
        >
          Dismiss
        </Eyebrow>
      </div>
      <ul className="mt-2 space-y-0.5 text-12 opacity-90">
        {flagged.map((flag) => (
          <li key={flag.slot} className="flex flex-wrap items-baseline gap-2">
            <span>{flag.label}</span>
            <span className="num">
              {named(flag.before.a)} v {named(flag.before.b)} → {named(flag.after.a)} v{" "}
              {named(flag.after.b)}
            </span>
            <span className="opacity-70">({plural(flag.playedGames, "map")} recorded)</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-12 leading-relaxed">
        Those maps were played by the teams on the left. Check each one and clear it if it is
        no longer the series that was played — nothing has been changed for you.
      </p>
    </Alert>
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
    /** Which mode this map was actually played on (R-153 / UC-19 E1). */
    mode: string;
    map: string;
    referee: string;
    scoreA: string;
    scoreB: string;
    played: boolean;
    /** `attack`, `defence`, or "" for not recorded. A note, never the rule. */
    sideChosen: string;
  }>;
};

/**
 * What a freshly opened card holds.
 *
 * Exported beside `recordFieldsFrom` and `MatchEditor`, because the pair of
 * them is the whole round trip — what the card shows and what it posts — and a
 * test that wrote its own copy of this would be testing its own copy.
 */
export function draftFrom(match: ResolvedMatch): Draft {
  return {
    // The input is naive; it shows the instant in the admin's own zone.
    scheduledAt: toLocalInput(match.scheduledAt),
    durationMin: match.durationMin === null ? "" : String(match.durationMin),
    winnerOverride: match.winnerOverrideId ?? "",
    games: match.games.map((game, index) => ({
      // The generated plan is what a card starts with — `blankGamesFor` copies
      // the stage's mode sequence onto every game — so an untouched field posts
      // the mode back unchanged and only an edit records a different one.
      mode: game.mode || match.modes[index] || "",
      map: game.map,
      referee: game.referee,
      scoreA: String(game.scoreA),
      scoreB: String(game.scoreB),
      played: game.played,
      sideChosen: game.sideChosen ?? "",
    })),
  };
}

/**
 * **What one card posts** (UC-19 3, E1, E3).
 *
 * Exported because `renderToStaticMarkup` runs no handlers, so the only way to
 * read back what Save sends is to call the function that builds it — the same
 * argument `FlaggedAlert` is exported under.
 *
 * ## The start is left out unless it moved (R-157 / UC-19 E2)
 *
 * `recordGamesAction` passes `scheduledAt` to `setMatchSchedule` whenever the
 * key is *present*, and a start time moved by hand marks its stage hand-edited
 * so that nothing ever regenerates it automatically (UC-18 9a). A form posts
 * every field it holds, so sending the card's own start back on every save
 * marked the stage on the strength of a field nobody touched — including on a
 * card with no start time at all, where the write was `null` over `null`.
 *
 * Compared as the *field's* text rather than as two instants, because that is
 * the question being asked: a `datetime-local` value carries minutes, so a
 * start stored with seconds on it would never match its own round trip.
 */
export function recordFieldsFrom(match: ResolvedMatch, form: Draft): RecordFields {
  const moved = form.scheduledAt !== toLocalInput(match.scheduledAt);
  return {
    ...(moved ? { scheduledAt: form.scheduledAt ? toInstant(form.scheduledAt) : null } : {}),
    durationMin: form.durationMin === "" ? null : Number(form.durationMin),
    games: form.games.map((game, index) => ({
      index,
      mode: game.mode,
      map: game.map,
      referee: game.referee,
      scoreA: Number(game.scoreA || 0),
      scoreB: Number(game.scoreB || 0),
      played: game.played,
      sideChosen: game.sideChosen || null,
    })),
  };
}

/**
 * One card's editor — the times, the coin, a row per game and the override.
 *
 * Exported for the reason `FlaggedAlert` is: it is shut until somebody clicks
 * it open, so a server render of the tab holds none of it, and the fields it
 * offers — the mode a map was played on, the minutes the match took — are
 * exactly what UC-19 E1 and E3 are about.
 */
export function MatchEditor({
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

  /*
   * UC-19 precondition 1. A slot that has not resolved has no teams to record
   * for, so the editor never opens on one — `unresolvedSlotRefusal` is the same
   * sentence `recordGames` would answer with, said before the click rather than
   * after it. The clear button is still reachable from an open card, which is
   * what the server's own erasing exemption is for.
   */
  const waiting = unresolvedSlotRefusal(match);

  if (waiting) {
    const recorded = match.games.some((game) => game.played);
    return (
      <div className="space-y-2">
        <Button className="w-full py-1.5" disabled>
          Not played yet
        </Button>
        <p className="text-11 leading-relaxed text-dim">{waiting}</p>
        {/*
          A slot that has *stopped* resolving while carrying maps is UC-19 3a,
          and clearing it is the only way out — so the one destructive button is
          the one thing still offered here.
        */}
        {recorded && (
          <Button
            variant="flare"
            className="w-full py-1.5"
            disabled={busy}
            onClick={() => {
              if (confirm(`Clear every recorded game for ${match.displayLabel}?`)) onClear();
            }}
          >
            {busy ? "Clearing…" : "Clear the maps recorded here"}
          </Button>
        )}
      </div>
    );
  }

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
    onSave(recordFieldsFrom(match, form), form.winnerOverride);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className="flex-1">
          <Eyebrow as="span" className="mb-1 block text-inherit">Start</Eyebrow>
          <Field
            type="datetime-local"
            className="py-1.5 text-11"
            value={form.scheduledAt}
            onChange={(input) => setForm({ ...form, scheduledAt: input.target.value })}
          />
        </label>
        {/*
          How long the match took (R-158 / UC-19 E3). Not a note: an explicit
          duration fixes the finish at the start plus these minutes, and every
          later block of the day re-flows off that finish rather than off the
          planned length — which is the whole of "System uses it for that day's
          schedule". Left blank, the finish is stamped from the clock and the
          duration is derived from it.
        */}
        <label className="w-24">
          <Eyebrow as="span" className="mb-1 block text-inherit">Mins</Eyebrow>
          <Field
            inputMode="numeric"
            className="py-1.5 text-11"
            aria-label="How long the match took, in minutes"
            value={form.durationMin}
            onChange={(input) =>
              setForm({ ...form, durationMin: input.target.value.replace(/[^0-9]/g, "") })
            }
          />
        </label>
      </div>

      {/* --- The coin (§8.4) ----------------------------------- */}
      <div className="rounded-lg border border-hair p-2">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <Eyebrow as="span">Coin</Eyebrow>
          {started && <span className="text-11 text-dim">fixed</span>}
        </div>
        <p className="text-11 leading-relaxed text-muted">
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
          <p className="mt-1.5 text-11 leading-relaxed text-dim">
            A game has been played under this coin. Clear the series first if it really was
            called wrongly.
          </p>
        )}
      </div>

      {form.games.map((game, index) => (
        <div key={index} className="rounded-lg border border-hair p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <Eyebrow as="span">
              G{index + 1} · {modeLabel(game.mode)}
            </Eyebrow>
            {/* The primitive, for the 44px hit area it carries (Task 38b): this
                sat in an eyebrow-sized label, so the box was 16px in a row
                about 20px tall and well under the touch floor. `Eyebrow`
                rather than the raw `.eyebrow` class, which the primitives
                replaced everywhere outside `components/ui`, and it keeps the
                words matched to the `G1 · mode` label opposite. */}
            <Checkbox
              checked={game.played}
              onChange={(played) => patchGame(index, { played })}
              label={<Eyebrow as="span">Played</Eyebrow>}
            />
          </div>

          {match.choices[index] && (
            <p className="mb-1.5 text-11 leading-relaxed text-dim">
              {choiceLine(match.choices[index])}
            </p>
          )}

          {/*
            The mode this map was *actually* played on (R-153 / UC-19 E1).
            It arrives filled in from the stage's mode sequence, which is the
            plan — a Bo3's third map is a domination until somebody says the
            room played a convoy instead, and R-153 asks for the record to be
            able to say so. Editable here and nowhere else: the Format tab sets
            the sequence a series is *planned* under, which is a different fact
            and lives in `config.modeSequence`.
          */}
          <Field
            className="mb-1.5 py-1.5 text-11"
            placeholder="Mode"
            aria-label={`Mode played, game ${index + 1}`}
            maxLength={40}
            value={game.mode}
            onChange={(input) => patchGame(index, { mode: input.target.value })}
          />
          <Field
            className="mb-1.5 py-1.5 text-11"
            placeholder="Map"
            value={game.map}
            onChange={(input) => patchGame(index, { map: input.target.value })}
          />
          <Field
            className="mb-1.5 py-1.5 text-11"
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
            className="mb-1.5 py-1.5 text-11"
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
              className="py-1.5 text-11"
              aria-label={`${match.nameA} score, game ${index + 1}`}
              value={game.scoreA}
              onChange={(input) => setScore(index, "scoreA", input.target.value)}
            />
            <Eyebrow as="span" className="shrink-0">
              vs
            </Eyebrow>
            <Field
              inputMode="numeric"
              className="py-1.5 text-11"
              aria-label={`${match.nameB} score, game ${index + 1}`}
              value={game.scoreB}
              onChange={(input) => setScore(index, "scoreB", input.target.value)}
            />
          </div>
        </div>
      ))}

      <label className="block">
        <Eyebrow as="span" className="mb-1 block text-inherit">
          Winner override {match.needsDecision && <span className="text-flare">· needed</span>}
        </Eyebrow>
        <Select
          className="py-1.5 text-11"
          value={form.winnerOverride}
          onChange={(input) => setForm({ ...form, winnerOverride: input.target.value })}
        >
          <option value="">Decide from the games</option>
          {match.teamAId && <option value={match.teamAId}>{match.nameA}</option>}
          {match.teamBId && <option value={match.teamBId}>{match.nameB}</option>}
        </Select>
      </label>

      <p className="text-11 leading-relaxed text-muted">
        {seriesLabel(match.bestOf)} · typing a score ticks the game off. Saving finishes the
        match once it is decided, and re-flows the rest of that day — from the minutes above
        when they are filled in, and from the clock when they are not.
      </p>

      <div className="flex gap-2">
        <Button variant="union" className="flex-1 py-1.5" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button className="py-1.5" disabled={busy} onClick={onOpen}>
          Cancel
        </Button>
        <Button
          variant="flare"
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
