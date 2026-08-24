/**
 * The event editor's steps, and which one a URL asks for.
 *
 * A plain module rather than part of `EventEditor.tsx`, because `EventEditor`
 * is `"use client"` and the *server* page is what reads `?tab=`. Exporting a
 * helper from a client module and calling it during a server render is not a
 * lint preference — Next replaces the export with a reference and the call
 * fails at request time with "attempted to call tabFrom() from the server".
 *
 * §4 asks every line on `/admin` to link to "the exact screen that fixes it".
 * A link into the editor that always opened on Basics would fix nothing, which
 * is why the step is in the URL at all.
 *
 * **The shape changed.** There were twelve tabs in one undifferentiated row,
 * and running an event does not feel like twelve equal choices — it is a short
 * sequence with a few reference screens hanging off it. So:
 *
 *   - Six **steps**, in the order they actually happen: set the event up, run
 *     the draft, choose the format, lay out the schedule, record results,
 *     publish. Numbered, because the number is the answer to "where am I".
 *   - Three **people** screens — applicants, teams, captains — which are not
 *     steps at all. You visit them repeatedly, out of order, throughout. They
 *     sit apart on the same rail.
 *
 * Setup swallowed the four screens that were all "describe the event": basics,
 * days, questions, entry rules. They were four tabs holding one decision.
 */

export type TabKey =
  | "setup"
  | "draft"
  | "format"
  | "schedule"
  | "results"
  | "publish"
  | "applicants"
  | "teams"
  | "captains";

/** The panels inside Setup. */
export type SetupKey = "basics" | "days" | "questions" | "rules";

export const STEP_KEYS: readonly TabKey[] = [
  "setup",
  "draft",
  "format",
  "schedule",
  "results",
  "publish",
];

export const PEOPLE_KEYS: readonly TabKey[] = ["applicants", "teams", "captains"];

export const TAB_KEYS: readonly TabKey[] = [...STEP_KEYS, ...PEOPLE_KEYS];

export const SETUP_KEYS: readonly SetupKey[] = ["basics", "days", "questions", "rules"];

/**
 * The four names Setup absorbed. Old links and bookmarks still name them, and
 * `/admin`'s action lines were written against them, so they keep working —
 * they land on Setup with the right panel open.
 */
const SETUP_ALIASES: Record<string, SetupKey> = {
  basics: "basics",
  days: "days",
  questions: "questions",
  rules: "rules",
};

/**
 * Which step a `?tab=` asks for, or `setup` for anything else.
 *
 * A stale bookmark naming a step that no longer exists opens the editor rather
 * than a 404: the event is still there, and Setup is a fine place to land.
 */
export function tabFrom(raw: string | string[] | undefined): TabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && value in SETUP_ALIASES) return "setup";
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : "setup";
}

/** Which Setup panel a `?tab=` asks for, when it names one. */
export function setupFrom(raw: string | string[] | undefined): SetupKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ? SETUP_ALIASES[value] : undefined) ?? "basics";
}
