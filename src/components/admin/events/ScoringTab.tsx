"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ChoiceChip,
  ChoiceRow,
  Eyebrow,
  Field,
  Panel,
  Stepper,
} from "@/components/ui";
import { type PlayerBook, playerName } from "@/components/draft";
import {
  DEFAULT_ROUND_SCORING,
  type RoundScoring,
  givenRoundName,
  roundScoringConfirmRefusal,
  roundScoringLosses,
  roundScoringProblem,
  roundScoringSummary,
} from "@/lib/events-policy";
import { MAX_ROUNDS, type RoundScoreRow } from "@/lib/round-scoring";
import { saveRoundScoringAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";
import { SETUP_LABELS } from "./tabs";

/**
 * Scoring — the Setup panel that says how a solo night is scored
 * (R-225, R-226, R-229 / UC-44 1-6).
 *
 * Three questions, in the order a manager answers them: **how many rounds**
 * (and what any of them is called), **which way a round is won**, and **what
 * the bonuses are** with what each is worth. Then one sentence saying what the
 * site will do with the answers — "6 rounds, highest total wins, 2 bonuses" —
 * and that a blank round counts as that round's worst score (UC-44 5).
 *
 * ## What it says before it refuses
 *
 * Every refusal is on the panel before the save is attempted, from the same
 * pure functions the action uses: the bounds and the two bonus rules
 * (`roundScoringProblem`), and the three things a save would take away
 * (`roundScoringLosses`, over the rows the page read). The server refuses again
 * anyway — a panel is a screen and a screen is not a guard (UC-42 5b).
 *
 * ## The confirmation is one box, under the list of what goes
 *
 * Lowering the count under a scored round, deleting an awarded bonus and
 * flipping the direction with scores on the board are each named in their own
 * sentence and confirmed together, because they arrive together on one save.
 * Any further edit unticks the box: the sentences may have changed, and a yes
 * given to the old ones must not carry over.
 *
 * ## A round is named the way a day is
 *
 * Each name box is labelled by position — "Round 3" — and holds the name the
 * manager gave, if any. It carries no hint, because a round with no name of its
 * own would otherwise read "Round 3" twice (`givenRoundName`'s reason, which is
 * `dayLabel`'s). The sentence at the bottom and the loss sentences call each
 * round by `roundName`'s rule: the name given, or "Round N".
 */

export default function ScoringTab({
  eventId,
  scoring,
  rows,
  players,
}: {
  eventId: string;
  /** As stored — `roundScoringFrom(event.config)`, read on the server. Null: not round-scored. */
  scoring: RoundScoring | null;
  /** Every recorded score, for the three confirmations (UC-44 2b, 3a, 4d). */
  rows: readonly RoundScoreRow[];
  /** Who the rows name, for "to whom" (UC-44 4d). */
  players: PlayerBook;
}) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const stored = scoring ?? DEFAULT_ROUND_SCORING;
  const [rounds, setRounds] = useState<string[]>(stored.rounds.map((round) => round.name ?? ""));
  const [lowWins, setLowWins] = useState(stored.lowWins);
  const [bonuses, setBonuses] = useState<{ key: string; value: string }[]>(
    stored.bonuses.map((bonus) => ({ key: bonus.key, value: String(bonus.value) }))
  );
  const [confirmed, setConfirmed] = useState(false);

  const edited: RoundScoring = {
    rounds: rounds.map((name) => ({ name: givenRoundName({ name }) })),
    lowWins,
    bonuses: bonuses.map((bonus) => {
      // `NaN` rather than a 0 nobody typed, so the bound refuses "1o" instead
      // of reading it as a number — `ChampionshipTab`'s `numberFrom` argument.
      const typed = Number(bonus.value.trim());
      return {
        key: bonus.key.trim(),
        value: bonus.value.trim() !== "" && Number.isFinite(typed) ? typed : Number.NaN,
      };
    }),
  };

  const bounds = roundScoringProblem(edited);
  const losses = roundScoringLosses(scoring, edited, rows, (userId) =>
    playerName(players, userId, "a former member")
  );
  const refusal =
    bounds ?? (losses.length > 0 && !confirmed ? roundScoringConfirmRefusal(losses) : null);

  // Every edit unticks the confirmation: what it confirmed may have changed.
  const touch = () => {
    setState("dirty");
    setError(null);
    setConfirmed(false);
  };

  const setCount = (count: number | null) => {
    if (count === null) return;
    const next = Math.min(MAX_ROUNDS, Math.max(1, count));
    setRounds((current) =>
      next > current.length
        ? [...current, ...Array.from({ length: next - current.length }, () => "")]
        : current.slice(0, next)
    );
    touch();
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveRoundScoringAction(eventId, {
        rounds: edited.rounds.map((round) => ({ name: round.name })),
        lowWins: edited.lowWins,
        bonuses: edited.bonuses.map((bonus) => ({ key: bonus.key, value: bonus.value })),
        confirmed,
      });
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setConfirmed(false);
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
          <Eyebrow className="mb-2">{SETUP_LABELS.scoring}</Eyebrow>
          <p className="max-w-[62ch] text-14 leading-relaxed text-muted">
            How a night with no teams ends as one ranked list. Rounds are scored one at a
            time on the Results tab; the table is worked out from them and nothing adds
            up a column by hand.
          </p>
          {scoring === null && (
            <p className="mt-2 max-w-[62ch] text-13 leading-relaxed text-muted">
              This night is not scored in rounds yet. Save this panel and it is — the
              Results tab then takes a round at a time.
            </p>
          )}
        </div>

        {/* 1. The rounds (UC-44 2, 2a) */}
        <div className="space-y-3">
          <Eyebrow as="h3">How many rounds?</Eyebrow>
          <Stepper
            aria-label="Rounds"
            value={rounds.length}
            min={1}
            max={MAX_ROUNDS}
            onChange={setCount}
            suffix={rounds.length === 1 ? "round" : "rounds"}
          />
          <p className="text-12 leading-relaxed text-muted">
            Name a round only where the name matters — the rest are called by their
            number. Raising the count later adds an empty round and re-scores nothing.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {rounds.map((name, index) => (
              <Field
                key={index}
                label={`Round ${index + 1}`}
                placeholder="Name, if it matters"
                value={name}
                maxLength={60}
                onChange={(field) => {
                  const next = field.target.value;
                  setRounds((current) => current.map((own, at) => (at === index ? next : own)));
                  touch();
                }}
              />
            ))}
          </div>
        </div>

        {/* 2. The direction (UC-44 3) */}
        <div className="space-y-3 border-t border-hair pt-5">
          <Eyebrow as="h3">Which way is a round won?</Eyebrow>
          <ChoiceRow>
            <ChoiceChip
              selected={!lowWins}
              onClick={() => {
                setLowWins(false);
                touch();
              }}
            >
              Highest score wins
            </ChoiceChip>
            <ChoiceChip
              selected={lowWins}
              onClick={() => {
                setLowWins(true);
                touch();
              }}
            >
              Lowest score wins
            </ChoiceChip>
          </ChoiceRow>
          <p className="text-12 leading-relaxed text-muted">
            A points game — Popsauce — is won by the highest score. A placing game — Fall
            Guys — gives each player a finishing place, so the lowest wins. Bonuses count
            in the player&apos;s favour either way.
          </p>
        </div>

        {/* 3. The bonuses (UC-44 4, 4a) */}
        <div className="space-y-3 border-t border-hair pt-5">
          <Eyebrow as="h3">What are the bonuses?</Eyebrow>
          {bonuses.length === 0 ? (
            <p className="text-12 leading-relaxed text-muted">
              No bonuses yet. A feat worth rewarding that no round score captures — a
              sub-0.5-second answer, gold in every round — goes here with what it is worth,
              and is awarded as many times as it was earned.
            </p>
          ) : (
            <ul className="space-y-3">
              {bonuses.map((bonus, index) => (
                <li key={index} className="flex flex-wrap items-end gap-3">
                  <Field
                    label="Name"
                    placeholder="Sub-0.5 answer"
                    value={bonus.key}
                    maxLength={40}
                    wrapperClassName="min-w-[12rem] flex-1"
                    onChange={(field) => {
                      const next = field.target.value;
                      setBonuses((current) =>
                        current.map((own, at) => (at === index ? { ...own, key: next } : own))
                      );
                      touch();
                    }}
                  />
                  <Field
                    label="Worth"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={bonus.value}
                    wrapperClassName="w-28"
                    onChange={(field) => {
                      const next = field.target.value;
                      setBonuses((current) =>
                        current.map((own, at) => (at === index ? { ...own, value: next } : own))
                      );
                      touch();
                    }}
                  />
                  <Button
                    size="sm"
                    type="button"
                    aria-label={`Remove bonus ${index + 1}`}
                    onClick={() => {
                      setBonuses((current) => current.filter((_, at) => at !== index));
                      touch();
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            type="button"
            onClick={() => {
              setBonuses((current) => [...current, { key: "", value: "1" }]);
              touch();
            }}
          >
            Add a bonus
          </Button>
        </div>

        {/* UC-44 5 — what the site will do with the choices. Not stored. */}
        <p className="text-14 leading-relaxed text-chalk/80">
          <Badge tone="default">{roundScoringSummary(edited)}</Badge>{" "}
          <span className="text-muted">
            A player left blank for a round counts as that round&apos;s worst score, never
            as nothing.
          </span>
        </p>

        {/* UC-44 2b, 3a, 4d — the confirmation, not a silent discard */}
        {losses.length > 0 && (
          <div className="space-y-3 border-t border-hair pt-5">
            <Alert tone="union">
              <ul className="space-y-1">
                {losses.map((loss) => (
                  <li key={loss}>{loss}</li>
                ))}
              </ul>
            </Alert>
            <Checkbox
              label="Go ahead — I have read what changes"
              checked={confirmed}
              onChange={(next) => {
                setConfirmed(next);
                setState("dirty");
                setError(null);
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
          label="Save the scoring"
        />
      </Panel>
    </>
  );
}
