"use client";

import { useRouter } from "next/navigation";
import { useState, type DragEvent, type ReactNode } from "react";
import {
  Alert,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  cx,
  plural,
} from "@/components/ui";
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
import { dropped, placeFrom, sequenceFor, typed, type Order } from "./placement-order";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Where everyone finished — UC-33, "record the event's result for the season".
 *
 * ## A typed box per row, and a list you can drag as well
 *
 * This screen began as boxes alone, on the argument that two of the three
 * things UC-33 asks for have no gesture: a genuine tie (3a) is two rows holding
 * the same number, and somebody who took part and finished nowhere (3b) is a
 * row left blank. A dragged list has to invent a gesture for each. That is
 * still true, and it is why the boxes stay and are what a tie and a blank are
 * typed into.
 *
 * What a drag is good at is the common case — a dozen players, one pass
 * (R-256) — so the rows now sit in two zones, and moving between them is the
 * addition (UC-33 3e, 3f). **In the order** holds the rows with a place, as
 * they read; a drop on a row lands before it and renumbers 1, 2, 3 by list
 * position, and a slot that appears under the last row while a drag is in
 * flight lands it last. **Took part, not placed** holds the rest, in
 * participant order; a row dropped there — on its heading, on a row of it, or
 * on the sentence it shows when empty — has its place cleared, which is 3b,
 * named on the screen for the first time. A number
 * typed into a row already in the order changes that row and moves nothing,
 * which is how the tie is reachable after a drag; a number typed into a row
 * below moves it up into the order at that place. The rules are
 * `placement-order.ts`'s, held as functions so they can be tested without a
 * drop.
 *
 * No dependency: HTML5 `draggable` on a handle per row — the handle and not
 * the row, because a draggable ancestor takes the mouse away from the box
 * inside it — and a pair of move buttons per row in the order, which is also
 * how it is done on a phone, where there is no drag. Nothing is saved until
 * Save, as on every other typed panel here.
 *
 * The two zones are **one `<ul>`**, with the lower heading as a row of it.
 * React carries a key within a parent and not across two, so two lists would
 * unmount a row the moment its box took it over the line — "12" typed from
 * below would commit "1", the row would jump, and the input under the caret
 * would be gone before the "2". One list means the node is moved, and the
 * caret and the focus move with it.
 *
 * It also makes UC-33 3c unreachable from this screen by construction: there
 * is exactly one box per participant, so nobody can be entered twice. The
 * server checks anyway (`duplicateMemberIn`), because a server action is a
 * public endpoint and a roster can move under a page that is ten minutes old.
 *
 * ## Teams or players, never both at once
 *
 * `eventParticipants` decides what there is to place, not this component: the
 * teams when the event had them, otherwise the accepted applicants. A team's
 * place scores for everybody on it (R-180), so each team row says who that is
 * — the manager is handing out points to those names, and should be able to
 * see them.
 *
 * A teamed event has a second way (UC-52): a place for each rostered player.
 * The players carry their team on the line under the name rather than as a
 * heading — a finishing order across teams cannot also be grouped by team. In
 * the order they sit where they finished; below it they come team by team, so
 * teammates not yet placed sit together. Which of the two the
 * screen opens on is **read off what is recorded** — a player's place means
 * the players — and is stored nowhere, because the ids in the order already
 * say which it is. The choice is a pair of chips, offered only when there are
 * teams (UC-52 2a). The two never mix: the boxes are one subject's, and the
 * other subject's recorded places are not boxes but a sentence saying the save
 * replaces them (UC-52 4, 4a). `setPlacements` decides each place's column
 * from its id, so the payload carries nothing about the choice either.
 *
 * ## Somebody who has since left
 *
 * A place already recorded for somebody no longer in the participant list — an
 * applicant who withdrew after the night — is still shown, in its own group,
 * with its own box and outside both zones, because there is no row to drag.
 * They did take part and they did finish there. Hiding the row would mean the
 * next save silently deleted their result, which is the one thing a correction
 * must never do quietly.
 */

export type PlacementEditorProps = {
  eventId: string;
  /** The season, its table and its weight — everything a place is worth. */
  counting: EventChampionship;
  participants: EventParticipants;
  /** What is already recorded, by the id it is recorded against — a team's or a member's. */
  placements: RecordedPlacement[];
};

/** One row of the order: a team, or a player, and the line under the name. */
type Row = {
  id: string;
  name: string;
  /** Who a team's place pays, or the team a player played for. `null` for a lone player. */
  detail: string | null;
};

/** What there is to place for one subject — the teams, or every rostered player team by team. */
function rowsFor(participants: EventParticipants, subject: RecordedPlacement["kind"]): Row[] {
  if (participants.teamed && subject === "member") {
    return participants.rows.flatMap((team) =>
      team.members.map((member) => ({ id: member.userId, name: member.name, detail: team.name }))
    );
  }
  return participants.rows.map((row) => ({
    id: row.id,
    name: row.name,
    detail:
      participants.teamed && row.members.length > 0
        ? row.members.map((member) => member.name).join(", ")
        : null,
  }));
}

export default function PlacementEditor({
  eventId,
  counting,
  participants,
  placements,
}: PlacementEditorProps) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  /*
   * Whose the places are: the teams', or a member's each. Read off what is
   * recorded — one player's place means the players — and otherwise the teams
   * when there are any. An event without teams has only members to place.
   */
  const [subject, setSubject] = useState<RecordedPlacement["kind"]>(() =>
    participants.teamed && !placements.some((place) => place.kind === "member")
      ? "team"
      : "member"
  );
  const [order, setOrder] = useState<Order>(() => {
    const places = Object.fromEntries(
      placements.map((place) => [place.id, String(place.position)])
    );
    return {
      places,
      sequence: sequenceFor(
        rowsFor(participants, subject).map((row) => row.id),
        places
      ),
    };
  });
  /** The row on the move, while a drag is in flight. */
  const [dragging, setDragging] = useState<string | null>(null);

  const season = counting.season;
  const closed = season.status === "closed";
  const table = counting.pointsTable?.length ? counting.pointsTable : season.pointsTable;

  const rows = rowsFor(participants, subject);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = order.sequence.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const unplaced = rows.filter((row) => !order.sequence.includes(row.id));

  /*
   * Recorded for somebody with no box above. On a teamed event the other
   * subject's places are not that — they are what this save replaces — so
   * they are counted below instead of listed here.
   */
  const left: Row[] = placements
    .filter(
      (place) =>
        !byId.has(place.id) && (!participants.teamed || place.kind === subject)
    )
    .map((place) => ({ id: place.id, name: place.name, detail: null }));
  const replaced = participants.teamed
    ? placements.filter((place) => place.kind !== subject).length
    : 0;

  /*
   * The server's own rule, asked here as it is typed — `positionProblem` and
   * not a copy of it, because this is what decides whether Save is enabled and
   * a second copy would drift into a button that disagrees with the write.
   */
  const problem = [...rows, ...left]
    .map((row) => placeFrom(order.places[row.id] ?? ""))
    .reduce<string | null>(
      (found, place) => found ?? (place === null ? null : positionProblem(place)),
      null
    );

  // A rule that moved nobody hands the same object back, and that is not an
  // edit: marking it dirty would raise the unsaved-changes bar for nothing.
  const change = (next: Order) => {
    if (next === order) return;
    setOrder(next);
    setState("dirty");
    setError(null);
  };

  /*
   * A box of somebody who has left: typed into, and in neither zone. Written
   * to `places` alone and not through `typed`, which would put them in the
   * sequence — a row that is not on the screen, which the next drop would
   * then renumber.
   */
  const set = (id: string, value: string) =>
    change({ ...order, places: { ...order.places, [id]: value } });

  // Dirty, because the save now writes a different order: the other subject's
  // places go with it (UC-52 4, 4a). The order zone is re-read for the new rows.
  const pick = (next: RecordedPlacement["kind"]) => {
    setSubject(next);
    change({
      places: order.places,
      sequence: sequenceFor(
        rowsFor(participants, next).map((row) => row.id),
        order.places
      ),
    });
  };

  const lift = (event: DragEvent, id: string) => {
    // Firefox starts no drag without data; the id itself travels in state.
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
    setDragging(id);
  };
  const allow = (event: DragEvent) => {
    if (dragging !== null) event.preventDefault();
  };
  /** Let go inside the order: before this row, or last when on the slot after the rows. */
  const land = (event: DragEvent, before: string | null) => {
    if (dragging === null) return;
    event.preventDefault();
    change(dropped(order, dragging, before));
    setDragging(null);
  };
  /** Let go below: took part, finished nowhere (UC-33 3f). Nothing, for a row already there. */
  const release = (event: DragEvent) => {
    if (dragging === null) return;
    event.preventDefault();
    if (order.sequence.includes(dragging)) change(typed(order, dragging, ""));
    setDragging(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);

    const entries: PlacementEntry[] = [];
    for (const row of [...rows, ...left]) {
      const place = placeFrom(order.places[row.id] ?? "");
      if (place !== null) entries.push({ id: row.id, position: place });
    }

    try {
      const result = await saveEventPlacementsAction(eventId, entries);
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

  const noun = subject === "team" ? "team" : "player";
  const zone = cx(
    "divide-y divide-hair border-y",
    dragging !== null ? "border-union" : "border-hair"
  );

  return (
    <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12">
      {error && <Alert>{error}</Alert>}

      <div>
        <Eyebrow className="mb-2">Where everyone finished</Eyebrow>
        <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
          Type each {noun}&apos;s place, or drag the rows into the order. Anyone left below
          took part and finished outside the table — they get the taking-part points. Two
          who genuinely tied share a place, and the next one stays empty: type that, because
          a drag cannot say it.
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

      {participants.teamed && (
        <div className="space-y-3">
          <ChoiceRow>
            <ChoiceChip
              selected={subject === "team"}
              disabled={closed}
              onClick={() => pick("team")}
            >
              A place for each team
            </ChoiceChip>
            <ChoiceChip
              selected={subject === "member"}
              disabled={closed}
              onClick={() => pick("member")}
            >
              A place for each player
            </ChoiceChip>
          </ChoiceRow>
          <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
            A team&apos;s place pays everybody on it. A player&apos;s place pays that player
            alone, so two who played together can finish apart. One or the other, never both
            {replaced > 0
              ? `: saving replaces the ${plural(replaced, "place")} recorded for the ${
                  subject === "team" ? "players" : "teams"
                }.`
              : "."}
          </p>
        </div>
      )}

      {rows.length === 0 && left.length === 0 && (
        <EmptyState>
          Nobody took part yet. {participants.teamed ? "Teams" : "Accepted applicants"} show up
          here, and a place can be recorded for each of them.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <Eyebrow as="h3">In the order</Eyebrow>
          <ul className={zone}>
            {ordered.length === 0 && (
              <li
                className="py-3 text-13 leading-relaxed text-muted"
                onDragOver={allow}
                onDrop={(event) => land(event, null)}
              >
                Nobody is placed yet. Drag a row up here, or type a place into their box.
              </li>
            )}
            {ordered.map((row, index) => (
              <PlaceRow
                key={row.id}
                row={row}
                value={order.places[row.id] ?? ""}
                disabled={closed}
                lifted={dragging === row.id}
                onChange={(value) => change(typed(order, row.id, value))}
                onLift={(event) => lift(event, row.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={allow}
                onLand={(event) => land(event, row.id)}
              >
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    className="min-h-11 min-w-11"
                    aria-label={`Move ${row.name} up`}
                    disabled={closed || index === 0}
                    onClick={() => change(dropped(order, row.id, ordered[index - 1].id))}
                  >
                    ↑
                  </Button>
                  <Button
                    className="min-h-11 min-w-11"
                    aria-label={`Move ${row.name} down`}
                    disabled={closed || index === ordered.length - 1}
                    onClick={() =>
                      change(dropped(order, row.id, ordered[index + 2]?.id ?? null))
                    }
                  >
                    ↓
                  </Button>
                </span>
              </PlaceRow>
            ))}
            {dragging !== null && ordered.length > 0 && (
              <li
                className="border-t border-dashed border-union py-3 text-13 text-muted"
                onDragOver={allow}
                onDrop={(event) => land(event, null)}
              >
                Last in the order
              </li>
            )}
            <li
              className="pb-2 pt-6"
              onDragOver={allow}
              onDrop={release}
            >
              <Eyebrow as="h3">Took part, not placed</Eyebrow>
            </li>
            {unplaced.length === 0 && (
              <li
                className="py-3 text-13 leading-relaxed text-muted"
                onDragOver={allow}
                onDrop={release}
              >
                Everybody has a place. Drag a row down here, or clear their box, to take them
                out of the order.
              </li>
            )}
            {unplaced.map((row) => (
              <PlaceRow
                key={row.id}
                row={row}
                value={order.places[row.id] ?? ""}
                disabled={closed}
                lifted={dragging === row.id}
                onChange={(value) => change(typed(order, row.id, value))}
                onLift={(event) => lift(event, row.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={allow}
                onLand={release}
              />
            ))}
          </ul>
        </div>
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
                value={order.places[row.id] ?? ""}
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

/**
 * One row: its handle when it can be dragged, its box, its name, and whatever
 * the zone adds after. The handle is `aria-hidden` because it is the mouse's
 * way only; the keyboard's is the buttons and the box.
 */
function PlaceRow({
  row,
  value,
  disabled,
  lifted = false,
  onChange,
  onLift,
  onDragEnd,
  onDragOver,
  onLand,
  children,
}: {
  row: Row;
  value: string;
  disabled: boolean;
  /** Being dragged right now. */
  lifted?: boolean;
  onChange: (value: string) => void;
  /** Drag started on the handle. Absent for a row with nothing to drag. */
  onLift?: (event: DragEvent) => void;
  /** The drag ended, wherever it did. */
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent) => void;
  /** Another row let go on this one. */
  onLand?: (event: DragEvent) => void;
  children?: ReactNode;
}) {
  return (
    <li
      className={cx("flex flex-wrap items-center gap-3 py-2", lifted && "opacity-50")}
      onDragOver={onDragOver}
      onDrop={onLand}
    >
      {onLift && !disabled && (
        <span
          aria-hidden
          draggable
          onDragStart={onLift}
          onDragEnd={onDragEnd}
          className="flex h-11 w-11 shrink-0 cursor-grab select-none items-center justify-center text-16 text-dim"
        >
          ≡
        </span>
      )}
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
      <div className="min-w-0 flex-1">
        <p className="text-14 text-chalk/80">{row.name}</p>
        {row.detail && <p className="text-12 leading-relaxed text-muted">{row.detail}</p>}
      </div>
      {children}
    </li>
  );
}
