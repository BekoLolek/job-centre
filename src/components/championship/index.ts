// The public season page, in pieces. Presentation only: no data fetching and
// no rules — `src/lib/championship-season.ts` reads the season, and
// `src/lib/championship-policy.ts` scores it.

export { default as Season } from "./Season";
export { default as Podium } from "./Podium";
export { default as PastSeasons } from "./PastSeasons";
export { default as ScoringRules } from "./ScoringRules";
export { default as SeasonEvents } from "./SeasonEvents";
export { default as StandingsTable } from "./StandingsTable";
export type { StandingsEvent, StandingsTableProps } from "./StandingsTable";
