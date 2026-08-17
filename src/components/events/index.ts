// Everything an event *display* needs, shared by the admin screens, the public
// hub and the member's pages. Presentation only: no data fetching, no policy —
// the rules live in `src/lib/events-policy.ts` and these read their answers.

export { default as EventCard } from "./EventCard";
export type { EventCardProps } from "./EventCard";

export { default as EventDateRange } from "./EventDateRange";
export type { EventDateRangeProps } from "./EventDateRange";

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
} from "./labels";
