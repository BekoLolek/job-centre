import type { ProfileFieldOption, ProfileFieldType } from "@/db/schema";

/**
 * The props the event editor's tabs share.
 *
 * Kept out of the components so a tab can be read without following an import
 * chain through five files, and so the server page has one place to look when
 * it builds them.
 */

/** A game the event can belong to, with the ladder its rank gates read. */
export type GameOption = {
  id: string;
  name: string;
  isActive: boolean;
  rankLadder: string[];
};

/**
 * A profile field this event's questions may prefill from — the event's game's,
 * plus the global ones. `setEventQuestions` refuses anything else, so the
 * picker must not offer anything else either.
 */
export type LinkableField = {
  id: string;
  key: string;
  label: string;
  type: ProfileFieldType;
  options: ProfileFieldOption[];
  required: boolean;
  /** "Everyone", or the game's name. Shown so the admin knows what they linked. */
  scope: string;
};
