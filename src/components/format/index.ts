/**
 * Everything the format engine's output is *drawn* with — shared by the admin's
 * Format, Schedule and Results tabs and by the public bracket, schedule and
 * results pages.
 *
 * The split from `src/components/ui/` is the same one `src/components/draft/`
 * makes: `ui/` knows nothing about this application, whereas everything here
 * knows what a bracket slot and a series are. It knows no *rules* though —
 * every number comes from `src/lib/bracket.ts`, `src/lib/format-policy.ts` or
 * `src/lib/format-resolve.ts`, and nothing here recomputes one.
 *
 * Nothing in this folder knows who is looking at it. There is no `editable`
 * prop and no admin action anywhere: the cards take a `children` slot and the
 * canvas a `renderExtra`, so the admin's editor is something the admin's tab
 * passes in rather than something the card has to know exists. That is what
 * lets the public pages import these directly instead of copying them.
 */

export { default as BlockList, dayTotalsText } from "./BlockList";
export type { BlockListProps, PreviewBlock } from "./BlockList";

export { default as LocalTime } from "./LocalTime";
export type { LocalTimeFormat, LocalTimeProps } from "./LocalTime";

export { default as ZoneNote } from "./ZoneNote";
export type { ZoneNoteProps } from "./ZoneNote";

export { default as BracketCanvas } from "./BracketCanvas";
export type { BracketCanvasProps } from "./BracketCanvas";

export { default as MatchCard } from "./MatchCard";
export type { MatchCardProps } from "./MatchCard";

export { default as StandingsTable } from "./StandingsTable";
export type { StandingsTableProps } from "./StandingsTable";

export { bracketSections, dayBySlot, widestColumn } from "./columns";
export type { BracketColumn, BracketSection } from "./columns";

export { scheduleShifts, shiftText } from "./shifts";
export type { ScheduleShift } from "./shifts";

export {
  championOf,
  choiceLine,
  choiceRecap,
  gameLine,
  gamesPlayed,
  groupByDay,
  hasBracketShape,
  matchHasResult,
  matchTone,
  matchToneClass,
  matchToneNote,
  playedGames,
  podiumEntries,
  refereesOf,
  resultsLog,
  seriesScore,
  tableStarted,
  upNext,
} from "./board";
export type { MatchTone, Placement, PodiumEntry, ScheduleDay } from "./board";

export {
  BRACKET_HALVES,
  BRONZE_CHOICES,
  PLAY_SIDE_CHOICES,
  STAGE_KIND_CHOICES,
  TIEBREAKER_LABELS,
  advancePerGroup,
  bracketLabel,
  bronzeFor,
  bronzeLabel,
  formatSentence,
  hhmm,
  matchStatusLabel,
  matchStatusTone,
  modeLabel,
  modesInUse,
  playSideLabel,
  seriesLabel,
  seriesLengthsInUse,
  seriesSentence,
  stageKindLabel,
  tiebreakerLabel,
} from "./labels";
export type { Choice } from "./labels";
