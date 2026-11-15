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
  Stepper,
  Toggle,
  plural,
} from "@/components/ui";
import {
  DRAFT_AWARDED_REFUSAL,
  type EventShape,
  MAX_HEROES_PER_ROLE,
  MAX_PER_TEAM,
  type RosterHolding,
  type SizingMode,
  type TeamFormat,
  heroWidthProblem,
  rosterBelowAwardedRefusal,
  rosterSizingFrom,
  shapeProblem,
  sizingConsequence,
  teamsInTheWayRefusal,
} from "@/lib/events-policy";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { saveEventShapeAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";
import {
  type HeroListFact,
  SETUP_LABELS,
  TAB_LABELS,
  TEAM_ONLY_KEYS,
  visibleTabs,
} from "./tabs";

/**
 * Format — the Setup panel that says what kind of event this is
 * (R-217, R-218 / UC-42 1-4).
 *
 * Three decisions, in the order an admin makes them: **does it have sides**,
 * **is there a draft**, and **how big are the sides**. Then a fourth that
 * stands apart from them, because it is asked of a solo night as well: **does
 * it draw random heroes, and how many in each role** (R-269, R-270 / UC-58).
 * Nothing else; the bracket shape is the step this panel is careful not to be
 * called the same thing as (see `tabs.ts`, {@link SetupKey}).
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
 * (UC-42 2a), the awarded lots that settle it (UC-42 3a) and a figure below a
 * roster those awards filled (UC-49 1c), and a hero width outside its bound
 * (`heroWidthProblem`). The server refuses again anyway. That
 * is not belt-and-braces, it is UC-42 5b: a panel is a screen and a screen is
 * not a guard.
 *
 * ## And the one thing it says without refusing
 *
 * The Teams tab's stated 6v6 or 3v3 can disagree with the places the sizing
 * allows, and the panel says so in a note that blocks nothing (R-251 / UC-49
 * 1d). R-215 is "stated, never enforced": a 6v6 night fielding eight with
 * substitutes is a real night, which is why `MAX_PER_TEAM` is 32. The note is
 * deliberately not part of `refusal` below, and
 * `shape-panel-stated-format.test.ts` holds the save row open beside it.
 *
 * ## What the hero answers never refuse
 *
 * Turning the draw off is never refused, however many hands are already dealt
 * — they are kept, and the panel says so instead. And a width the game's hero
 * list cannot deal is not refused here either (UC-58 5a): the list can be
 * filled in afterwards, and the draw is what refuses a role too thin. The
 * only refusal the number has is its typo guard, `MAX_HEROES_PER_ROLE`.
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
  heroList,
  accepted,
  existingTeams,
  draftStarted,
  teamFormat,
  rosters,
}: {
  eventId: string;
  /** As stored — `eventShapeFrom(event.config)`, read on the server. */
  shape: EventShape;
  /**
   * Whether the event's game has a hero list — the one fact `visibleTabs`
   * needs that this panel does not decide. Required, because `TabVisibility`
   * requires it (see that type for why), and this panel asks `visibleTabs`
   * which tabs an edit would take away: it passes the real fact through
   * rather than a guess, even though no answer here can change it.
   */
  heroList: HeroListFact;
  /** How many applicants are accepted, for the derived figure (UC-42 4). */
  accepted: number;
  /** How many teams the event already has, for UC-42 2a. */
  existingTeams: number;
  /** True once a lot has been awarded — UC-42 3a, UC-49 1c. */
  draftStarted: boolean;
  /** The night as the Teams tab states it (R-215), for the note — UC-49 1d. */
  teamFormat: TeamFormat;
  /** Each team and what it holds, for UC-49 1c to name the ones in the way. */
  rosters: readonly RosterHolding[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const [teamEvent, setTeamEvent] = useState(shape.teamEvent);
  const [draft, setDraft] = useState(shape.draft);
  const [mode, setMode] = useState<SizingMode>(shape.sizing.mode);
  const [value, setValue] = useState(String(shape.sizing.value));
  const [discard, setDiscard] = useState(false);
  const [heroes, setHeroes] = useState(shape.heroes);
  // `null` is the box cleared — `Stepper`'s own empty state, and not a width.
  const [perRole, setPerRole] = useState<number | null>(shape.heroesPerRole);

  const typed = Number(value.trim());
  const edited: EventShape = {
    teamEvent,
    draft,
    // `NaN` rather than a 0 nobody typed, so `shapeProblem` refuses "1o"
    // instead of reading it as a number — `ChampionshipTab`'s `numberFrom` has
    // the argument.
    sizing: { mode, value: Number.isFinite(typed) ? typed : Number.NaN },
    heroes,
    // `NaN` for a cleared box, for the sizing's reason above: refused as not a
    // whole number rather than read as a width nobody typed.
    heroesPerRole: perRole ?? Number.NaN,
  };

  const bounds = shapeProblem(edited);
  const consequence = sizingConsequence(edited.sizing, accepted);
  // The places the edit would leave on a team — the figure the action measures
  // the rosters against, and the one the stated format is read beside.
  const cap = rosterSizingFrom(edited, accepted).cap;
  // Null whenever the draw is off, so turning it off can never be what stops
  // a save — whatever the number was left on.
  const heroProblem = heroWidthProblem(edited);

  /*
   * UC-42 2a and 3a and UC-49 1c, asked here in the same words the action
   * answers in. The draft refusal covers going solo as well as switching the
   * draft off: a solo event has no Draft tab at all, so it is the same loss by
   * another route. The roster refusal sits behind the bounds because the
   * action checks those first, and it cannot meet the two above it: a solo
   * edit has no places to be below.
   */
  const losingDraft = draftStarted && (!teamEvent || !draft);
  const losingTeams = !teamEvent && existingTeams > 0;
  const refusal = losingDraft
    ? DRAFT_AWARDED_REFUSAL
    : losingTeams && !discard
      ? teamsInTheWayRefusal(existingTeams)
      : (bounds ??
        heroProblem ??
        rosterBelowAwardedRefusal(rosters, cap, draftStarted) ??
        (teamEvent ? consequence.problem : null));

  // UC-49 1d. Never folded into `refusal`: a note, and the save goes through —
  // unless something else refuses it, and then the note stays and says only
  // that it is not the reason.
  const formatDisagrees = cap !== null && bounds === null && cap !== teamFormat.teamSize;

  const dropping = TEAM_ONLY_KEYS.filter(
    (tab) => !visibleTabs({ ...edited, heroList }).includes(tab)
  );

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
        heroes,
        heroesPerRole: edited.heroesPerRole,
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
            {formatDisagrees && (
              <p className="text-12 leading-relaxed text-muted">
                The Teams tab states a {teamFormat.format} night — {teamFormat.teamSize} a
                side — and the sizing here allows {cap}. That is a note, not a refusal: the
                format is stated, never enforced,{" "}
                {refusal === null
                  ? "so this saves as it is."
                  : "and it is not what is stopping this save."}
              </p>
            )}
          </div>
        )}

        {/* 4. The hero draw — asked of a solo night too (R-269, R-270 / UC-58 2, 4) */}
        <div className="space-y-3 border-t border-hair pt-5">
          <Eyebrow as="h3">Does it draw random heroes?</Eyebrow>
          <Toggle
            value={heroes}
            yesLabel="Random heroes"
            noLabel="No heroes"
            onChange={(next) => {
              // Tapping the lit chip clears a `Toggle`; this question has no
              // unanswered state to clear to, so the answer stays.
              setHeroes(next ?? heroes);
              touch();
            }}
          />

          {heroes && (
            <>
              {/*
                No `max` on this one, deliberately. `Stepper` clamps what is
                typed to its `max`, so handing it the bound would turn a typed
                33 into a saved 10 — a number nobody chose, with no refusal.
                Left to `Stepper`'s own ceiling, the 33 stands on the panel and
                `heroWidthProblem` refuses it in words. The cost is that plus
                steps past the bound into that same refusal instead of stopping.
              */}
              <label className="block max-w-xs">
                <Eyebrow as="span" className="mb-1 block text-inherit">
                  Heroes in each role
                </Eyebrow>
                <Stepper
                  value={perRole}
                  min={1}
                  suffix="per role"
                  aria-label="Heroes each player draws in each role"
                  aria-invalid={heroProblem !== null}
                  onChange={(next) => {
                    setPerRole(next);
                    touch();
                  }}
                />
              </label>
              <p className="text-12 leading-relaxed text-muted">
                1 to {MAX_HEROES_PER_ROLE}. A game whose hero list is too short for it is
                told so at the draw, not here — the list can be filled in afterwards.
              </p>
            </>
          )}

          {/*
            What the next draw will deal, in the sizing consequence's voice.
            Nothing is printed for a width that is being refused: the refusal
            below is the sentence about that number.
          */}
          {heroes && heroProblem === null && perRole !== null && (
            <p className="text-14 leading-relaxed text-chalk/80">
              <Badge tone="default">{perRole} per role</Badge> <span aria-hidden>→</span>{" "}
              The next draw deals each player {plural(perRole, "hero", "heroes")} in every
              role.
            </p>
          )}
          {!heroes && (
            <p className="text-14 leading-relaxed text-chalk/80">
              <Badge tone="default">No heroes</Badge> <span aria-hidden>→</span>{" "}
              <span className="text-muted">
                The next draw deals nobody a hand: {TAB_LABELS.hands} goes from the rail
                and the draw page closes. Hands already dealt are kept, and so is the
                number — turning this back on brings both back.
              </span>
            </p>
          )}
        </div>

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
