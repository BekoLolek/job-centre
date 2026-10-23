"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Checkbox,
  ChoiceChip,
  ChoiceRow,
  Eyebrow,
  Field,
  Panel,
  plural,
} from "@/components/ui";
import {
  DRAFT_AWARDED_REFUSAL,
  type EventShape,
  MAX_PER_TEAM,
  type SizingMode,
  shapeProblem,
  sizingConsequence,
  teamsInTheWayRefusal,
} from "@/lib/events-policy";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { saveEventShapeAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";
import { SETUP_LABELS, TAB_LABELS, TEAM_ONLY_KEYS, visibleTabs } from "./tabs";

/**
 * Format — the Setup panel that says what kind of event this is
 * (R-217, R-218 / UC-42 1-4).
 *
 * Three decisions, in the order an admin makes them: **does it have sides**,
 * **is there a draft**, and **how big are the sides**. Nothing else; the
 * bracket shape is the step this panel is careful not to be called the same
 * thing as (see `tabs.ts`, {@link SetupKey}).
 *
 * ## One figure, and the other as its consequence
 *
 * R-218's whole point. The admin sets either a number of teams or a number of
 * players on one, and the panel prints the other *underneath* as what follows
 * — "6 per team → 3 teams from the 18 accepted". The derived figure is never
 * stored and there is no box to type it into, which is what makes drift
 * impossible rather than merely unlikely: accept three more players and the
 * sentence changes on the next render with nothing saved, because
 * `sizingConsequence` is arithmetic over the accepted count.
 *
 * ## What it says before it refuses
 *
 * Every refusal this panel can run into is on the panel before the save is
 * attempted, from the same pure functions the action uses — the bounds
 * (`shapeProblem`), the accepted count being too small to make two sides
 * (`planTeams`, through `sizingConsequence`), the teams already in the way
 * (UC-42 2a) and the awarded lots that settle it (UC-42 3a). The server refuses
 * again anyway. That is not belt-and-braces, it is UC-42 5b: a panel is a
 * screen and a screen is not a guard.
 *
 * ## And what it tells the admin they are about to lose
 *
 * Turning teams off takes four tabs away with it (R-219), so the panel names
 * them off `tabs.ts` rather than listing them again here. An admin who is one
 * click from losing the bracket should be told that is what the click does.
 */

export default function ShapeTab({
  eventId,
  shape,
  accepted,
  existingTeams,
  draftStarted,
}: {
  eventId: string;
  /** As stored — `eventShapeFrom(event.config)`, read on the server. */
  shape: EventShape;
  /** How many applicants are accepted, for the derived figure (UC-42 4). */
  accepted: number;
  /** How many teams the event already has, for UC-42 2a. */
  existingTeams: number;
  /** True once a lot has been awarded — UC-42 3a. */
  draftStarted: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const [teamEvent, setTeamEvent] = useState(shape.teamEvent);
  const [draft, setDraft] = useState(shape.draft);
  const [mode, setMode] = useState<SizingMode>(shape.sizing.mode);
  const [value, setValue] = useState(String(shape.sizing.value));
  const [discard, setDiscard] = useState(false);

  const typed = Number(value.trim());
  const edited: EventShape = {
    teamEvent,
    draft,
    // `NaN` rather than a 0 nobody typed, so `shapeProblem` refuses "1o"
    // instead of reading it as a number — `ChampionshipTab`'s `numberFrom` has
    // the argument.
    sizing: { mode, value: Number.isFinite(typed) ? typed : Number.NaN },
  };

  const bounds = shapeProblem(edited);
  const consequence = sizingConsequence(edited.sizing, accepted);

  /*
   * UC-42 2a and 3a, asked here in the same words the action answers in. The
   * draft refusal covers going solo as well as switching the draft off: a solo
   * event has no Draft tab at all, so it is the same loss by another route.
   */
  const losingDraft = draftStarted && (!teamEvent || !draft);
  const losingTeams = !teamEvent && existingTeams > 0;
  const refusal = losingDraft
    ? DRAFT_AWARDED_REFUSAL
    : losingTeams && !discard
      ? teamsInTheWayRefusal(existingTeams)
      : (bounds ?? (teamEvent ? consequence.problem : null));

  const dropping = TEAM_ONLY_KEYS.filter((tab) => !visibleTabs(edited).includes(tab));

  const touch = () => {
    setState("dirty");
    setError(null);
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveEventShapeAction(eventId, {
        teamEvent,
        draft,
        mode,
        value: edited.sizing.value,
        discardTeams: discard,
      });
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setDiscard(false);
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

      <Panel as="section" padding="none" className="space-y-6">
        <div>
          <Eyebrow className="mb-2">{SETUP_LABELS.shape}</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            What kind of night this is. It is settled per event rather than per game, so
            the same game can be a solo scramble one week and teams the next — and the
            editor only draws the tabs the answer leaves standing.
          </p>
        </div>

        {/* 1. Sides or no sides (UC-42 2) */}
        <div className="space-y-3">
          <Eyebrow as="h3">Does it have teams?</Eyebrow>
          <ChoiceRow>
            <ChoiceChip
              selected={teamEvent}
              onClick={() => {
                setTeamEvent(true);
                touch();
              }}
            >
              Teams
            </ChoiceChip>
            <ChoiceChip
              selected={!teamEvent}
              onClick={() => {
                setTeamEvent(false);
                setDiscard(false);
                touch();
              }}
            >
              Everyone for themselves
            </ChoiceChip>
          </ChoiceRow>
          {dropping.length > 0 && (
            <p className="text-12 leading-relaxed text-muted">
              {dropping.map((tab) => TAB_LABELS[tab]).join(", ")}{" "}
              {dropping.length === 1 ? "goes" : "go"} from the rail. Schedule and Results
              stay — a solo event still has a running order and a winner.
            </p>
          )}
        </div>

        {/* 2. The draft (UC-42 3) */}
        {teamEvent && (
          <div className="space-y-3 border-t border-hair pt-5">
            <Eyebrow as="h3">Is there a draft?</Eyebrow>
            <ChoiceRow>
              <ChoiceChip
                selected={draft}
                onClick={() => {
                  setDraft(true);
                  touch();
                }}
              >
                An auction draft
              </ChoiceChip>
              <ChoiceChip
                selected={!draft}
                onClick={() => {
                  setDraft(false);
                  touch();
                }}
              >
                No draft
              </ChoiceChip>
            </ChoiceRow>
            <p className="text-12 leading-relaxed text-muted">
              Without one the Draft tab goes and the teams are filled on the Teams tab.
              Teams and Bracket stay either way.
            </p>
          </div>
        )}

        {/* 3. The sizing — one mode, the other derived (R-218 / UC-42 3, 4) */}
        {teamEvent && (
          <div className="space-y-3 border-t border-hair pt-5">
            <Eyebrow as="h3">How are the teams sized?</Eyebrow>
            <ChoiceRow>
              <ChoiceChip
                selected={mode === "teams"}
                onClick={() => {
                  setMode("teams");
                  touch();
                }}
              >
                A number of teams
              </ChoiceChip>
              <ChoiceChip
                selected={mode === "perTeam"}
                onClick={() => {
                  setMode("perTeam");
                  touch();
                }}
              >
                Players per team
              </ChoiceChip>
            </ChoiceRow>

            <Field
              label={mode === "teams" ? "How many teams" : "Players on a team"}
              hint={
                mode === "teams"
                  ? `${MIN_TEAMS} to ${MAX_TEAMS}. The size of a side follows from it.`
                  : `1 to ${MAX_PER_TEAM}. The number of teams follows from it.`
              }
              type="number"
              inputMode="numeric"
              min={mode === "teams" ? MIN_TEAMS : 1}
              max={mode === "teams" ? MAX_TEAMS : MAX_PER_TEAM}
              step={1}
              value={value}
              wrapperClassName="w-44"
              onChange={(field) => {
                setValue(field.target.value);
                touch();
              }}
            />

            {/*
              The consequence. Not a box and not stored — see the module
              docblock. `assumed` is UC-42 4a: with nobody accepted there is no
              count to divide, so the line says what it is assuming instead of
              printing a figure as though it were settled.
            */}
            <p className="text-14 leading-relaxed text-chalk/80">
              <Badge tone="default">{consequence.stated}</Badge>{" "}
              <span aria-hidden>→</span>{" "}
              <span className={consequence.assumed ? "text-muted" : undefined}>
                {consequence.consequence}
              </span>
            </p>
            {consequence.assumed && (
              <p className="text-12 leading-relaxed text-muted">
                Nobody is accepted yet, so that is an assumption rather than a count. It
                settles itself as applications are decided — nothing here needs saving
                again.
              </p>
            )}
            {consequence.short.length > 0 && (
              <p className="text-12 leading-relaxed text-muted">
                {plural(consequence.short.length, "team")} short of the biggest —{" "}
                {consequence.short.join(", ")}. The remainder is spread one per team rather
                than left on one short side, and this is before anything is saved.
              </p>
            )}
          </div>
        )}

        {/* UC-42 2a — the confirmation, not a silent discard */}
        {losingTeams && !losingDraft && (
          <div className="space-y-3 border-t border-hair pt-5">
            <Alert tone="union" standing>
              {teamsInTheWayRefusal(existingTeams)}
            </Alert>
            <Checkbox
              label={`Discard the ${plural(existingTeams, "team")} and their rosters`}
              checked={discard}
              onChange={(next) => {
                setDiscard(next);
                touch();
              }}
            />
          </div>
        )}

        {refusal && (
          <p className="text-13 leading-relaxed text-flare" role="status">
            {refusal}
          </p>
        )}

        <SaveRow
          state={state}
          disabled={refusal !== null}
          reason={refusal}
          onSave={() => void save()}
          label="Save the format"
        />
      </Panel>
    </>
  );
}
