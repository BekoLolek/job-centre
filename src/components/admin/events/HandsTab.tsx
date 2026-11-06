"use client";

import type { ReactNode } from "react";
import { Badge, EmptyState, Eyebrow, Panel, StatTile } from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import { TAB_LABELS } from "./tabs";
import type { DealtHand, HandsTabData } from "./types";

/**
 * Hands — every hand dealt for this event, on one screen
 * (R-239 to R-243 / UC-47).
 *
 * A manager opens this to answer one question — *has everyone drawn?* — and
 * then to see what the room holds without asking nine people. So the count is
 * first, the seats that have not drawn are rows rather than absences (R-240),
 * and each hand reads the way the player's own screen does: three roles in
 * the order they were dealt, three names each (R-241), with when it was dealt
 * beside the name (R-242), so "I drew before you changed the list" can be
 * settled from here.
 *
 * ## It only reads (UC-47 5a)
 *
 * There is no form, no button and no action import in this file, and
 * `hands-tab.test.ts` asserts all three. The draw happens once and stands
 * (R-212): a control that redealt, cleared or drew on somebody's behalf would
 * be the feature failing rather than a convenience, so a seat that has not
 * drawn is chased, not dealt for. The rail is not an authorisation either
 * (UC-42 5b) — what keeps a member off this URL is the page's guard.
 *
 * ## It decides nothing
 *
 * `handSheet` in `src/lib/hands-sheet.ts` chose the rows, their order and
 * which of the four opening sentences applies; the page mapped each hand down
 * to what a card shows. This file draws what it is given and regroups, sorts,
 * filters and counts nothing — the sentence and the tile's tint are both read
 * off `kind` through lookups keyed by it, so a fifth kind is a type error here
 * rather than a sentence nobody wrote. The reasons are in that module's
 * docblock, and they are the reasons a sheet nobody can re-sort is one a
 * manager can trust.
 *
 * A hero that has since been retired is named with no mark against it (UC-47
 * 2b), and the data could not say otherwise if the panel wanted to: `DealtHand`
 * carries names and nothing about the rows they came from.
 */

/**
 * How the count is tinted, per state: lit while anybody is still to draw,
 * quiet once nobody is or there is nobody to count.
 */
const COUNT_TONE: Record<HandsTabData["kind"], string> = {
  no_seats: "text-muted",
  nobody_drawn: "text-union",
  drawing: "text-union",
  all_drawn: "text-body",
};

export default function HandsTab({ data }: { data: HandsTabData }) {
  const { kind, seats, former, drawn } = data;

  /*
   * The opening sentence, per state — `handSheet`'s decision in the screen's
   * words. `no_seats` is an `EmptyState` with somewhere to go rather than a
   * sentence, so it is drawn on its own below and this map has no entry for it.
   */
  const opening: Record<Exclude<HandsTabData["kind"], "no_seats">, ReactNode> = {
    nobody_drawn: (
      <p className="text-14 leading-relaxed text-union">
        Nobody has drawn yet. Every seat below is still to draw, so this is the list to
        chase before the night starts.
      </p>
    ),
    drawing: (
      <p className="text-14 leading-relaxed text-chalk/80">
        {drawn} of {seats.length} seats have drawn.
      </p>
    ),
    all_drawn: <p className="text-14 leading-relaxed text-chalk/80">Everyone has drawn.</p>,
  };

  return (
    <div className="space-y-6">
      <Panel as="section" padding="none" className="space-y-4">
        <div>
          <Eyebrow className="mb-2">{TAB_LABELS.hands}</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            Every hand dealt for this event, grouped by role in the order it was dealt, with
            when it was dealt. The draw happens once and stands, so there is nothing here to
            click: a seat that has not drawn is chased, not dealt for.
          </p>
        </div>

        {/* --- The number the manager came for (UC-47 4) -------------- */}
        <StatTile
          label="Drawn"
          value={`${drawn}/${seats.length}`}
          valueClassName={COUNT_TONE[kind]}
        />

        {/*
          The opening sentence is `handSheet`'s `kind`, printed — the decision
          is held in `hands-sheet.test.ts`, this is the words.
        */}
        {kind === "no_seats" ? (
          <EmptyState>
            Nobody holds a seat yet, so there is no sheet to draw. Accept applications on the
            Applicants tab and every seat appears here, drawn or not.
          </EmptyState>
        ) : (
          opening[kind]
        )}
      </Panel>

      {/* --- The seats, in the Applicants tab's order (UC-47 2, 3) ---- */}
      {seats.length > 0 && (
        <ul className="divide-y divide-hair/60 border-t border-hair">
          {seats.map((row) => (
            <HandRow
              key={row.userId}
              name={row.name}
              hand={row.hand}
              mark={row.hand === null ? <Badge tone="union">Not drawn yet</Badge> : null}
            />
          ))}
        </ul>
      )}

      {/* --- Hands whose holder lost their seat (R-243 / UC-47 3a) ---- */}
      {former.length > 0 && (
        <Panel as="section" padding="none" className="space-y-3 border-t border-hair pt-12">
          <Eyebrow>No longer holding a seat</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            Dealt to people who have since withdrawn, been declined or been moved to the
            queue. A hand stands once it is dealt, so a seat going does not erase what was in
            it: it is kept here, apart from the seats, rather than quietly dropped.
          </p>
          <ul className="divide-y divide-hair/60 border-t border-hair">
            {former.map((row) => (
              <HandRow
                key={row.userId}
                name={row.name ?? "A former member"}
                hand={row.hand}
                mark={<Badge>No seat</Badge>}
              />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/**
 * One person and what they hold: the name, when it was dealt or the mark that
 * says it was not, and the nine names under three role headings.
 *
 * The roles sit side by side from `sm` up and stack below it, so the sheet
 * reads at a phone's width without a sideways scroll — it is the screen a
 * manager has open on the night, and the night is run from a phone as often
 * as a desk.
 */
function HandRow({
  name,
  hand,
  mark,
}: {
  name: string;
  hand: DealtHand | null;
  /** Beside the name: "Not drawn yet", or "No seat". */
  mark: ReactNode;
}) {
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-14 text-chalk">{name}</span>
        {hand && (
          <span className="text-12 text-muted">
            Dealt <LocalTime at={hand.dealtAt} />
          </span>
        )}
        {mark}
      </div>

      {hand && (
        <dl className="grid gap-3 sm:grid-cols-3">
          {hand.roles.map((group) => (
            <div key={group.role}>
              <Eyebrow as="dt" className="mb-1">
                {group.role}
              </Eyebrow>
              <dd>
                {/*
                  Keyed by slot, not by name: one hand can name the same hero
                  twice — Deadpool in two roles — and both slots are drawn
                  (UC-47 2d).
                */}
                <ol className="space-y-0.5 text-14">
                  {group.names.map((hero, slot) => (
                    <li key={slot}>{hero}</li>
                  ))}
                </ol>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
