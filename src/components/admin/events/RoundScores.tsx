"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, EmptyState, Eyebrow, Field, Panel, Tabs } from "@/components/ui";
import { type PlayerBook, playerName } from "@/components/draft";
import type { EventStatus } from "@/db/schema";
import { lockRefusal } from "@/lib/archive-policy";
import {
  type RoundEntry,
  type RoundRow,
  type RoundScoring,
  roundEntriesProblem,
  roundMovedSince,
  roundName,
} from "@/lib/events-policy";
import type { RoundScoreRow } from "@/lib/round-scoring";
import { saveRoundAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";
import { useNavigationLock } from "./UnsavedChanges";

/**
 * The round sheet — one round at a time, every accepted applicant with a score
 * box and the night's bonuses beside each, saved together (R-224, R-227, R-230,
 * R-233 / UC-45 1-5).
 *
 * ## One write per round
 *
 * Save sends the whole round and `saveRound` replaces the whole round — the
 * same whole-unit replace `setPlacements` does for an order, for the same
 * reason: one authority per round and no diff to get wrong. So a correction
 * (UC-45 4a) is opening the round, changing a box and saving again, and a
 * player blanked on the way loses their row rather than keeping a stale one.
 *
 * ## What the sheet knows it is replacing (UC-45 4b)
 *
 * `baseline` is the round as the sheet was seeded — the rows the page read, or
 * the rows the last save handed back. It travels with every save as `expected`,
 * and the write compares it with the round as stored under the event lock. When
 * another manager got there first the save is refused, the sheet re-seeds from
 * what they stored, and the sentence says so: told the round moved, shown what
 * is there now. The manager's own typing goes, deliberately — it was for a
 * round that no longer exists, and what they most need to see is the other
 * manager's numbers, not their own on top of them.
 *
 * A sheet that is not being edited follows the rows the page re-reads, the way
 * `ResultsTab`'s board does; one that is being edited does not, because the
 * server is the place that decides whether the edit still applies.
 *
 * ## What it refuses before the round trip
 *
 * `roundEntriesProblem`, the same function the write asks, over the same
 * entries Save would send — so the sentence under the sheet is the sentence the
 * save would be refused with. The seat rule is the server's alone: everybody on
 * this sheet is seated or already recorded, so there is nothing for the screen
 * to refuse, and the footnote says who may be scored instead (UC-45 3e).
 *
 * ## Who is on the sheet
 *
 * Everyone holding a seat, plus anyone this round already records who has since
 * lost theirs — `setPlacements`' rule, because a whole-round replace that
 * silently omitted them would be the quiet destruction this codebase refuses.
 * Somebody accepted after the round was scored appears with it blank (UC-45 5a).
 *
 * ## One box per bonus, not a stepper
 *
 * `Stepper` is `max-w-xs` and two of them beside a score box is wider than a
 * phone. A number box labelled with the bonus's name is the count — "2" is
 * "x2" — and three of them wrap under the name at 400px without stacking a
 * player into a column of controls. Structural rather than measured: there is
 * no browser in this suite.
 */

/** The sheet's own state: text, as typed, per player. */
export type RoundForm = Record<string, { score: string; bonuses: Record<string, string> }>;

/**
 * What a freshly opened round holds, from its stored rows. Exported beside
 * {@link roundEntriesFrom} because the pair is the round trip — what the sheet
 * shows and what it posts — and a test that wrote its own copy would be
 * testing its own copy (`draftFrom` / `recordFieldsFrom`'s argument).
 */
export function roundFormFrom(rows: readonly RoundRow[]): RoundForm {
  return Object.fromEntries(
    rows.map((row) => [
      row.userId,
      {
        score: String(row.score),
        bonuses: Object.fromEntries(
          Object.entries(row.bonuses).map(([key, times]) => [key, String(times)])
        ),
      },
    ])
  );
}

/**
 * What Save sends (UC-45 3, 3a, 3b).
 *
 * A blank box is `null`, never a zero (R-228). A typed score goes as the number
 * typed — `7.5` stays `7.5` and `"1o"` is `NaN` — so the whole-number rule
 * refuses it by name rather than the screen rounding it into a score nobody
 * typed. A bonus box left empty or at zero is no award; anything else is sent
 * as typed for the same reason.
 */
export function roundEntriesFrom(listed: readonly string[], form: RoundForm): RoundEntry[] {
  return listed.map((userId) => {
    const own = form[userId];
    const typed = own?.score.trim() ?? "";
    const bonuses: Record<string, number> = {};
    for (const [key, raw] of Object.entries(own?.bonuses ?? {})) {
      if (raw.trim() === "") continue;
      const times = Number(raw);
      if (times === 0) continue;
      bonuses[key] = times;
    }
    return { userId, score: typed === "" ? null : Number(typed), bonuses };
  });
}

/** Everyone seated plus everyone this round records, once each, by name. */
export function sheetPlayers(
  seated: readonly string[],
  rows: readonly RoundRow[],
  nameOf: (userId: string) => string
): string[] {
  const ids = [...new Set([...seated, ...rows.map((row) => row.userId)])];
  return ids.sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
}

export default function RoundScores({
  eventId,
  scoring,
  rows,
  players,
  seated,
  status,
}: {
  eventId: string;
  /** As stored — `roundScoringFrom(event.config)`, read on the server, and not null here. */
  scoring: RoundScoring;
  /** Every recorded score for the event, from `listRoundScores`. */
  rows: readonly RoundScoreRow[];
  /** Who the rows and the seats name. */
  players: PlayerBook;
  /** The accepted applicants' user ids — the players (UC-45 pre 3). */
  seated: readonly string[];
  /** For UC-09 6b's lock, asked of the stored status before any box is drawn. */
  status: EventStatus;
}) {
  const router = useRouter();
  const guard = useNavigationLock();
  const [round, setRound] = useState(1);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const roundRows = useMemo(() => rows.filter((row) => row.roundIndex === round), [rows, round]);
  const [baseline, setBaseline] = useState<readonly RoundScoreRow[]>(roundRows);
  const [form, setForm] = useState<RoundForm>(() => roundFormFrom(roundRows));

  const seed = (from: readonly RoundScoreRow[]) => {
    setBaseline(from);
    setForm(roundFormFrom(from));
  };

  // Follows the page's rows while nobody is typing; holds still while they are.
  useEffect(() => {
    if (state === "dirty" || state === "saving") return;
    if (roundMovedSince(baseline, roundRows)) {
      seed(roundRows);
      setState("idle");
    }
  }, [roundRows, baseline, state]);

  const nameOf = (userId: string) => playerName(players, userId, "A former member");
  const seatedSet = useMemo(() => new Set(seated), [seated]);
  const listed = sheetPlayers(seated, roundRows, nameOf);
  const entries = roundEntriesFrom(listed, form);

  const locked = lockRefusal({ status });
  const problem = roundEntriesProblem(scoring, round, entries, nameOf);
  const count = scoring.rounds.length;
  const scoredRounds = new Set(
    rows.filter((row) => row.roundIndex >= 1 && row.roundIndex <= count).map((row) => row.roundIndex)
  ).size;

  const pick = (next: number) =>
    guard(() => {
      setRound(next);
      seed(rows.filter((row) => row.roundIndex === next));
      setState("idle");
      setError(null);
    });

  const edit = (userId: string, change: (own: RoundForm[string]) => RoundForm[string]) => {
    setForm((current) => ({
      ...current,
      [userId]: change(current[userId] ?? { score: "", bonuses: {} }),
    }));
    setState("dirty");
    setError(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveRoundAction(eventId, {
        roundIndex: round,
        entries: entries.map((line) => ({ ...line, bonuses: { ...line.bonuses } })),
        expected: baseline.map((row) => ({
          userId: row.userId,
          score: row.score,
          bonuses: { ...row.bonuses },
        })),
      });
      if (!result.ok) {
        setError(result.error);
        // UC-45 4b: what is there now, in the boxes.
        if (result.moved) seed(result.moved);
        setState("error");
        return;
      }
      seed(result.data.rows);
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  return (
    <>
      {error && <Alert>{error}</Alert>}

      <Panel
        as="section"
        padding="none"
        className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow>Rounds</Eyebrow>
          <Badge>
            {scoredRounds}/{count} scored
          </Badge>
        </div>

        <Tabs
          aria-label="Round"
          size="sm"
          value={String(round)}
          onChange={(value) => pick(Number(value))}
          items={scoring.rounds.map((entry, index) => ({
            value: String(index + 1),
            label: roundName(entry, index),
            count: rows.filter((row) => row.roundIndex === index + 1).length,
          }))}
        />

        <p className="max-w-[62ch] text-13 leading-relaxed text-muted">
          Type each player&apos;s score for this round and leave blank anybody who did not
          play. Beside each bonus, put how many times they earned it. Saving replaces whatever
          this round held.
        </p>

        {locked && (
          <Alert tone="union" standing>
            {locked}
          </Alert>
        )}

        {listed.length === 0 ? (
          <EmptyState>
            Nobody holds a seat yet. Accept applicants on Applicants and they appear here, one
            line each.
          </EmptyState>
        ) : (
          <ul>
            {listed.map((userId) => {
              const name = nameOf(userId);
              const own = form[userId] ?? { score: "", bonuses: {} };
              return (
                <li
                  key={userId}
                  className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-hair py-3 last:border-b-0"
                >
                  {/* The name takes its own line under `sm`, so at 400px the
                      score and the bonus boxes sit together beneath it rather
                      than the bonuses wrapping away from the score. */}
                  <div className="min-w-0 basis-full self-center sm:flex-1">
                    <span className="block truncate text-14 text-chalk">{name}</span>
                    {!seatedSet.has(userId) && (
                      <span className="block text-11 text-dim">No seat now, still scored here</span>
                    )}
                  </div>
                  <Field
                    label="Score"
                    inputMode="numeric"
                    aria-label={`${name}'s score`}
                    placeholder="Blank"
                    value={own.score}
                    disabled={locked !== null}
                    wrapperClassName="w-24"
                    onChange={(field) => {
                      const next = field.target.value;
                      edit(userId, (line) => ({ ...line, score: next }));
                    }}
                  />
                  {scoring.bonuses.map((bonus) => (
                    <Field
                      key={bonus.key}
                      label={bonus.key}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      aria-label={`${bonus.key} for ${name}`}
                      value={own.bonuses[bonus.key] ?? ""}
                      disabled={locked !== null}
                      wrapperClassName="w-24"
                      onChange={(field) => {
                        const next = field.target.value;
                        edit(userId, (line) => ({
                          ...line,
                          bonuses: { ...line.bonuses, [bonus.key]: next },
                        }));
                      }}
                    />
                  ))}
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-12 leading-relaxed text-muted">
          Only somebody holding a seat can be scored. If somebody played who is not listed,
          accept them on Applicants first.
        </p>

        {problem && !locked && (
          <p className="text-13 leading-relaxed text-flare" role="status">
            {problem}
          </p>
        )}

        <SaveRow
          state={state}
          disabled={locked !== null || problem !== null}
          reason={locked ?? problem}
          onSave={() => void save()}
          label={`Save ${roundName(scoring.rounds[round - 1], round - 1)}`}
        />
      </Panel>
    </>
  );
}
