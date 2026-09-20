"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Field,
  Section,
  SectionList,
  StatusPill,
  Textarea,
  plural,
} from "@/components/ui";
import type { ChampionshipStatusValue } from "@/db/schema";
import {
  DEFAULT_POINTS_TABLE,
  MAX_POINTS_PLACES,
  scoringRulesProblem,
} from "@/lib/championship-policy";
import { ordinal } from "@/lib/format-policy";
import {
  saveChampionshipAction,
  setChampionshipStatusAction,
} from "@/app/admin/championships/actions";

/**
 * `/admin/championships/[id]`, client side — UC-31 and UC-35 in one screen.
 *
 * ## Why one save and not a tab each
 *
 * An event's editor saves each tab on its own, because its tabs are edited
 * weeks apart and re-saving the questions is not free. A season is the
 * opposite: the table, what taking part is worth and how many results count
 * are one decision argued about in one sitting, and UC-31 4a is a rule
 * *between* two of them. Saving half of it is the reliable way to be refused by
 * your own settings — shorten the table to four places and the participation
 * value you were about to lower is suddenly too high.
 *
 * ## The validation runs twice, from one function
 *
 * `scoringRulesProblem` is pure, so the same call that refuses the write on the
 * server says what is wrong under the table as it is typed. Not two rules that
 * agree today: one rule, asked twice.
 *
 * ## Closed
 *
 * Every field goes read-only and the one control left is Reopen (UC-35 2b).
 * The server refuses the write regardless — a disabled input is a courtesy,
 * not a guard — but an admin should not have to press save to find out.
 */

export type ChampionshipEditorView = {
  id: string;
  name: string;
  description: string | null;
  status: ChampionshipStatusValue;
  /** Stored as the first of the month; the picker wants "YYYY-MM". */
  runsFrom: string | null;
  runsTo: string | null;
  pointsTable: number[];
  participationPoints: number;
  countBest: number | null;
};

/** What `<input type="month">` wants, from what the column holds. */
function monthValue(stored: string | null): string {
  return stored ? stored.slice(0, 7) : "";
}

/**
 * A typed number box, as a number.
 *
 * An empty box is 0, because that is what a cleared points box means. Anything
 * that is not a number at all stays `NaN` rather than being coerced to 0 —
 * `scoringRulesProblem` then refuses it and the save button locks, which is the
 * honest answer to "1o" in the 4th place box. Quietly reading it as zero would
 * save a table the admin did not type.
 */
function numberFrom(raw: string): number {
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : Number.NaN;
}

export default function ChampionshipEditor({ view }: { view: ChampionshipEditorView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description ?? "");
  const [runsFrom, setRunsFrom] = useState(monthValue(view.runsFrom));
  const [runsTo, setRunsTo] = useState(monthValue(view.runsTo));
  const [places, setPlaces] = useState<string[]>(view.pointsTable.map(String));
  const [participation, setParticipation] = useState(String(view.participationPoints));
  const [countBest, setCountBest] = useState(
    view.countBest === null ? "" : String(view.countBest)
  );

  const closed = view.status === "closed";

  const pointsTable = places.map(numberFrom);
  const rules = {
    pointsTable,
    participationPoints: numberFrom(participation),
    countBest: countBest.trim() === "" ? null : numberFrom(countBest),
  };
  const problem = scoringRulesProblem(rules);

  const run = (
    go: () => Promise<{ ok: boolean; error?: string }>,
    after?: () => void
  ) => {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        const result = await go();
        if (!result.ok) {
          setError(result.error ?? "That did not work.");
          return;
        }
        after?.();
        router.refresh();
      } catch {
        setError("Could not reach the server.");
      }
    });
  };

  const save = () =>
    run(
      () =>
        saveChampionshipAction(view.id, {
          name,
          description: description.trim() || null,
          runsFrom: runsFrom || null,
          runsTo: runsTo || null,
          ...rules,
        }),
      () => setSaved(true)
    );

  const move = (to: ChampionshipStatusValue) =>
    run(() => setChampionshipStatusAction(view.id, view.status, to));

  /**
   * Closing asks the server first. A counting event with no result comes back
   * as a refusal carrying the names (UC-35 1a); the admin reads them and says
   * whether to close anyway.
   */
  const close = () => {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        const asked = await setChampionshipStatusAction(view.id, view.status, "closed", {});
        if (asked.ok) return router.refresh();
        if (!asked.unscored?.length) return setError(asked.error);
        if (!confirm(`${asked.error}\n\nThe standings stop changing once it is closed.`)) {
          return;
        }
        const confirmed = await setChampionshipStatusAction(view.id, view.status, "closed", {
          confirm: true,
        });
        if (!confirmed.ok) return setError(confirmed.error);
        router.refresh();
      } catch {
        setError("Could not reach the server.");
      }
    });
  };

  return (
    <div>
      {error && <Alert className="mb-6">{error}</Alert>}
      {saved && !error && (
        <Alert tone="success" className="mb-6">
          Saved.
        </Alert>
      )}
      {closed && (
        <Alert tone="union" className="mb-6">
          This season is finished, so nothing about it can change. Reopen it to record or
          correct a result.
        </Alert>
      )}

      <SectionList>
        {/* --- Identity (UC-31 1) ----------------------------------- */}
        <Section
          first
          icon="trophy"
          title="This season"
          description="The name people see, and the months it runs. A season runs in whole months — March to November, not the 3rd to the 17th."
          aside={<StatusPill status={PILL[view.status].tone} label={PILL[view.status].label} />}
        >
          <div className="space-y-4">
            <Field
              label="Name"
              hint="Shown on the standings and in the navigation once it is published."
              value={name}
              maxLength={80}
              disabled={closed}
              onChange={(event) => setName(event.target.value)}
            />
            <Textarea
              label="Description"
              hint="A sentence on the page: what the season is, and what counts towards it."
              value={description}
              rows={3}
              maxLength={2000}
              disabled={closed}
              onChange={(event) => setDescription(event.target.value)}
            />
            <div className="flex flex-wrap gap-4">
              <Field
                label="Runs from"
                type="month"
                value={runsFrom}
                disabled={closed}
                wrapperClassName="min-w-[10rem]"
                onChange={(event) => setRunsFrom(event.target.value)}
              />
              <Field
                label="Runs to"
                type="month"
                value={runsTo}
                disabled={closed}
                wrapperClassName="min-w-[10rem]"
                onChange={(event) => setRunsTo(event.target.value)}
              />
            </div>
          </div>
        </Section>

        {/* --- Scoring (UC-31 3, 3a, 4) ----------------------------- */}
        <Section
          icon="coin"
          title="What a finish is worth"
          description="Position 1 first. The table must not go up as you finish lower, and taking part must not beat last place — otherwise finishing badly would pay better than finishing well."
          aside={
            <span className="text-12 text-muted">
              {plural(places.length, "place")}
            </span>
          }
        >
          <div className="flex flex-wrap gap-3">
            {places.map((value, index) => (
              <Field
                // The position is the identity here: these boxes are a ladder,
                // not a list of things that can be reordered.
                key={index}
                label={ordinal(index + 1)}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={value}
                disabled={closed}
                wrapperClassName="w-24"
                onChange={(event) => {
                  const next = [...places];
                  next[index] = event.target.value;
                  setPlaces(next);
                }}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={closed || busy || places.length >= MAX_POINTS_PLACES}
              onClick={() => setPlaces([...places, places.at(-1) ?? "1"])}
            >
              Add a place
            </Button>
            <Button
              size="sm"
              disabled={closed || busy || places.length === 0}
              onClick={() => setPlaces(places.slice(0, -1))}
            >
              Remove the last
            </Button>
            <Button
              size="sm"
              disabled={closed || busy}
              onClick={() => setPlaces(DEFAULT_POINTS_TABLE.map(String))}
            >
              Back to the default
            </Button>
          </div>

          <div className="mt-6 flex flex-wrap gap-4">
            <Field
              label="Taking part"
              hint="For anybody who played and finished outside the table."
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={participation}
              disabled={closed}
              wrapperClassName="w-40"
              onChange={(event) => setParticipation(event.target.value)}
            />
            <Field
              label="Best results that count"
              hint="Leave empty to count every result."
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={countBest}
              disabled={closed}
              wrapperClassName="w-48"
              onChange={(event) => setCountBest(event.target.value)}
            />
          </div>

          {problem && !closed && (
            <p className="mt-4 text-13 text-flare" role="status">
              {problem}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="union" disabled={closed || busy || problem !== null} onClick={save}>
              {busy ? "Saving…" : "Save the season"}
            </Button>
            <span className="text-12 text-muted">
              Nothing here is announced. Publishing is the step that shows it to everybody.
            </span>
          </div>
        </Section>

        {/* --- The lifecycle (UC-31 5, UC-35) ----------------------- */}
        <Section
          icon="flag"
          title="Publishing and closing"
          description="Hidden while you set it up, published for everyone to read, finished when the last event has been scored. Finished seasons keep their page."
        >
          <div className="flex flex-wrap items-center gap-2">
            {view.status === "hidden" && (
              <Button variant="union" disabled={busy} onClick={() => move("published")}>
                Publish
              </Button>
            )}
            {view.status === "published" && (
              <>
                <Button disabled={busy} onClick={() => move("hidden")}>
                  Hide again
                </Button>
                <Button variant="union" disabled={busy} onClick={close}>
                  Close the season
                </Button>
              </>
            )}
            {closed && (
              <Button disabled={busy} onClick={() => move("published")}>
                Reopen
              </Button>
            )}
          </div>
        </Section>
      </SectionList>
    </div>
  );
}

/**
 * Each status as an existing pill, by hand.
 *
 * `StatusPill`'s vocabulary is an event's, and a season's three words are not
 * the same three — but the tones are exactly the ones this needs, so it
 * borrows them rather than growing a fourth colour set nobody asked for.
 */
const PILL: Record<ChampionshipStatusValue, { tone: string; label: string }> = {
  hidden: { tone: "draft", label: "Hidden" },
  published: { tone: "open", label: "Published" },
  closed: { tone: "complete", label: "Finished" },
};
