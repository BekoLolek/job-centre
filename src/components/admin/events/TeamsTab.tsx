"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Panel,
  Stepper,
  plural,
} from "@/components/ui";
import { Money, PlayerChip, playerName } from "@/components/draft";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import {
  type TeamFields,
  type TeamsImpact,
  previewTeamsAction,
  saveTeamsAction,
} from "@/app/admin/events/draft-actions";
import SaveRow, { type SaveState } from "./SaveRow";
import type { DraftTabData } from "./types";

/**
 * Teams — two to eight of them, named, seeded and funded.
 *
 * ## The minimum is not nagged about
 *
 * `setTeams` enforces the maximum of eight and deliberately does not enforce
 * the minimum of two, because an admin types the names one at a time and being
 * told "you need two teams" while typing the first one is the sort of
 * validation that makes people stop using a form. §9's minimum is a
 * publish-time question, so this screen says it once, quietly, in muted text —
 * never as an error and never on the Save button.
 *
 * ## Removing a team says what it costs first
 *
 * `setTeams` reports `removed` in its *result*, which is one moment too late
 * for a confirm dialog: by then the rosters are gone. So this asks first, the
 * way `DaysTab` does — `previewTeamsAction` counts the roster rows and the
 * money against the same reads the write uses, and the dialog names the players
 * who would lose their team. A team that has actually won lots is refused
 * outright by `setTeams`, and the dialog says so before the admin meets it as
 * an error.
 *
 * ## Balances follow the mode, and the mode lives on the Draft tab
 *
 * Under `uniform` every team starts on the event's default and `setTeams`
 * ignores any per-team figure sent to it. Rather than show an input whose value
 * is discarded, this shows the figure read-only and says where to change it. A
 * form that disagrees with the rule is worse than a form that omits it.
 */

type DraftTeam = {
  /** Stable across reorders, so React does not reuse a row's input state. */
  key: string;
  /** Present for a team that already exists. Its absence is what makes a delete. */
  id?: string;
  name: string;
  seed: number | null;
  balanceStart: number;
};

let counter = 0;
const nextKey = () => `new-${(counter += 1)}`;

export default function TeamsTab({
  eventId,
  data,
}: {
  eventId: string;
  data: DraftTabData;
}) {
  const router = useRouter();
  const { config, players } = data;
  const perTeam = config.balanceMode === "per_team";

  const [teams, setTeams] = useState<DraftTeam[]>(() =>
    data.teams.map((team) => ({
      key: team.id,
      id: team.id,
      name: team.name,
      seed: team.seed,
      balanceStart: team.balanceStart,
    }))
  );

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [impact, setImpact] = useState<TeamsImpact | null>(null);

  const touch = () => {
    setState("dirty");
    setError(null);
    setErrors({});
    setNote(null);
  };

  const existingById = new Map(data.teams.map((team) => [team.id, team]));
  const kept = new Set(teams.map((team) => team.id).filter(Boolean));
  const dropping = data.teams.filter((team) => !kept.has(team.id));

  const patch = (key: string, change: Partial<DraftTeam>) => {
    setTeams((current) =>
      current.map((team) => (team.key === key ? { ...team, ...change } : team))
    );
    touch();
  };

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= teams.length) return;
    setTeams((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  const add = () => {
    if (teams.length >= MAX_TEAMS) return;
    setTeams((current) => [
      ...current,
      {
        key: nextKey(),
        /*
         * A placeholder, not a blank. `setTeams` refuses an unnamed team, and
         * this is the name the captain replaces: assign somebody to lead this
         * team and "Team 3" becomes "Team Bob", because that is what everyone
         * in the Discord will call them anyway. Type over it and it stays.
         */
        name: `Team ${current.length + 1}`,
        seed: current.length + 1,
        balanceStart: config.defaultBalance,
      },
    ]);
    touch();
  };

  const remove = (key: string) => {
    setTeams((current) => current.filter((team) => team.key !== key));
    touch();
  };

  /** Seeds straight down the list — the common case, one click instead of eight. */
  const seedByOrder = () => {
    setTeams((current) => current.map((team, index) => ({ ...team, seed: index + 1 })));
    touch();
  };

  const fields = (): TeamFields[] =>
    teams.map((team) => ({
      id: team.id,
      name: team.name.trim(),
      seed: team.seed,
      balanceStart: perTeam ? team.balanceStart : config.defaultBalance,
    }));

  /** Ask what this would cost. Only writes once the answer has been read. */
  const attemptSave = async () => {
    setState("saving");
    setError(null);
    setErrors({});
    try {
      const preview = await previewTeamsAction(eventId, fields());
      if (preview.removed.length > 0) {
        setImpact(preview);
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
      const result = await saveTeamsAction(eventId, fields());
      if (!result.ok) {
        setError(result.error);
        setErrors(result.errors ?? {});
        setState("error");
        return;
      }
      setImpact(null);
      // Adopt the ids the server just wrote. Without this the tab still thinks
      // every team is new, so the next save would delete these rows — and the
      // rosters, balances and prices with them.
      setTeams(
        result.data.teams.map((team) => ({
          key: team.id,
          id: team.id,
          name: team.name,
          seed: team.seed,
          balanceStart: team.balanceStart,
        }))
      );
      setNote(
        result.data.removed > 0 ? `Saved · ${plural(result.data.removed, "team")} removed` : null
      );
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const named = teams.filter((team) => team.name.trim().length > 0).length;

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Teams</Eyebrow>
          <Badge tone={teams.length > MAX_TEAMS ? "ember" : "default"}>
            {teams.length}/{MAX_TEAMS}
          </Badge>
          {perTeam ? (
            <span className="eyebrow text-dim">Per-team balances</span>
          ) : (
            <span className="eyebrow text-dim">
              Uniform balances · everyone starts on{" "}
              <Money value={config.defaultBalance} size="sm" />
            </span>
          )}
        </div>

        {teams.length === 0 ? (
          <EmptyState>
            No teams yet. Add between {MIN_TEAMS} and {MAX_TEAMS} of them — the draft, the
            bracket and the schedule all count from here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hair/60 rounded-xl border border-hair">
            {teams.map((team, index) => {
              const existing = team.id ? existingById.get(team.id) : undefined;
              const problem = errors[team.id ?? `new-${index}`];

              return (
                <li key={team.key} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <span className="num w-10 shrink-0 self-center text-xs text-muted">
                      #{index + 1}
                    </span>

                    <Field
                      label="Team name"
                      placeholder="Rivals Red"
                      value={team.name}
                      maxLength={60}
                      error={problem}
                      wrapperClassName="min-w-[12rem] flex-[2]"
                      onChange={(input) => patch(team.key, { name: input.target.value })}
                    />

                    <label className="min-w-[9rem] flex-1">
                      <span className="eyebrow mb-1 block">Seed</span>
                      <Stepper
                        value={team.seed}
                        min={1}
                        max={MAX_TEAMS}
                        aria-label={`Seed for team ${index + 1}`}
                        onChange={(value) => patch(team.key, { seed: value })}
                      />
                    </label>

                    {perTeam ? (
                      <label className="min-w-[11rem] flex-1">
                        <span className="eyebrow mb-1 block">Starting balance</span>
                        <Stepper
                          value={team.balanceStart}
                          min={0}
                          max={1_000_000}
                          step={50}
                          aria-label={`Starting balance for team ${index + 1}`}
                          onChange={(value) =>
                            patch(team.key, { balanceStart: value ?? 0 })
                          }
                        />
                      </label>
                    ) : (
                      <span className="min-w-[7rem] flex-1 self-center pt-5">
                        <Eyebrow className="mb-0.5">Starts on</Eyebrow>
                        <Money value={config.defaultBalance} size="lg" />
                      </span>
                    )}

                    <span className="flex shrink-0 items-center gap-1 self-center pt-5">
                      <Button
                        size="sm"
                        aria-label={`Move team ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => move(index, "up")}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Move team ${index + 1} down`}
                        disabled={index === teams.length - 1}
                        onClick={() => move(index, "down")}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ember"
                        aria-label={`Remove team ${index + 1}`}
                        onClick={() => remove(team.key)}
                      >
                        Remove
                      </Button>
                    </span>

                    {team.id === undefined && (
                      <Badge tone="gold" className="self-center">
                        New
                      </Badge>
                    )}
                  </div>

                  {existing && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-10 text-xs text-muted">
                      <span className="num">
                        {existing.roster.size}/{existing.roster.target} on the roster
                      </span>
                      <span>
                        {existing.captainUserId ? (
                          <>Captain {playerName(players, existing.captainUserId)}</>
                        ) : (
                          <span className="text-gold/80">No captain yet</span>
                        )}
                      </span>
                      {existing.balance !== existing.balanceStart && (
                        <span className="flex items-baseline gap-1">
                          <Money value={existing.balance} size="sm" /> left
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {dropping.length > 0 && (
          <Alert tone="gold">
            <span className="block font-medium">
              {plural(dropping.length, "team")} will be removed when you save
            </span>
            <span className="mt-1 block opacity-90">
              Nothing has gone yet. Saving asks what it costs first, and names anybody who
              would lose their team.
            </span>
          </Alert>
        )}

        {named > 0 && named < MIN_TEAMS && (
          <p className="text-xs text-muted">
            A draft needs {MIN_TEAMS} teams to run. That is a publish-time question, not
            something to fix mid-sentence — carry on naming them.
          </p>
        )}

        <SaveRow
          state={state}
          note={note}
          onSave={() => void attemptSave()}
          label="Save teams"
        >
          <Button size="sm" disabled={teams.length >= MAX_TEAMS} onClick={add}>
            + Add a team
          </Button>
          <Button size="sm" disabled={teams.length === 0} onClick={seedByOrder}>
            Seed by list order
          </Button>
          <span className="text-xs text-muted">
            Reordering keeps every roster — a team carries its identity with it.
          </span>
        </SaveRow>
      </Panel>

      {/* --- The confirm ------------------------------------------- */}
      <Modal
        open={impact !== null}
        onClose={() => {
          setImpact(null);
          setState("dirty");
        }}
        size="sm"
        eyebrow="Before this is saved"
        title={
          impact?.anyBlocked ? "One of those teams cannot be removed" : "This empties rosters"
        }
        footer={
          <>
            <Button
              size="sm"
              onClick={() => {
                setImpact(null);
                setState("dirty");
              }}
            >
              Leave them alone
            </Button>
            <Button
              size="sm"
              variant="ember"
              disabled={state === "saving" || impact?.anyBlocked}
              onClick={() => void commit()}
            >
              {state === "saving" ? "Saving…" : "Remove and save"}
            </Button>
          </>
        }
      >
        {impact && (
          <>
            {impact.anyBlocked ? (
              <Alert tone="ember">
                <span className="block font-medium">
                  {impact.removed
                    .filter((team) => team.blocked)
                    .map((team) => team.name)
                    .join(", ")}{" "}
                  {impact.removed.filter((team) => team.blocked).length === 1
                    ? "has"
                    : "have"}{" "}
                  already drafted players
                </span>
                <span className="mt-1 block opacity-90">
                  Removing the team would erase what they paid, so it is refused. Void those
                  lots in the draft room first, then come back.
                </span>
              </Alert>
            ) : (
              <Alert tone="ember">
                <span className="block font-medium">
                  {plural(impact.clearedMembers, "roster place")} across{" "}
                  {plural(impact.removed.length, "team")}
                </span>
                <span className="mt-1 block opacity-90">
                  The people below go back to being accepted applicants with no team.
                  Nothing has been changed yet.
                </span>
              </Alert>
            )}

            <ul className="space-y-3">
              {impact.removed.map((team) => (
                <li key={team.id} className="rounded-xl border border-hair p-3">
                  <div className="mb-1 flex flex-wrap items-baseline gap-2">
                    <span className="font-display text-base">{team.name}</span>
                    {team.blocked && <Badge tone="ember">Refused</Badge>}
                    {team.spent > 0 && (
                      <span className="flex items-baseline gap-1 text-xs text-muted">
                        <Money value={team.spent} size="sm" /> spent
                      </span>
                    )}
                  </div>

                  {team.memberUserIds.length === 0 ? (
                    <EmptyState size="sm">Nobody on it — removing it costs nothing.</EmptyState>
                  ) : (
                    <ul>
                      {team.memberUserIds.map((userId) => (
                        <li key={userId}>
                          <PlayerChip
                            name={playerName(players, userId)}
                            meta={userId === team.captainUserId ? "Captain" : undefined}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </div>
  );
}
