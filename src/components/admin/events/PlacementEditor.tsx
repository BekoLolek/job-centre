"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, EmptyState, Eyebrow, Field, Panel, plural } from "@/components/ui";
import {
  CHAMPIONSHIP_LOCKED_REFUSAL,
  positionProblem,
} from "@/lib/championship-policy";
import type {
  EventParticipants,
  PlacementEntry,
  RecordedPlacement,
} from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import { saveEventPlacementsAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Where everyone finished — UC-33, "record the event's result for the season".
 *
 * ## Why a place per player, and not a list you drag
 *
 * Because two of the three things UC-33 asks for are impossible in a dragged
 * list and free here. A genuine tie (3a) is two rows holding the same number;
 * somebody who took part and finished nowhere (3b) is a row left blank. A
 * drag-to-order list has to invent a gesture for each, and would still make
 * the common case — typing what the scoreboard already says — slower than
 * reading it off.
 *
 * It also makes UC-33 3c unreachable from this screen by construction: there
 * is exactly one box per participant, so nobody can be entered twice. The
 * server checks anyway (`duplicateMemberIn`), because a server action is a
 * public endpoint and a roster can move under a page that is ten minutes old.
 *
 * ## Teams or players, never both
 *
 * `eventParticipants` decides which, not this component: the teams when the
 * event had them, otherwise the accepted applicants. A team's place scores for
 * everybody on it (R-180), so each team row says who that is — the manager is
 * handing out points to those names, and should be able to see them.
 *
 * ## Somebody who has since left
 *
 * A place already recorded for somebody no longer in the participant list — an
 * applicant who withdrew after the night — is still shown, in its own group,
 * with its own box. They did take part and they did finish there. Hiding the
 * row would mean the next save silently deleted their result, which is the one
 * thing a correction must never do quietly.
 */

export type PlacementEditorProps = {
  eventId: string;
  /** The season, its table and its weight — everything a place is worth. */
  counting: EventChampionship;
  participants: EventParticipants;
  /** What is already recorded, by `ParticipantRow.id`. */
  placements: RecordedPlacement[];
};

/**
 * A typed box as a place: `null` for blank, which is "took part, finished
 * nowhere" (UC-33 3b), and `NaN` for "1o", which the rule below refuses rather
 * than reading as a zero nobody typed.
 */
function placeFrom(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** One row of the order: a team, or a player, and who it pays. */
type Row = {
  id: string;
  name: string;
  /** The names a place here pays. Empty for a row that is the player. */
  pays: string[];
};

export default function PlacementEditor({
  eventId,
  counting,
  participants,
  placements,
}: PlacementEditorProps) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<Record<string, string>>(() =>
    Object.fromEntries(placements.map((place) => [place.id, String(place.position)]))
  );

  const season = counting.season;
  const closed = season.status === "closed";
  const table = counting.pointsTable?.length ? counting.pointsTable : season.pointsTable;

  const rows: Row[] = participants.rows.map((row) => ({
    id: row.id,
    name: row.name,
    pays: participants.teamed ? row.members.map((member) => member.name) : [],
  }));

  const left: Row[] = placements
    .filter((place) => !participants.rows.some((row) => row.id === place.id))
    .map((place) => ({ id: place.id, name: place.name, pays: [] }));

  /*
   * The server's own rule, asked here as it is typed — `positionProblem` and
   * not a copy of it, because this is what decides whether Save is enabled and
   * a second copy would drift into a button that disagrees with the write.
   */
  const problem = [...rows, ...left]
    .map((row) => placeFrom(places[row.id] ?? ""))
    .reduce<string | null>(
      (found, place) => found ?? (place === null ? null : positionProblem(place)),
      null
    );

  const set = (id: string, value: string) => {
    setPlaces({ ...places, [id]: value });
    setState("dirty");
    setError(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);

    const order: PlacementEntry[] = [];
    for (const row of [...rows, ...left]) {
      const place = placeFrom(places[row.id] ?? "");
      if (place !== null) order.push({ id: row.id, position: place });
    }

    try {
      const result = await saveEventPlacementsAction(eventId, order);
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

  return (
    <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12">
      {error && <Alert>{error}</Alert>}

      <div>
        <Eyebrow className="mb-2">Where everyone finished</Eyebrow>
        <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
          Type each {participants.teamed ? "team" : "player"}&apos;s place. Leave it blank
          for anyone who took part and finished outside the table — they get the taking-part
          points. Two who genuinely tied share a place, and the next one stays empty.
        </p>
        <p className="mt-2 max-w-[62ch] text-12 leading-relaxed text-muted">
          {season.name} pays{" "}
          <span className="text-chalk/80">{table.join(", ") || "no places at all"}</span>, and{" "}
          <span className="text-chalk/80">
            {season.participationPoints} for taking part
          </span>
          {counting.weight === 1 ? "" : `, all multiplied by ${counting.weight}`}.
        </p>
      </div>

      {rows.length === 0 && left.length === 0 ? (
        <EmptyState>
          Nobody took part yet. {participants.teamed ? "Teams" : "Accepted applicants"} show up
          here, and a place can be recorded for each of them.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-hair border-y border-hair">
          {rows.map((row) => (
            <PlaceRow
              key={row.id}
              row={row}
              value={places[row.id] ?? ""}
              disabled={closed}
              onChange={(value) => set(row.id, value)}
            />
          ))}
        </ul>
      )}

      {left.length > 0 && (
        <div className="space-y-3">
          <Eyebrow>No longer in the event</Eyebrow>
          <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
            {plural(left.length, "place")} recorded for somebody who has since withdrawn or
            left a roster. They still count, because they were there on the night. Clear the
            box to take one out.
          </p>
          <ul className="divide-y divide-hair border-y border-hair">
            {left.map((row) => (
              <PlaceRow
                key={row.id}
                row={row}
                value={places[row.id] ?? ""}
                disabled={closed}
                onChange={(value) => set(row.id, value)}
              />
            ))}
          </ul>
        </div>
      )}

      {problem && !closed && (
        <p className="text-13 text-flare" role="status">
          {problem}
        </p>
      )}

      <SaveRow
        state={state}
        disabled={closed || problem !== null}
        reason={closed ? CHAMPIONSHIP_LOCKED_REFUSAL : problem}
        onSave={() => void save()}
        label="Save the finishing order"
        note="Standings updated"
      />
    </Panel>
  );
}

function PlaceRow({
  row,
  value,
  disabled,
  onChange,
}: {
  row: Row;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-4 py-3">
      <Field
        aria-label={`${row.name}'s place`}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        placeholder="—"
        value={value}
        disabled={disabled}
        wrapperClassName="w-20"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="min-w-0">
        <p className="text-14 text-chalk/80">{row.name}</p>
        {row.pays.length > 0 && (
          <p className="text-12 leading-relaxed text-muted">{row.pays.join(", ")}</p>
        )}
      </div>
    </li>
  );
}
