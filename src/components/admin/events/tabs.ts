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
 * Championship (UC-32) joined them for the same reason — which season this
 * event counts towards is another sentence describing it, not a stage of
 * running it. Format (R-217, R-218) is the sixth, and the same argument again:
 * whether an event has sides and how big they are is a sentence describing it.
 *
 * **It also decides which of the rest are drawn** (R-219), which is why the
 * answer to that lives here rather than in `EventEditor`: `?tab=` is read by
 * the *server* page, so the page is what has to know that a link to a tab this
 * event does not have should land somewhere else. See {@link landOn}.
 *
 * ## No dependencies, on purpose
 *
 * Nothing is imported here — not even a type. The module is read by a server
 * page and by a `"use client"` component, and the only way to be certain it
 * stays safe for both is for it to reach for nothing. {@link TabVisibility} is
 * declared structurally for that reason: `EventShape` from
 * `src/lib/events-policy.ts` satisfies it without this file knowing it exists.
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

/**
 * The panels inside Setup.
 *
 * **`shape`, labelled "Format".** The key and the label differ, and that is the
 * whole of the collision this section had to solve rather than inherit. There
 * is already a *step* keyed `format` — the bracket, its stages, Swiss or
 * knockout — and {@link tabFrom} checks the Setup aliases **before** the step
 * keys. So a Setup panel keyed `format` would make `?tab=format` resolve to
 * Setup and silently break every existing link to the bracket, including the
 * action lines on `/admin` that §4 requires to open "the exact screen that
 * fixes it". The panel is keyed `shape`, and the step it would have shadowed is
 * relabelled "Bracket" — see {@link TAB_LABELS} — because two tabs both called
 * Format in one editor is worse than either.
 */
export type SetupKey =
  | "basics"
  | "days"
  | "questions"
  | "rules"
  | "championship"
  | "shape";

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

export const SETUP_KEYS: readonly SetupKey[] = [
  "basics",
  "days",
  "questions",
  "rules",
  "championship",
  "shape",
];

/**
 * What each tab is called on the rail — **one place**, so the rail, the sweep
 * and the "that tab is not here" sentence cannot disagree about a name.
 *
 * `format` reads **"Bracket"**. It is the only entry whose label is not its key
 * spelled out, and {@link SetupKey} has the reason: the word "Format" now
 * belongs to the Setup panel keyed `shape`, and the step keeps its key so every
 * link already written against `?tab=format` still opens the bracket.
 */
export const TAB_LABELS: Readonly<Record<TabKey, string>> = {
  setup: "Setup",
  draft: "Draft",
  format: "Bracket",
  schedule: "Schedule",
  results: "Results",
  publish: "Publish",
  applicants: "Applicants",
  teams: "Teams",
  captains: "Captains",
};

/** What each Setup panel is called. `shape` is "Format"; see {@link SetupKey}. */
export const SETUP_LABELS: Readonly<Record<SetupKey, string>> = {
  basics: "Basics",
  days: "Days",
  questions: "Questions",
  rules: "Entry rules",
  championship: "Championship",
  shape: "Format",
};

/**
 * The four names Setup absorbed, plus the two it grew. Old links and bookmarks
 * still name the four, and `/admin`'s action lines were written against them,
 * so they keep working — they land on Setup with the right panel open.
 *
 * `championship` is a panel rather than a seventh step for the same reason the
 * other four are not steps: which season an event counts towards is a sentence
 * describing the event, not a stage of running one. Nobody visits it in the
 * middle of a draft. `shape` is the sixth, on the same argument.
 *
 * **`format` is deliberately not in here**, and `shape-tabs.test.ts` asserts
 * that it never is. This map is consulted before the step keys, so adding
 * `format` would quietly turn every link to the bracket into a link to Setup.
 */
const SETUP_ALIASES: Record<string, SetupKey> = {
  basics: "basics",
  days: "days",
  questions: "questions",
  rules: "rules",
  championship: "championship",
  shape: "shape",
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

/* ------------------------------------------------------------------ */
/* Which tabs apply to this event (R-219 / UC-42 5, 5a)               */
/* ------------------------------------------------------------------ */

/**
 * The two answers off the Format panel that decide what is drawn.
 *
 * Declared structurally rather than imported: `EventShape` from
 * `src/lib/events-policy.ts` satisfies it, and this module imports nothing (see
 * the file's docblock).
 */
export type TabVisibility = {
  teamEvent: boolean;
  draft: boolean;
};

/**
 * The four tabs a solo event has no use for (R-219).
 *
 * `format` is the bracket, and a bracket is a draw between sides — so it goes
 * with the other three. Everything *not* in this list is drawn for every event,
 * which is the half R-219 spells out: **Schedule and Results always stay**,
 * because a solo event still has a running order and a winner. Publish and
 * Applicants never depended on teams at all.
 */
export const TEAM_ONLY_KEYS: readonly TabKey[] = ["draft", "teams", "captains", "format"];

/**
 * Why this tab does not apply to this event, or null when it does
 * (R-219 / UC-42 5).
 *
 * A **sentence**, not a boolean, because UC-42 5a needs one: a link naming a
 * tab that no longer applies has to land somewhere real *and say why*, and a
 * predicate returning false gives the landing nothing to print. One function
 * answers both questions, so the rail cannot hide a tab the explanation does
 * not cover.
 *
 * ## This is not an authorisation
 *
 * A hidden tab is one that **does not apply**, not one that is forbidden
 * (UC-42 5b). Every server action keeps its own guard, because a tab the editor
 * stops drawing is still reachable by URL and by anybody who kept the page
 * open — Next's own note on this is blunt: "Render-time gating (only rendering
 * a form on an authenticated page) is not a security boundary"
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`). Nothing
 * in this module is consulted by an action and nothing should be.
 */
export function tabHiddenBecause(tab: TabKey, shape: TabVisibility): string | null {
  if (!TEAM_ONLY_KEYS.includes(tab)) return null;

  if (!shape.teamEvent) {
    return `${TAB_LABELS[tab]} is only for an event with sides, and this one has none. Setup → Format is where that is decided.`;
  }
  if (tab === "draft" && !shape.draft) {
    return "This event has teams but no draft, so there is nothing to bid on — the teams are filled on the Teams tab instead. Setup → Format is where that is decided.";
  }
  return null;
}

/** Every tab this event actually has, in rail order. */
export function visibleTabs(shape: TabVisibility): TabKey[] {
  return TAB_KEYS.filter((tab) => tabHiddenBecause(tab, shape) === null);
}

/** Where a `?tab=` ended up, and what the reader has to be told about it. */
export type TabLanding = {
  tab: TabKey;
  setup: SetupKey;
  /** The tab that was asked for and is not here — null when nothing moved. */
  asked: TabKey | null;
  /** Why it is not here. Null when nothing moved. */
  why: string | null;
};

/**
 * Where a `?tab=` opens the editor — **UC-42 5a, and the reason this is the
 * page's call rather than the editor's.**
 *
 * A link to `?tab=draft` on an event that has since gone solo must not render
 * an empty draft console and must not 404: the event is still there, and those
 * links exist in `/admin`'s action lines and in people's bookmarks. So it lands
 * on **Setup with the Format panel open** — the screen that decides whether the
 * tab comes back, which is the same standard §4 holds the `/admin` action lines
 * to — carrying the sentence that says why.
 *
 * A stale bookmark naming a tab that never existed still lands on Setup with
 * nothing said, which is {@link tabFrom}'s rule and unchanged: there is no
 * explanation to give for a word that was never a tab.
 */
export function landOn(
  raw: string | string[] | undefined,
  shape: TabVisibility
): TabLanding {
  const tab = tabFrom(raw);
  const why = tabHiddenBecause(tab, shape);
  if (why === null) return { tab, setup: setupFrom(raw), asked: null, why: null };
  return { tab: "setup", setup: "shape", asked: tab, why };
}

/**
 * Which tab the editor should actually show, for a tab it is **already
 * standing on** — and what it has to say about it.
 *
 * {@link landOn} answers the arriving URL; this answers the case that opens up
 * afterwards: an admin on the Teams tab turns teams off from Setup, the save
 * lands, and the tab they were looking at a moment ago no longer applies. The
 * editor must not draw it, and must not silently swap screens either.
 *
 * `said` is whatever the server already told the reader on arrival. The live
 * reason wins, because it describes the editor as it is now rather than how it
 * was when the page was requested.
 *
 * ## Why this is a function rather than two lines in `EventEditor`
 *
 * Because those two lines could not be proved. Reaching this state needs a
 * click, and the suite is a node environment with nothing to click — so a
 * mutation to the editor's own ternary survives every test by construction.
 * Pulled out here it is a decision over plain data, asserted directly over
 * every combination, which is what Task 83 did with `manualPostStep` and for
 * exactly this reason. The editor then does nothing but obey it.
 */
export function standingOn(
  tab: TabKey,
  shape: TabVisibility,
  said: string | null
): { here: TabKey; notice: string | null } {
  const why = tabHiddenBecause(tab, shape);
  return { here: why === null ? tab : "setup", notice: why ?? said };
}
