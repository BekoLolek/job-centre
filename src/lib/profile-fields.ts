/**
 * The rules an admin-defined profile field obeys — all of them, in one place.
 *
 * docs/platform-plan.md §2 is emphatic that signing up is **clicks, not
 * typing**, and §7 makes the question set data rather than code. Between those
 * two, one module has to own "what is a legal answer to this field", because
 * three separate places need the same answer:
 *
 *  1. `/me/profile` renders a control per field type.
 *  2. The server action behind it must not trust a byte of what comes back.
 *  3. `/admin/games` has to know what an edit does to answers already stored —
 *     changing a `select` to a `number` invalidates every answer, and the admin
 *     deserves to be told how many before they click.
 *
 * Everything here is a pure function over plain data: no database handle, no
 * React, no `process.env`. That is what makes the awkward cases — a
 * multiselect holding a value that was deleted from the options last week —
 * cheap to test exhaustively.
 */

import type { ProfileFieldOption, ProfileFieldType, ProfileValue } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Field types, described for humans                                  */
/* ------------------------------------------------------------------ */

export type FieldTypeInfo = {
  type: ProfileFieldType;
  /** What the admin picks from a list. */
  label: string;
  /** One line under it, saying what the member will see. */
  hint: string;
  /** Does the admin have to supply an option list? */
  needsOptions: boolean;
  /** Does the field read its choices from the game's rank ladder instead? */
  usesRankLadder: boolean;
};

/**
 * The picker order on the admin screen. Deliberately not the enum's order:
 * `text` sits last and reads as the exception it is (§2).
 */
export const FIELD_TYPES: readonly FieldTypeInfo[] = [
  {
    type: "select",
    label: "Pick one",
    hint: "A row of buttons. One answer.",
    needsOptions: true,
    usesRankLadder: false,
  },
  {
    type: "multiselect",
    label: "Pick any",
    hint: "Toggle chips. Any number of answers.",
    needsOptions: true,
    usesRankLadder: false,
  },
  {
    type: "rank",
    label: "Rank",
    hint: "Reads this game's rank ladder. Tier first, then division.",
    needsOptions: false,
    usesRankLadder: true,
  },
  {
    type: "bool",
    label: "Yes / no",
    hint: "A two-state toggle.",
    needsOptions: false,
    usesRankLadder: false,
  },
  {
    type: "number",
    label: "Number",
    hint: "A stepper with plus and minus. Whole numbers, 0–9999.",
    needsOptions: false,
    usesRankLadder: false,
  },
  {
    type: "text",
    label: "Free text",
    hint: "Last resort — only where a choice genuinely cannot be offered.",
    needsOptions: false,
    usesRankLadder: false,
  },
] as const;

const BY_TYPE = new Map(FIELD_TYPES.map((info) => [info.type, info]));

export function fieldTypeInfo(type: ProfileFieldType): FieldTypeInfo {
  const info = BY_TYPE.get(type);
  if (!info) throw new Error(`Unknown profile field type: ${type}`);
  return info;
}

/** Is this string one of the six field types? Used to vet form input. */
export function isFieldType(value: unknown): value is ProfileFieldType {
  return typeof value === "string" && BY_TYPE.has(value as ProfileFieldType);
}

/** Bounds for a `number` field. A stepper needs an end, and so does validation. */
export const NUMBER_MIN = 0;
export const NUMBER_MAX = 9999;

/** A `text` answer is a name or a short note, never an essay. */
export const TEXT_MAX_LENGTH = 120;

/* ------------------------------------------------------------------ */
/* Keys and labels                                                    */
/* ------------------------------------------------------------------ */

/**
 * A stable url/database-safe key from whatever the admin typed.
 *
 * Admins never type a key: they type "Preferred roles" and get `preferred-roles`.
 * That is the difference between adding a game in a minute and filling in a
 * form with a field labelled "key" that nobody understands.
 *
 * Returns `""` for input with nothing slug-able in it, so callers can fall back
 * rather than silently storing an empty key.
 */
export function slugify(input: string, maxLength = 48): string {
  return input
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" and not "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/**
 * `slugify`, but guaranteed not to collide with `taken`.
 *
 * Falls back to `fallback` when the label slugs to nothing (an all-emoji
 * label), then suffixes `-2`, `-3`… until it is free. Comparison is exact:
 * keys are already lowercase by construction.
 */
export function uniqueKey(
  label: string,
  taken: Iterable<string>,
  fallback = "field"
): string {
  const used = new Set(taken);
  const base = slugify(label) || fallback;
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // 998 fields sharing one label is not a real scenario, but silently
  // returning a duplicate would be a unique-constraint crash later.
  return `${base}-${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* Options                                                            */
/* ------------------------------------------------------------------ */

/**
 * Clean up an admin-entered option list.
 *
 * Accepts either plain labels (what the admin types, one per line) or
 * already-shaped `{value,label}` objects (what a round trip through a form
 * gives back). Blank entries are dropped, labels are trimmed, and values are
 * slugged from the label unless one was supplied. Duplicate *values* are
 * dropped — the first wins, so reordering never silently deletes an answer.
 */
export function normaliseOptions(input: unknown): ProfileFieldOption[] {
  if (!Array.isArray(input)) return [];

  const out: ProfileFieldOption[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    let label = "";
    let value = "";

    if (typeof raw === "string") {
      label = raw.trim();
    } else if (raw && typeof raw === "object") {
      const record = raw as { value?: unknown; label?: unknown };
      label = typeof record.label === "string" ? record.label.trim() : "";
      value = typeof record.value === "string" ? record.value.trim() : "";
      // `{value: "duelist"}` with no label is legal input; show the value.
      if (!label && value) label = value;
    }

    if (!label) continue;
    const key = slugify(value || label) || slugify(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ value: key, label });
  }

  return out;
}

/**
 * The choices a member actually gets to tap.
 *
 * `select` and `multiselect` read the field's own options; `rank` reads the
 * owning game's ladder, which is exactly what makes §8.3's entry thresholds a
 * comparison of two ladder positions rather than string-matching someone's
 * typed guess. Everything else has no choice list at all.
 */
export function choicesFor(
  type: ProfileFieldType,
  options: ProfileFieldOption[],
  rankLadder: readonly string[] = []
): ProfileFieldOption[] {
  if (type === "rank") return rankLadder.map((name) => ({ value: name, label: name }));
  if (type === "select" || type === "multiselect") return options;
  return [];
}

/* ------------------------------------------------------------------ */
/* The rank ladder, arranged for two taps                             */
/* ------------------------------------------------------------------ */

export type RankEntry = {
  /** The full ladder entry, exactly as stored — this is what gets saved. */
  name: string;
  /** Position in the ladder, lowest first. The comparison §8.3 needs. */
  index: number;
  /** "III", "2"… or `null` for a ladder entry that has no divisions. */
  division: string | null;
};

export type RankTier = {
  /** "Diamond", "Eternity"… */
  tier: string;
  entries: RankEntry[];
};

/** Splits "Diamond II" into ["Diamond", "II"], "Eternity" into ["Eternity", null]. */
function splitRank(name: string): { tier: string; division: string | null } {
  const match = /^(.*\S)\s+([IVXLC]+|\d+)$/.exec(name.trim());
  if (!match) return { tier: name.trim(), division: null };
  return { tier: match[1], division: match[2] };
}

/**
 * The ladder grouped into tiers, so picking Diamond II is two taps rather than
 * a scroll through 23 entries (§2, and the brief for `/me/profile`).
 *
 * Grouping is by *adjacency*, not by name: a ladder that reuses a tier word far
 * apart keeps the two runs separate rather than teleporting an entry up the
 * list. Ladder order is preserved — lowest first — and every entry keeps its
 * ladder index, so callers can reverse for display without losing the ordering
 * that eligibility checks depend on.
 *
 * A tier with one entry and no division (Eternity, One Above All) still comes
 * back as a one-entry tier: the UI can then make it a single tap.
 */
export function groupRankLadder(ladder: readonly string[]): RankTier[] {
  const tiers: RankTier[] = [];

  ladder.forEach((name, index) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { tier, division } = splitRank(trimmed);
    const last = tiers[tiers.length - 1];
    const entry: RankEntry = { name: trimmed, index, division };
    if (last && last.tier === tier) last.entries.push(entry);
    else tiers.push({ tier, entries: [entry] });
  });

  return tiers;
}

/**
 * Clean a ladder an admin has been editing: trim, drop blanks, drop exact
 * duplicates (the first position wins). Order is the admin's, untouched —
 * it is the whole meaning of the list.
 */
export function normaliseRankLadder(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().slice(0, 60);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

/** Just enough of a field to validate an answer against it. */
export type FieldShape = {
  type: ProfileFieldType;
  label: string;
  options: ProfileFieldOption[];
  /** The owning game's ladder. Only read for `rank`. */
  rankLadder?: readonly string[];
};

export type ParseResult =
  | { ok: true; value: ProfileValue }
  | { ok: false; error: string };

/** "Cleared" in every spelling a form might use. */
function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Turn whatever arrived from the browser into the value the column should hold,
 * or say why it cannot.
 *
 * **Nothing here trusts the client.** Options are re-read from the field, not
 * from the request, so a hand-crafted POST cannot invent a rank or select an
 * option an admin deleted. A blank always parses to `null`, which the save
 * layer stores as "no answer" by deleting the row — including for required
 * fields, because a half-filled profile is a normal state and blocking the save
 * would strand the member. Requiredness is reported as completeness instead
 * (see `sectionCompleteness`), and it is Phase 2's application flow that
 * enforces it at the point it actually matters.
 */
export function parseProfileValue(field: FieldShape, raw: unknown): ParseResult {
  switch (field.type) {
    case "select":
    case "rank": {
      if (isBlank(raw)) return { ok: true, value: null };
      if (typeof raw !== "string") return { ok: false, error: "Expected a single choice." };
      const choices = choicesFor(field.type, field.options, field.rankLadder ?? []);
      const hit = choices.find((choice) => choice.value === raw.trim());
      if (!hit) return { ok: false, error: "That is not one of the options." };
      return { ok: true, value: hit.value };
    }

    case "multiselect": {
      if (isBlank(raw)) return { ok: true, value: [] };
      if (!Array.isArray(raw)) return { ok: false, error: "Expected a list of choices." };
      const allowed = new Set(field.options.map((option) => option.value));
      const chosen = new Set<string>();
      for (const item of raw) {
        if (typeof item !== "string") return { ok: false, error: "Expected a list of choices." };
        const value = item.trim();
        if (!value) continue;
        if (!allowed.has(value)) return { ok: false, error: "That is not one of the options." };
        chosen.add(value);
      }
      // Emitted in the admin's option order, not the order they were tapped, so
      // stored answers are comparable and the UI renders them consistently.
      return { ok: true, value: field.options.filter((o) => chosen.has(o.value)).map((o) => o.value) };
    }

    case "bool": {
      if (isBlank(raw)) return { ok: true, value: null };
      if (typeof raw === "boolean") return { ok: true, value: raw };
      // A form field posts strings; a checkbox posts "on".
      if (raw === "true" || raw === "on" || raw === 1 || raw === "1") return { ok: true, value: true };
      if (raw === "false" || raw === "off" || raw === 0 || raw === "0") return { ok: true, value: false };
      return { ok: false, error: "Expected yes or no." };
    }

    case "number": {
      if (isBlank(raw)) return { ok: true, value: null };
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: "That is not a number." };
      if (!Number.isInteger(value)) return { ok: false, error: "Whole numbers only." };
      if (value < NUMBER_MIN || value > NUMBER_MAX) {
        return { ok: false, error: `Must be between ${NUMBER_MIN} and ${NUMBER_MAX}.` };
      }
      return { ok: true, value };
    }

    case "text": {
      if (isBlank(raw)) return { ok: true, value: null };
      if (typeof raw !== "string") return { ok: false, error: "Expected some text." };
      const value = raw.trim();
      if (value.length > TEXT_MAX_LENGTH) {
        return { ok: false, error: `Keep it under ${TEXT_MAX_LENGTH} characters.` };
      }
      return { ok: true, value };
    }
  }
}

/**
 * Does this stored value still make sense for this field?
 *
 * The question an admin edit raises: retyping a `select` as a `number`, or
 * deleting the option half the server picked, leaves rows behind that no longer
 * parse. `/admin/games` counts these before the edit and clears them after, so
 * nothing silently rots in the database.
 */
export function valueStillValid(field: FieldShape, value: ProfileValue): boolean {
  if (value === null) return false;
  const result = parseProfileValue(field, value);
  if (!result.ok) return false;
  // An empty multiselect is a legal parse but not an answer worth keeping.
  if (Array.isArray(result.value)) return result.value.length > 0;
  return result.value !== null;
}

/** Is there an answer here at all? `[]` and `null` are both "no". */
export function hasAnswer(value: ProfileValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

export type Completeness = {
  /** Required fields with an answer. */
  answered: number;
  /** Required fields in total. */
  required: number;
  /** True when every required field has an answer (vacuously, when there are none). */
  complete: boolean;
  /** Labels of the required fields still waiting, in field order. */
  missing: string[];
};

/**
 * How much of a section is filled in.
 *
 * This is what `required` means on the member's side: a nudge and a counter,
 * not a locked save button. The hard gate lives on the event application in
 * Phase 2, where refusing to continue is the correct behaviour.
 */
export function sectionCompleteness(
  fields: ReadonlyArray<{ label: string; required: boolean; value: ProfileValue }>
): Completeness {
  const required = fields.filter((field) => field.required);
  const missing = required.filter((field) => !hasAnswer(field.value)).map((field) => field.label);
  return {
    answered: required.length - missing.length,
    required: required.length,
    complete: missing.length === 0,
    missing,
  };
}

/* ------------------------------------------------------------------ */
/* Display                                                            */
/* ------------------------------------------------------------------ */

/** A stored answer as a member would read it back. Used in summaries. */
export function formatAnswer(field: FieldShape, value: ProfileValue): string {
  if (!hasAnswer(value)) return "—";
  const choices = choicesFor(field.type, field.options, field.rankLadder ?? []);
  const labelFor = (raw: string) => choices.find((c) => c.value === raw)?.label ?? raw;

  if (Array.isArray(value)) return value.map(labelFor).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  return labelFor(String(value));
}

/* ------------------------------------------------------------------ */
/* Ordering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Move one id up or down a list, and hand back the whole new order.
 *
 * Callers write the result back as `sort = 0…n-1` rather than trying to nudge
 * one row's number, which keeps `sort` dense and free of the gaps that make
 * "move up" mysteriously do nothing later. Moving the first item up (or the
 * last down) is a no-op, not an error — the button is simply disabled.
 */
export function reorder<T>(items: readonly T[], index: number, direction: "up" | "down"): T[] {
  const next = [...items];
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** `reorder` by id, for rows the caller holds as objects. */
export function reorderById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  direction: "up" | "down"
): T[] {
  return reorder(items, items.findIndex((item) => item.id === id), direction);
}
