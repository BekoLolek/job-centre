"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Checkbox,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  Select,
  plural,
} from "@/components/ui";
import {
  CHAMPIONSHIP_LOCKED_REFUSAL,
  MAX_POINTS_PLACES,
  scoringRulesProblem,
  weightProblem,
} from "@/lib/championship-policy";
import type { EventChampionship } from "@/lib/championships";
import { ordinal } from "@/lib/format-policy";
import {
  addEventToChampionshipAction,
  removeEventFromChampionshipAction,
  saveEventChampionshipAction,
} from "@/app/admin/events/actions";
import PlacementEditor from "./PlacementEditor";
import SaveRow, { type SaveState } from "./SaveRow";
import type { ChampionshipTabData } from "./types";

/**
 * Championship — UC-32, "decide which events count, and for how much".
 *
 * ## Why this is on the *event's* editor and not the season's
 *
 * Because the person who knows that Saturday's tournament is a whole day, and
 * therefore worth double, is the person running Saturday's tournament. UC-32's
 * actor is "an admin, or the host of that event", and every action here is
 * authorised exactly as the rest of this editor is — on the event. Nothing on
 * this screen can change what the *season* is worth; the table under "Its own
 * points table" applies to this one event and to nothing else.
 *
 * ## One season, and the database says so
 *
 * An event counts towards at most one season (UC-32 1a, over a unique index on
 * `event_id`), so this is not a multi-select: it is either in one or it is not.
 * That rule has no numbered requirement of its own — it is the last Constraint
 * in `docs/requirements.md`, "an event belongs to at most one championship, so
 * a result cannot count twice".
 * Moving it is take it out, then put it in, which is two deliberate acts rather
 * than a dropdown that silently drops a season's results.
 *
 * ## The picker is not the same list for everybody
 *
 * `championshipsToAddTo` decides it, not this component: an admin is offered
 * the hidden seasons as well as the published ones, a host only the published
 * (UC-31 2). A host whose event is already in a hidden season still sees it
 * below and can weight it or take it out — it is browsing everybody else's
 * unpublished seasons that is not theirs, not knowing what their own event is
 * in.
 *
 * ## The result lives here too (UC-33)
 *
 * {@link PlacementEditor} is on this panel rather than on the season's screen
 * for the same reason the weight is: the manager who has just run the event is
 * already in this editor, one step from the results they have been typing all
 * night — and `/admin/championships/[id]` is `requireAdmin`, so a host could
 * not reach a result they are the only person who knows. UC-33 1 says "the
 * manager opens the event's result", and this is the event.
 *
 * ## Add and remove happen at once; the weight is saved
 *
 * Adding and removing are single decisions with nothing to type, so they land
 * on the click, like the status controls. The weight and the points table are
 * typed, so they go through the editor's unsaved-changes bar like every other
 * panel — with the same validation the server runs, asked here as it is typed.
 */

export default function ChampionshipTab({
  eventId,
  data,
}: {
  eventId: string;
  data: ChampionshipTabData;
}) {
  return (
    <div className="space-y-6">
      {data.counting ? (
        <Counting eventId={eventId} counting={data.counting} result={data.result} />
      ) : (
        <NotCounting eventId={eventId} seasons={data.seasons} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Not in a season yet (UC-32 1)                                      */
/* ------------------------------------------------------------------ */

function NotCounting({
  eventId,
  seasons,
}: {
  eventId: string;
  seasons: ChampionshipTabData["seasons"];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(seasons[0]?.id ?? "");

  const add = () => {
    setError(null);
    start(async () => {
      try {
        const result = await addEventToChampionshipAction(eventId, chosen);
        if (!result.ok) return setError(result.error);
        router.refresh();
      } catch {
        setError("Could not reach the server. Nothing was saved.");
      }
    });
  };

  return (
    <>
      {error && <Alert>{error}</Alert>}

      <Panel as="section" padding="none" className="space-y-4">
        <div>
          <Eyebrow className="mb-2">Championship</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            A season is a run of events across different games with one running score. Add
            this event to one and its finishing order starts counting towards the standings.
            An event counts towards one season at most.
          </p>
        </div>

        {seasons.length === 0 ? (
          <EmptyState>
            No season can take this event. Admins start one under Admin → Championships and
            publish it when its points table is settled; a finished season takes no new
            events.
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Counts towards"
              hint="Finished seasons take no new events, so they are not offered."
              value={chosen}
              disabled={busy}
              wrapperClassName="min-w-[16rem]"
              onChange={(event) => setChosen(event.target.value)}
            >
              {seasons.map((season) => (
                <option key={season.id} value={season.id}>
                  {season.name}
                  {season.status === "hidden" ? " (hidden)" : ""}
                </option>
              ))}
            </Select>
            <Button variant="union" disabled={busy || !chosen} onClick={add}>
              {busy ? "Adding…" : "Add to the season"}
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* In a season (UC-32 2-4, 3a, 4a)                                    */
/* ------------------------------------------------------------------ */

/**
 * A typed number box, as a number.
 *
 * `ChampionshipEditor`'s reading of an empty or mistyped box, for the same
 * reason: "1o" stays `NaN` so the rule under it refuses the save, rather than
 * being quietly read as a zero nobody typed.
 */
function numberFrom(raw: string): number {
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : Number.NaN;
}

function Counting({
  eventId,
  counting,
  result,
}: {
  eventId: string;
  counting: EventChampionship;
  result: ChampionshipTabData["result"];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const [weight, setWeight] = useState(String(counting.weight));
  const [own, setOwn] = useState(counting.pointsTable !== null);
  const [places, setPlaces] = useState<string[]>(
    (counting.pointsTable ?? counting.season.pointsTable).map(String)
  );

  const season = counting.season;
  const closed = season.status === "closed";

  const table = places.map(numberFrom);
  const problem =
    weightProblem(numberFrom(weight)) ??
    (own
      ? scoringRulesProblem({
          pointsTable: table,
          participationPoints: season.participationPoints,
          countBest: season.countBest,
        })
      : null);

  const touch = () => {
    setState("dirty");
    setError(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveEventChampionshipAction(eventId, {
        weight: numberFrom(weight),
        pointsTable: own ? table : null,
      });
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  /**
   * Asked before it is done, like clearing a match's games and cancelling an
   * event: the counting row is what every recorded place hangs off, so taking
   * it out takes the season's record of this event with it and there is no
   * undo. The audit log classes this as destructive; the screen should say so
   * before the click, not afterwards.
   */
  const remove = () => {
    if (
      !confirm(
        `Stop counting "${counting.title}" towards ${season.name}? Every finishing order recorded for it in the season goes with it, and it cannot be undone.`
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      try {
        const result = await removeEventFromChampionshipAction(eventId);
        if (!result.ok) return setError(result.error);
        router.refresh();
      } catch {
        setError("Could not reach the server. Nothing was saved.");
      }
    });
  };

  return (
    <>
      {error && <Alert>{error}</Alert>}
      {closed && <Alert tone="union">{CHAMPIONSHIP_LOCKED_REFUSAL}.</Alert>}

      <Panel as="section" padding="none" className="space-y-6">
        <div>
          <Eyebrow className="mb-2">Championship</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            This event counts towards{" "}
            <Link
              href={`/admin/championships/${season.id}`}
              className="text-union underline-offset-2 hover:underline"
            >
              {season.name}
            </Link>
            . Its finishing order is worth{" "}
            <span className="text-chalk/80">
              {counting.weight === 1 ? "single points" : `${counting.weight}× points`}
            </span>{" "}
            towards the standings.
          </p>
        </div>

        <Field
          label="Weight"
          hint="Everything this event pays is multiplied by it. 2 for a whole-day tournament."
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={weight}
          disabled={closed}
          wrapperClassName="w-40"
          onChange={(event) => {
            setWeight(event.target.value);
            touch();
          }}
        />

        <div className="space-y-3 border-t border-hair pt-5">
          <Checkbox
            label="Give this event its own points table"
            checked={own}
            disabled={closed}
            onChange={(next) => {
              setOwn(next);
              touch();
            }}
          />
          <p className="text-12 leading-relaxed text-muted">
            Otherwise it uses the season&apos;s:{" "}
            {season.pointsTable.join(", ") || "no places at all"}.
          </p>

          {own && (
            <>
              <div className="flex flex-wrap gap-3">
                {places.map((value, index) => (
                  <Field
                    // The position is the identity: these boxes are a ladder,
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
                      touch();
                    }}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={closed || places.length >= MAX_POINTS_PLACES}
                  onClick={() => {
                    setPlaces([...places, places.at(-1) ?? "1"]);
                    touch();
                  }}
                >
                  Add a place
                </Button>
                <Button
                  size="sm"
                  disabled={closed || places.length === 0}
                  onClick={() => {
                    setPlaces(places.slice(0, -1));
                    touch();
                  }}
                >
                  Remove the last
                </Button>
                <span className="text-12 text-muted">
                  {plural(places.length, "place")}, still multiplied by the weight.
                </span>
              </div>
            </>
          )}

          {problem && !closed && (
            <p className="text-13 text-flare" role="status">
              {problem}
            </p>
          )}
        </div>

        <SaveRow
          state={state}
          disabled={closed || problem !== null}
          reason={closed ? CHAMPIONSHIP_LOCKED_REFUSAL : problem}
          onSave={() => void save()}
          label="Save what it is worth"
        />
      </Panel>

      {result && (
        <PlacementEditor
          eventId={eventId}
          counting={counting}
          participants={result.participants}
          placements={result.placements}
        />
      )}

      <Panel as="section" padding="none" className="space-y-3 border-t border-hair pt-12">
        <Eyebrow>Take it out of the season</Eyebrow>
        <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
          It stops counting and {season.name} re-scores without it. Any finishing order
          recorded against this event for the season goes with it — the event itself, its
          teams and its matches are untouched.
        </p>
        <div>
          <Button disabled={closed || busy} onClick={remove}>
            {busy ? "Taking it out…" : "Stop counting this event"}
          </Button>
        </div>
      </Panel>
    </>
  );
}
