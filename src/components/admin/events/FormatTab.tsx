"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Panel,
  Select,
  Stepper,
  Toggle,
  plural,
} from "@/components/ui";
import {
  BracketCanvas,
  StandingsTable,
  advancePerGroup,
  bronzeFor,
  formatSentence,
  seriesLabel,
  seriesLengthsInUse,
  stageKindLabel,
  tiebreakerLabel,
  BRACKET_HALVES,
  BRONZE_CHOICES,
  STAGE_KIND_CHOICES,
} from "@/components/format";
import { type GeneratedStage, generateStage } from "@/lib/bracket";
import {
  type EliminationKind,
  type SeriesLength,
  type StageConfig,
  type StageKind,
  type Tiebreaker,
  MAX_TEAMS,
  MIN_TEAMS,
  SERIES_LENGTHS,
  TIEBREAKERS,
  modesFor,
  normaliseStageConfig,
} from "@/lib/format-policy";
// Type-only: `src/lib/format.ts` reaches Postgres, and a value import here
// would drag Drizzle and PGlite into the browser bundle.
import type { FormatView } from "@/lib/format";
import { resolveMatches } from "@/lib/format-resolve";
import {
  type StageFields,
  type StageImpact,
  generateStageAction,
  previewStagesAction,
  saveStagesAction,
} from "@/app/admin/events/format-actions";
import SaveRow, { type SaveState } from "./SaveRow";

/**
 * Format — the stages, the series lengths, the maps and the bracket options
 * (plan §8.2), with a preview of exactly what they produce.
 *
 * ## The preview is the generator, not a drawing of it
 *
 * `generateStage` is pure — it has no database handle and imports nothing but
 * `format-policy` — so the preview *calls it*. What the canvas below shows is
 * the same object `generateMatches` will write, built from the same config by
 * the same code, which is the only kind of preview worth having: a second
 * implementation that draws roughly the right shape would be wrong on exactly
 * the day it mattered. It is also why the config editor shows `spec.config`
 * rather than what was typed — `normaliseStageConfig` reads a bronze mode a
 * single elimination cannot express as a separate match, and the screen should
 * say so before the admin meets it in the generated bracket.
 *
 * ## Regenerating is destructive, so it asks first
 *
 * `generateMatches` deletes every match in the stage and refuses outright once
 * a single game has been ticked off — but it reports that as an *error*, which
 * is one moment too late to be useful. So this asks `previewStagesAction`
 * first, exactly as `DaysTab` asks `previewEventDays` and `TeamsTab` asks
 * `previewTeams`, and the dialog names the results that would go rather than
 * counting them. The same number governs the stage list: changing a played
 * stage's shape, or removing it, is refused by `setStages` for the same reason.
 *
 * ## The team count is not editable here
 *
 * It follows from the Teams tab and nothing on this screen may contradict it.
 * `generateStage` clamps to 2–8 itself, so this shows the number, says where it
 * comes from, and links there.
 */

type DraftStage = {
  /** Stable across reorders, so React does not reuse a row's input state. */
  key: string;
  /** Present for a stage that already exists. Its absence is what makes a delete. */
  id?: string;
  name: string;
  kind: StageKind;
  /** Held fully normalised, so the preview is exactly what will be stored. */
  config: StageConfig;
};

let counter = 0;
const nextKey = () => `new-${(counter += 1)}`;

export default function FormatTab({
  eventId,
  format,
  matchIds,
  maxStages,
}: {
  eventId: string;
  format: FormatView;
  /**
   * Slot to row id — the only honest answer to "has this stage been generated".
   *
   * `formatFor` resolves a stage's matches from its generated spec whether or
   * not a row exists, which is exactly what makes the preview below possible
   * and exactly why `stage.matches.length` cannot be counted: it is never zero.
   * A slot with no row id has no row.
   */
  matchIds: Record<string, string>;
  /** `MAX_STAGES`, handed down from the server page. */
  maxStages: number;
}) {
  const router = useRouter();
  const teams = format.teams;
  const teamCount = teams.length;

  const [stages, setStages] = useState<DraftStage[]>(() =>
    format.stages.map((stage) => ({
      key: stage.id,
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      config: normaliseStageConfig(stage.kind, stage.config),
    }))
  );

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [impacts, setImpacts] = useState<StageImpact[] | null>(null);
  /**
   * The stage a confirm dialog is currently about, and which of the two
   * destructive paths it is standing in front of. The dialog says the same
   * thing either way — these results go — but the button has to do the right
   * one, and "the stage in the dialog has an id" cannot tell them apart: a
   * stage whose *shape* is changing has an id too.
   */
  const [pending, setPending] = useState<
    { mode: "save" | "generate"; stage: DraftStage; impact: StageImpact } | null
  >(null);
  const [busy, setBusy] = useState(false);

  const touch = () => {
    setState("dirty");
    setError(null);
    setNote(null);
  };

  const stored = new Map(format.stages.map((stage) => [stage.id, stage]));
  const kept = new Set(stages.map((stage) => stage.id).filter(Boolean));
  const dropping = format.stages.filter((stage) => !kept.has(stage.id));

  const patch = (key: string, change: Partial<DraftStage>) => {
    setStages((current) =>
      current.map((stage) => {
        if (stage.key !== key) return stage;
        const next = { ...stage, ...change };
        // A kind change re-reads the config through that kind's rules: a bracket
        // reset outside a double elimination is meaningless and is dropped, and
        // a bronze mode is read into whatever the new bracket can express.
        return { ...next, config: normaliseStageConfig(next.kind, next.config) };
      })
    );
    touch();
  };

  const setConfig = (key: string, change: Partial<StageConfig>) => {
    setStages((current) =>
      current.map((stage) =>
        stage.key === key
          ? { ...stage, config: normaliseStageConfig(stage.kind, { ...stage.config, ...change }) }
          : stage
      )
    );
    touch();
  };

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= stages.length) return;
    setStages((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  const add = (kind: StageKind) => {
    if (stages.length >= maxStages) return;
    setStages((current) => [
      ...current,
      {
        key: nextKey(),
        name: stageKindLabel(kind),
        kind,
        config: normaliseStageConfig(kind, null),
      },
    ]);
    touch();
  };

  const remove = (key: string) => {
    setStages((current) => current.filter((stage) => stage.key !== key));
    touch();
  };

  const fields = (): StageFields[] =>
    stages.map((stage) => ({
      id: stage.id,
      name: stage.name.trim(),
      kind: stage.kind,
      config: stage.config,
    }));

  /** Ask what this would cost. Only writes once the answer has been read. */
  const attemptSave = async () => {
    setState("saving");
    setError(null);
    try {
      const preview = await previewStagesAction(eventId);
      setImpacts(preview);

      const risky = preview.filter((impact) => {
        const draft = stages.find((stage) => stage.id === impact.stageId);
        const shapeChanged = draft && draft.kind !== stored.get(impact.stageId)?.kind;
        return (!draft || shapeChanged) && impact.matches > 0;
      });
      if (risky.length > 0) {
        setPending({
          mode: "save",
          stage: stages.find((stage) => stage.id === risky[0].stageId) ?? stages[0],
          impact: risky[0],
        });
        setState("dirty");
        return;
      }
      await commit();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const commit = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveStagesAction(eventId, fields());
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      setPending(null);
      // Adopt the ids — and the *normalised* config — the server just wrote.
      // Without the ids the next save would delete these stages and insert
      // fresh ones, taking every match with them.
      setStages(
        result.data.stages.map((stage) => ({
          key: stage.id,
          id: stage.id,
          name: stage.name,
          kind: stage.kind as StageKind,
          config: normaliseStageConfig(stage.kind as StageKind, stage.config),
        }))
      );
      setNote("Saved");
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  /** Generate a stage's matches, asking first when there is anything to lose. */
  const attemptGenerate = async (stage: DraftStage) => {
    if (!stage.id) return;
    setError(null);
    setBusy(true);
    try {
      const preview = await previewStagesAction(eventId);
      setImpacts(preview);
      const impact = preview.find((row) => row.stageId === stage.id);
      if (impact && impact.matches > 0) {
        setPending({ mode: "generate", stage, impact });
        return;
      }
      await generate(stage);
    } catch {
      setError("Could not reach the server. Nothing was generated.");
    } finally {
      setBusy(false);
    }
  };

  const generate = async (stage: DraftStage) => {
    if (!stage.id) return;
    setBusy(true);
    setError(null);
    try {
      const result = await generateStageAction(eventId, stage.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPending(null);
      setNote(`${plural(result.data.created, "match", "matches")} generated`);
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was generated.");
    } finally {
      setBusy(false);
    }
  };

  const tooFew = teamCount < MIN_TEAMS;

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Where the team count comes from ------------------------ */}
      <Panel as="section" padding="none" className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>Teams</Eyebrow>
        <Badge tone={tooFew ? "ember" : "gold"}>
          {teamCount}/{MAX_TEAMS}
        </Badge>
        <span className="text-xs text-muted">
          {tooFew
            ? `A bracket needs at least ${MIN_TEAMS} teams. Add them on the Teams tab — every shape below is built from that number.`
            : "From the Teams tab. Every bracket below is built for exactly that many, byes included."}
        </span>
      </Panel>

      {stages.length === 0 ? (
        <Panel as="section" padding="none" className="space-y-4 border-t border-hair pt-12 first:border-t-0 first:pt-0">
          <Eyebrow>Stages</Eyebrow>
          <EmptyState>
            No stages yet. One is the usual answer — a round robin, or a bracket. Two makes
            a group stage that feeds a bracket, and so does a single “groups into a bracket”
            stage; the difference is whether you want to configure the two halves separately.
          </EmptyState>
          <AddStageRow disabled={stages.length >= maxStages} onAdd={add} />
        </Panel>
      ) : (
        <div className="space-y-6">
          {stages.map((stage, index) => (
            <StagePanel
              key={stage.key}
              stage={stage}
              index={index}
              count={stages.length}
              teams={teams}
              /* A later stage seeds from the one before it, which has not been
                 played — so its bracket shows "Seed 1", never a team name. */
              seeded={index === 0}
              impact={impacts?.find((row) => row.stageId === stage.id) ?? null}
              live={stage.id ? (format.stages.find((row) => row.id === stage.id) ?? null) : null}
              matchIds={matchIds}
              busy={busy}
              onPatch={(change) => patch(stage.key, change)}
              onConfig={(change) => setConfig(stage.key, change)}
              onMove={(direction) => move(index, direction)}
              onRemove={() => remove(stage.key)}
              onGenerate={() => void attemptGenerate(stage)}
            />
          ))}

          <Panel as="section" padding="none" className="border-t border-hair pt-12 first:border-t-0 first:pt-0">
            <AddStageRow disabled={stages.length >= maxStages} onAdd={add} />
          </Panel>
        </div>
      )}

      {dropping.length > 0 && (
        <Alert tone="gold">
          <span className="block font-medium">
            {plural(dropping.length, "stage")} will be deleted when you save
          </span>
          <span className="mt-1 block opacity-90">
            Nothing has gone yet. Saving asks what it costs first — a stage with a recorded
            result cannot be removed at all.
          </span>
        </Alert>
      )}

      <Panel as="section" padding="none" className="border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <SaveRow
          state={state}
          note={note}
          onSave={() => void attemptSave()}
          label="Save format"
        >
          <span className="text-xs text-muted">
            {stages.length}/{maxStages} stages · saving the format never touches a result.
            Generating the matches is the separate, destructive step.
          </span>
        </SaveRow>
      </Panel>

      {/* --- The confirm ------------------------------------------- */}
      <Modal
        open={pending !== null}
        onClose={() => {
          setPending(null);
          setState("dirty");
        }}
        size="sm"
        eyebrow="Before this is written"
        title={
          pending?.impact.blocked
            ? "That stage has results, so it cannot be rebuilt"
            : "This deletes the matches in that stage"
        }
        footer={
          <>
            <Button
              size="sm"
              onClick={() => {
                setPending(null);
                setState("dirty");
              }}
            >
              Leave it alone
            </Button>
            <Button
              size="sm"
              variant="ember"
              disabled={busy || state === "saving" || pending?.impact.blocked}
              onClick={() => {
                if (!pending) return;
                // Generating rebuilds one stage; saving rewrites the list. The
                // dialog is the same because the thing at risk is the same.
                void (pending.mode === "generate" ? generate(pending.stage) : commit());
              }}
            >
              {busy || state === "saving" ? "Working…" : "Delete them and continue"}
            </Button>
          </>
        }
      >
        {pending && <ImpactBody impact={pending.impact} />}
      </Modal>
    </div>
  );
}

function ImpactBody({ impact }: { impact: StageImpact }) {
  return (
    <>
      <Alert tone={impact.blocked ? "ember" : "gold"}>
        <span className="block font-medium">
          {plural(impact.matches, "match", "matches")} in “{impact.name}”
          {impact.playedGames > 0 && ` · ${plural(impact.playedGames, "game")} played`}
          {impact.scheduled > 0 && ` · ${plural(impact.scheduled, "start time")}`}
        </span>
        <span className="mt-1 block opacity-90">
          {impact.blocked
            ? "A stage with a played game, a recorded finish or a winner override is refused outright — rebuilding it would erase a completed result, which nothing on this site may do. Clear those results first."
            : "Nothing has been played, so nothing is lost but the schedule. The matches are rebuilt from the current settings."}
        </span>
      </Alert>

      {impact.draftedScores > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          {plural(impact.draftedScores, "score")} typed in but never ticked off. Those count
          for nothing anywhere, so they are not what is stopping this.
        </p>
      )}

      {impact.results.length > 0 && (
        <ul className="space-y-1 text-sm">
          {impact.results.map((row) => (
            <li key={row.slot} className="flex flex-wrap items-baseline gap-2">
              <Eyebrow as="span" className="text-muted">
                {row.label}
              </Eyebrow>
              <span className="num text-xs text-chalk/80">{row.line}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AddStageRow({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (kind: StageKind) => void;
}) {
  return (
    <div className="space-y-2">
      <Eyebrow>Add a stage</Eyebrow>
      <ChoiceRow>
        {STAGE_KIND_CHOICES.map((choice) => (
          <ChoiceChip key={choice.value} disabled={disabled} onClick={() => onAdd(choice.value)}>
            + {choice.label}
          </ChoiceChip>
        ))}
      </ChoiceRow>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One stage                                                          */
/* ------------------------------------------------------------------ */

function StagePanel({
  stage,
  index,
  count,
  teams,
  seeded,
  impact,
  live,
  matchIds,
  busy,
  onPatch,
  onConfig,
  onMove,
  onRemove,
  onGenerate,
}: {
  stage: DraftStage;
  index: number;
  count: number;
  teams: FormatView["teams"];
  seeded: boolean;
  impact: StageImpact | null;
  /** The stage as it currently stands in the database, when it exists. */
  live: FormatView["stages"][number] | null;
  matchIds: Record<string, string>;
  busy: boolean;
  onPatch: (change: Partial<DraftStage>) => void;
  onConfig: (change: Partial<StageConfig>) => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onGenerate: () => void;
}) {
  const [open, setOpen] = useState(true);

  // The whole point of the tab: the generator itself, called on what is typed.
  const spec = useMemo(
    () => generateStage(stage.kind, teams.length, stage.config),
    [stage.kind, stage.config, teams.length]
  );

  // Resolved with no results at all, so the canvas shows the shape and the
  // placeholders rather than a board. A stage after the first has no seeds yet.
  const preview = useMemo(
    () =>
      resolveMatches({
        stage: spec,
        matches: [],
        teams,
        seeds: seeded ? null : teams.map(() => null),
      }),
    [spec, teams, seeded]
  );

  // Rows, not resolved slots — see the note on the prop.
  const generated = live?.matches.filter((match) => matchIds[match.slot]).length ?? 0;
  const dirtyShape = live ? live.kind !== stage.kind : false;

  return (
    <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-end gap-3">
        <span className="num w-12 shrink-0 self-center text-xs text-muted">
          Stage {index + 1}
        </span>

        <Field
          label="Name"
          placeholder="Playoffs"
          value={stage.name}
          maxLength={60}
          wrapperClassName="min-w-[12rem] flex-[2]"
          onChange={(input) => onPatch({ name: input.target.value })}
        />

        <Select
          label="Format"
          value={stage.kind}
          wrapperClassName="min-w-[13rem] flex-[2]"
          onChange={(input) => onPatch({ kind: input.target.value as StageKind })}
        >
          {STAGE_KIND_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>

        <span className="flex shrink-0 items-center gap-1 self-center pt-5">
          <Button size="sm" aria-label="Move stage up" disabled={index === 0} onClick={() => onMove("up")}>
            ↑
          </Button>
          <Button
            size="sm"
            aria-label="Move stage down"
            disabled={index === count - 1}
            onClick={() => onMove("down")}
          >
            ↓
          </Button>
          <Button size="sm" variant="ember" aria-label="Remove stage" onClick={onRemove}>
            Remove
          </Button>
        </span>

        {stage.id === undefined && (
          <Badge tone="gold" className="self-center">
            New
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {formatSentence(spec).map((part) => (
          <Badge key={part}>{part}</Badge>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        {STAGE_KIND_CHOICES.find((choice) => choice.value === stage.kind)?.blurb}
        {dirtyShape && (
          <span className="ml-1 text-gold">
            Changing the shape of a stage with results is refused — nothing is lost until you
            save, and the confirm says what it would cost.
          </span>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-4">
        <Button size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide settings" : "Settings"}
        </Button>
        <Button
          size="sm"
          variant="gold"
          disabled={busy || !stage.id || teams.length < MIN_TEAMS}
          onClick={onGenerate}
        >
          {generated > 0 ? "Regenerate matches" : "Generate matches"}
        </Button>
        <span className="text-xs text-muted">
          {!stage.id
            ? "Save the format first — a stage has to exist before its matches can."
            : generated > 0
              ? `${plural(generated, "match", "matches")} in the database.` +
                (impact?.blocked ? " Results recorded — rebuilding is refused." : "")
              : `${plural(spec.matches.length, "match", "matches")} would be created.`}
        </span>
      </div>

      {open && (
        <StageSettings stage={stage} spec={spec} onConfig={onConfig} />
      )}

      <div className="space-y-4 border-t border-hair pt-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Preview</Eyebrow>
          <span className="eyebrow text-dim">
            {plural(spec.matches.length, "match", "matches")} ·{" "}
            {plural([...new Set(spec.matches.map((match) => match.phase))].length, "phase")}
          </span>
        </div>

        {spec.groups.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-2">
            {spec.groups.map((group) => (
              <div key={group.key} className="space-y-2">
                <Eyebrow>Group {group.key.toUpperCase()}</Eyebrow>
                <StandingsTable
                  rows={group.seeds.map((seed) => ({
                    id: `seed-${seed}`,
                    name: teams[seed - 1]?.name ?? `Seed ${seed}`,
                    group: group.key,
                    played: 0,
                    won: 0,
                    drawn: 0,
                    lost: 0,
                    gamesWon: 0,
                    gamesLost: 0,
                    scoreFor: 0,
                    scoreAgainst: 0,
                    diff: 0,
                    points: 0,
                  }))}
                  qualify={advancePerGroup(spec)}
                />
              </div>
            ))}
          </div>
        )}

        <BracketCanvas matches={preview} featuredSlot={spec.championSlot} compact />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* The settings for one stage                                         */
/* ------------------------------------------------------------------ */

function StageSettings({
  stage,
  spec,
  onConfig,
}: {
  stage: DraftStage;
  spec: GeneratedStage;
  onConfig: (change: Partial<StageConfig>) => void;
}) {
  const config = spec.config;
  const kind = stage.kind;
  const bracketKind: StageKind = kind === "group_playoff" ? config.playoffKind : kind;
  const halvesInUse = new Set(spec.matches.map((match) => match.bracket));
  const roundsInUse = [...new Set(spec.matches.map((match) => match.round))].sort((x, y) => x - y);
  const namedSlots = [spec.championSlot, spec.resetSlot].filter((slot): slot is string =>
    Boolean(slot)
  );
  const bronzeSlot = spec.matches.find((match) => match.bracket === "bronze")?.slot ?? null;
  if (bronzeSlot) namedSlots.push(bronzeSlot);

  return (
    <div className="space-y-6 border-t border-hair pt-5">
      {/* --- Series lengths ---------------------------------------- */}
      <section className="space-y-3">
        <Eyebrow>Series lengths</Eyebrow>
        <p className="text-xs leading-relaxed text-muted">
          The most specific setting wins: a named match beats a round number, which beats a
          half of the bracket, which beats the stage default. Round numbers restart in each
          half, so “round 1” means the upper bracket’s and the lower bracket’s alike — use the
          per-half row to tell them apart.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <SeriesSelect
            label="Stage default"
            value={config.bestOf}
            onChange={(value) => onConfig({ bestOf: value ?? 3 })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BRACKET_HALVES.filter((half) => halvesInUse.has(half.key)).map((half) => (
            <SeriesSelect
              key={half.key}
              label={half.label}
              value={config.bestOfByBracket[half.key] ?? null}
              inheritLabel={`Default · ${seriesLabel(config.bestOf)}`}
              onChange={(value) =>
                onConfig({ bestOfByBracket: withKey(config.bestOfByBracket, half.key, value) })
              }
            />
          ))}
        </div>

        {roundsInUse.length > 1 && (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {roundsInUse.map((round) => (
              <SeriesSelect
                key={round}
                label={`Round ${round}`}
                value={config.bestOfByRound[String(round)] ?? null}
                inheritLabel="Inherit"
                onChange={(value) =>
                  onConfig({ bestOfByRound: withKey(config.bestOfByRound, String(round), value) })
                }
              />
            ))}
          </div>
        )}

        {namedSlots.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {namedSlots.map((slot) => (
              <SeriesSelect
                key={slot}
                label={spec.bySlot[slot]?.label ?? slot}
                value={config.bestOfBySlot[slot] ?? null}
                inheritLabel="Inherit"
                onChange={(value) =>
                  onConfig({ bestOfBySlot: withKey(config.bestOfBySlot, slot, value) })
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* --- Maps and modes ---------------------------------------- */}
      <section className="space-y-3 border-t border-hair pt-5">
        <Eyebrow>Map and mode sequence</Eyebrow>
        <p className="text-xs leading-relaxed text-muted">
          One mode per game, in order. A mode is a plain name that belongs to the game rather
          than to this site, so anything typed here is a mode — “convoy”, “domination”,
          “escort”. The schedule reads its minutes from the Schedule tab, per mode.
        </p>

        {seriesLengthsInUse(spec).map((bestOf) => (
          <div key={bestOf} className="flex flex-wrap items-end gap-2">
            <Eyebrow as="span" className="w-12 shrink-0 self-center pt-5">
              {seriesLabel(bestOf)}
            </Eyebrow>
            {modesFor(config, bestOf).map((mode, index) => (
              <Field
                key={index}
                label={`Game ${index + 1}`}
                value={mode}
                maxLength={40}
                wrapperClassName="w-32"
                onChange={(input) => {
                  const next = modesFor(config, bestOf).slice();
                  next[index] = input.target.value;
                  onConfig({
                    modeSequence: { ...config.modeSequence, [String(bestOf)]: next },
                  });
                }}
              />
            ))}
          </div>
        ))}
      </section>

      {/* --- Bronze and the reset ---------------------------------- */}
      {(bracketKind === "single_elim" || bracketKind === "double_elim") && (
        <section className="space-y-3 border-t border-hair pt-5">
          <Eyebrow>Third place and the grand final</Eyebrow>

          <ChoiceRow>
            {BRONZE_CHOICES.map((choice) => (
              <ChoiceChip
                key={choice.value}
                selected={config.bronze === bronzeFor(bracketKind, choice.value)}
                onClick={() => onConfig({ bronze: choice.value })}
              >
                {choice.label}
              </ChoiceChip>
            ))}
          </ChoiceRow>
          <p className="text-xs leading-relaxed text-muted">
            {bracketKind === "single_elim"
              ? "A single elimination has no lower final, so “third place” can only be a separate match between the two beaten semi-finalists — and only when two semis were actually played."
              : "A double elimination already ranks everyone below the final, so the lower final’s loser takes bronze and third place costs no extra match."}
          </p>

          {bracketKind === "double_elim" && (
            <div className="space-y-2">
              <Eyebrow>Bracket reset</Eyebrow>
              <Toggle
                value={config.bracketReset}
                yesLabel="On"
                noLabel="Off"
                onChange={(value) => onConfig({ bracketReset: value === true })}
              />
              <p className="text-xs leading-relaxed text-muted">
                Off by default. With it on, a team that comes up from the lower bracket and
                wins the grand final has only levelled it — a second match decides. The
                schedule leaves room for it and finishes early when it is not needed.
              </p>
            </div>
          )}
        </section>
      )}

      {/* --- Groups ------------------------------------------------ */}
      {kind === "group_playoff" && (
        <section className="space-y-3 border-t border-hair pt-5">
          <Eyebrow>Groups</Eyebrow>
          <div className="grid gap-4 sm:grid-cols-3">
            <label>
              <span className="eyebrow mb-1 block">Groups</span>
              <Stepper
                value={config.groups}
                min={1}
                max={MAX_TEAMS}
                aria-label="Number of groups"
                onChange={(value) => onConfig({ groups: value ?? 2 })}
              />
            </label>
            <label>
              <span className="eyebrow mb-1 block">Through per group</span>
              <Stepper
                value={config.advancePerGroup}
                min={1}
                max={MAX_TEAMS}
                aria-label="How many advance per group"
                onChange={(value) => onConfig({ advancePerGroup: value ?? 2 })}
              />
            </label>
            <Select
              label="The qualifiers play"
              value={config.playoffKind}
              onChange={(input) =>
                onConfig({ playoffKind: input.target.value as EliminationKind })
              }
            >
              <option value="single_elim">Single elimination</option>
              <option value="double_elim">Double elimination</option>
            </Select>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            A group of one is a team with nothing to play, so the number of groups is capped
            at what the field can fill — {spec.groups.length} here — and you cannot advance
            more teams than the thinnest group holds, which is {advancePerGroup(spec)}.
          </p>
        </section>
      )}

      {/* --- Swiss ------------------------------------------------- */}
      {kind === "swiss" && (
        <section className="space-y-3 border-t border-hair pt-5">
          <Eyebrow>Swiss</Eyebrow>
          <label className="block max-w-xs">
            <span className="eyebrow mb-1 block">Rounds</span>
            <Stepper
              value={config.rounds}
              min={1}
              max={MAX_TEAMS * 2}
              aria-label="Swiss rounds"
              onChange={(value) => onConfig({ rounds: value ?? 3 })}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted">
            Only round one can be generated — every later pairing is a function of results
            that do not exist yet, and is created from the table once the round before it is
            in.
          </p>
        </section>
      )}

      {/* --- Table scoring ----------------------------------------- */}
      {halvesInUse.has("rr") && (
        <section className="space-y-4 border-t border-hair pt-5">
          <Eyebrow>Table scoring</Eyebrow>

          {kind !== "swiss" && (
            <div className="space-y-2">
              <Eyebrow className="text-dim">Play every pair twice</Eyebrow>
              <Toggle
                value={config.doubleRound}
                yesLabel="Home and away"
                noLabel="Once"
                onChange={(value) => onConfig({ doubleRound: value === true })}
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            {(["win", "draw", "loss"] as const).map((key) => (
              <label key={key}>
                <span className="eyebrow mb-1 block">Points for a {key}</span>
                <Stepper
                  value={config.points[key]}
                  min={0}
                  max={100}
                  aria-label={`Points for a ${key}`}
                  onChange={(value) =>
                    onConfig({ points: { ...config.points, [key]: value ?? 0 } })
                  }
                />
              </label>
            ))}
          </div>

          <TiebreakerEditor
            value={config.tiebreakers}
            onChange={(tiebreakers) => onConfig({ tiebreakers })}
          />
        </section>
      )}
    </div>
  );
}

/** Set or clear one entry of a by-key series map, without mutating it. */
function withKey(
  source: Record<string, SeriesLength>,
  key: string,
  value: SeriesLength | null
): Record<string, SeriesLength> {
  const next = { ...source };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

function SeriesSelect({
  label,
  value,
  inheritLabel,
  onChange,
}: {
  label: string;
  value: SeriesLength | null;
  /** Present makes the control clearable — absent, it is the stage default. */
  inheritLabel?: string;
  onChange: (value: SeriesLength | null) => void;
}) {
  return (
    <Select
      label={label}
      value={value === null ? "" : String(value)}
      wrapperClassName="min-w-[9rem] flex-1"
      onChange={(input) =>
        onChange(input.target.value === "" ? null : (Number(input.target.value) as SeriesLength))
      }
    >
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {SERIES_LENGTHS.map((length) => (
        <option key={length} value={length}>
          {seriesLabel(length)}
        </option>
      ))}
    </Select>
  );
}

/**
 * The tiebreak order, as a list you can move rather than a string to get right.
 *
 * `name` is the terminal rule that makes the sort total and the policy layer
 * appends it whatever the list says, so it is shown as a fixed tail rather than
 * offered as something to move or remove.
 */
function TiebreakerEditor({
  value,
  onChange,
}: {
  value: Tiebreaker[];
  onChange: (value: Tiebreaker[]) => void;
}) {
  const chosen = value.filter((rule) => rule !== "name");
  const spare = TIEBREAKERS.filter((rule) => rule !== "name" && !chosen.includes(rule));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= chosen.length) return;
    const next = [...chosen];
    [next[index], next[target]] = [next[target], next[index]];
    onChange([...next, "name"]);
  };

  return (
    <div className="space-y-2">
      <Eyebrow className="text-dim">Tiebreakers, in order</Eyebrow>

      <ol className="divide-y divide-hair/60 rounded-xl border border-hair">
        {chosen.map((rule, index) => (
          <li key={rule} className="flex items-center gap-2 px-3 py-2">
            <span className="num w-5 shrink-0 text-xs text-muted">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{tiebreakerLabel(rule)}</span>
            <Button size="sm" aria-label="Earlier" disabled={index === 0} onClick={() => move(index, -1)}>
              ↑
            </Button>
            <Button
              size="sm"
              aria-label="Later"
              disabled={index === chosen.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="ember"
              aria-label="Remove"
              onClick={() => onChange([...chosen.filter((entry) => entry !== rule), "name"])}
            >
              ✕
            </Button>
          </li>
        ))}
        <li className="flex items-center gap-2 px-3 py-2 text-muted">
          <span className="num w-5 shrink-0 text-xs">{chosen.length + 1}</span>
          <span className="min-w-0 flex-1 truncate text-sm">{tiebreakerLabel("name")}</span>
          <Badge>Always last</Badge>
        </li>
      </ol>

      {spare.length > 0 && (
        <ChoiceRow>
          {spare.map((rule) => (
            <ChoiceChip key={rule} onClick={() => onChange([...chosen, rule, "name"])}>
              + {tiebreakerLabel(rule)}
            </ChoiceChip>
          ))}
        </ChoiceRow>
      )}
    </div>
  );
}
