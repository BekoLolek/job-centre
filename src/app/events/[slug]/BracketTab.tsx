"use client";

import { BracketCanvas, StandingsTable } from "@/components/format";
import ZoneNote from "@/components/format/ZoneNote";
import { advancePerGroup, formatSentence } from "@/components/format/labels";
import { tableStarted } from "@/components/format/board";
import { Badge, EmptyState, Eyebrow, Panel, plural } from "@/components/ui";
import type { StageView } from "@/lib/format";

/**
 * The Bracket tab (§4: the bracket plus standings).
 *
 * The canvas, the cards and the table are all `src/components/format/` — the
 * same components the admin's Results tab draws — so a bracket looks the same
 * whoever is looking at it and there is exactly one implementation of "what
 * does an unresolved slot say". The public half adds no controls: this file
 * passes no `renderExtra`, so there is nothing to click.
 *
 * **Why a client component.** The cards print match start times, and an instant
 * formatted on the server is formatted in the deployment's zone. Everything
 * under this boundary formats in the browser instead, and the zone it used is
 * stated at the top.
 *
 * The podium is deliberately *not* here. It belongs to the whole event rather
 * than to one of its stages — a group table crowns nobody — so the page prints
 * it above the tab strip, where it is visible without picking a tab. A finished
 * bracket below stays exactly as it was: nothing is hidden after the fact.
 */

export type BracketTabProps = {
  stages: StageView[];
};

export default function BracketTab({ stages }: BracketTabProps) {
  if (stages.length === 0) {
    return (
      <Panel as="section">
        <Eyebrow className="mb-4">Bracket</Eyebrow>
        <EmptyState>
          The format has not been set up yet. Teams, a shape and a bracket arrive here together.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="space-y-8">
      {stages.map((stage, index) => (
        <Stage
          key={stage.id}
          stage={stage}
          showZone={index === 0}
          numbered={stages.length > 1 ? index + 1 : null}
        />
      ))}
    </div>
  );
}

function Stage({
  stage,
  showZone,
  numbered,
}: {
  stage: StageView;
  showZone: boolean;
  numbered: number | null;
}) {
  const played = stage.matches.filter((match) => match.status === "done").length;
  const waiting = stage.matches.filter((match) => !match.teamAId || !match.teamBId).length;
  // A table is only worth printing for a stage that actually plays one — a
  // straight knockout has standings in the sense that every team is in them and
  // nobody has a points total, which is a table of zeroes.
  const hasTable = stage.matches.some((match) => match.bracket === "rr");
  const tables = stage.groups.length > 0 ? stage.groups : [{ key: "", standings: stage.standings }];

  return (
    <section className="space-y-6">
      <Panel padding="md">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="font-display text-2xl">
            {numbered ? `${numbered}. ` : ""}
            {stage.name}
          </h2>
          {showZone && <ZoneNote />}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {formatSentence(stage.spec).map((part) => (
            <Badge key={part}>{part}</Badge>
          ))}
        </div>

        <p className="mt-4 border-t border-hair pt-3 text-xs text-muted">
          <span className="num text-gold">{played}</span> of{" "}
          {plural(stage.matches.length, "match", "matches")} played.
          {waiting > 0 &&
            " Slots that are still waiting show what they are waiting on rather than a team name."}
        </p>
      </Panel>

      {hasTable &&
        tables.map((table) => (
          <section key={table.key || "table"}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <Eyebrow as="h3">
                {table.key ? `Group ${table.key.toUpperCase()} table` : "Standings"}
              </Eyebrow>
              {!tableStarted(table.standings) && (
                <Eyebrow as="span" className="text-dim">
                  Nothing played yet
                </Eyebrow>
              )}
            </div>
            <StandingsTable
              rows={table.standings}
              qualify={table.key ? advancePerGroup(stage.spec) : null}
              showGames={stage.matches.some((match) => match.bracket === "rr" && match.bestOf > 1)}
            />
          </section>
        ))}

      {stage.matches.length > 0 && (
        <BracketCanvas matches={stage.matches} featuredSlot={stage.spec.championSlot} compact />
      )}
    </section>
  );
}
