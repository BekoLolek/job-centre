// Everything an event *display* needs, shared by the admin screens, the public
// hub and the member's pages. Presentation only: no data fetching, no policy —
// the rules live in `src/lib/events-policy.ts` and these read their answers.

export { default as EventCard } from "./EventCard";
export { default as EventListing } from "./EventListing";
export type { EventListingProps, EventListingScope } from "./EventListing";

export { default as EventRow, EventRows, EventRowsHeading } from "./EventRow";
export type { EventCardProps } from "./EventCard";

export { default as EventDateRange } from "./EventDateRange";
export type { EventDateRangeProps } from "./EventDateRange";

export { default as Countdown, untilText } from "./Countdown";
export type { CountdownProps } from "./Countdown";

export { default as EventAction } from "./EventAction";
export type { EventActionProps } from "./EventAction";

export { viewerAction } from "./viewer";
export type {
  ViewerAction,
  ViewerActionInput,
  ViewerActionKind,
  ViewerApplication,
} from "./viewer";

export { iso, localInput, whenText } from "./when";
export type { Stamp } from "./when";

export { default as EventSeats, seatsText } from "./EventSeats";
export type { EventSeatsProps } from "./EventSeats";

export { default as EventStatusLine } from "./EventStatusLine";
export type { EventStatusLineProps } from "./EventStatusLine";

export { ApplicationsPill, EventStatusPill } from "./EventStatusPill";

export {
  AVAILABILITY_CHOICES,
  EVENT_TYPE_SUGGESTIONS,
  applicationStatusLabel,
  applicationStatusTone,
  applicationsPill,
  availabilityMark,
  availabilityTone,
  eventStatusLabel,
  eventStatusMeaning,
  eventStatusTone,
  eventTypeLabel,
  formatSummary,
} from "./labels";
export type { FormatView } from "./labels";
