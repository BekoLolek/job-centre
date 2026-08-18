/**
 * The event editor's tab names, and which one a URL asks for.
 *
 * A plain module rather than part of `EventEditor.tsx`, because `EventEditor`
 * is `"use client"` and the *server* page is what reads `?tab=`. Exporting a
 * helper from a client module and calling it during a server render is not a
 * lint preference — Next replaces the export with a reference and the call
 * fails at request time with "attempted to call tabFrom() from the server".
 *
 * §4 asks every line on `/admin` to link to "the exact screen that fixes it".
 * A link into the editor that always opened on Basics would fix nothing, which
 * is why the tab is in the URL at all.
 */

export type TabKey =
  | "basics"
  | "days"
  | "questions"
  | "rules"
  | "applicants"
  | "teams"
  | "captains"
  | "draft"
  | "format"
  | "schedule"
  | "results"
  | "publish";

export const TAB_KEYS: readonly TabKey[] = [
  "basics",
  "days",
  "questions",
  "rules",
  "applicants",
  "teams",
  "captains",
  "draft",
  "format",
  "schedule",
  "results",
  "publish",
];

/**
 * Which tab a `?tab=` asks for, or `basics` for anything else.
 *
 * A stale bookmark naming a tab that no longer exists opens the editor rather
 * than a 404: the event is still there, and Basics is a fine place to land.
 */
export function tabFrom(raw: string | string[] | undefined): TabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : "basics";
}
