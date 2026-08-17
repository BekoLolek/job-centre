"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Modal,
  Panel,
  Select,
  StatTile,
  cx,
  plural,
} from "@/components/ui";
import { RosterList, TeamCard } from "@/components/draft";
import type { ApplicantView, EventDetail } from "@/lib/events";
import { saveCaptainsAction } from "@/app/admin/events/draft-actions";
import SaveRow, { type SaveState } from "./SaveRow";
import type { DraftTabData } from "./types";

/**
 * Captains — one per team, chosen from the people who are actually in the event.
 *
 * ## The settled rule, said out loud
 *
 * §13's second open question is answered and §14 records the answer: **a
 * captain occupies a roster slot and never enters the draft pool.** That is not
 * folklore to be rediscovered by whoever notices the pool is one short — it
 * changes every number on the Draft tab, so this screen states it in figures
 * ("roster target 6, so each captain leaves 5 to draft") and shows the captain
 * sitting on the roster the moment they are chosen.
 *
 * ## The rank gate is guidance, and the override is deliberate
 *
 * `getApplicationsForEvent` already answers "does this person clear
 * `minRankToCaptain`" per applicant, and that answer is shown rather than
 * recomputed — a second implementation of the gate is a second implementation
 * that will one day disagree with the one the member saw on the apply page.
 *
 * §8.3 is explicit that a gate is guidance rather than a wall: sometimes you
 * want the Gold player who is filling in for a mate. So somebody below the bar
 * can be made captain, but not by accident — the save stops and names them, and
 * the admin has to say yes to the specific people.
 *
 * The one thing that genuinely *is* a wall is acceptance. `setCaptains` refuses
 * anybody who is not an accepted applicant, and it is right to: the override
 * for that lives on the Applicants tab, where accepting somebody unusual is
 * recorded as a decision rather than smuggled in as a captaincy.
 */

export default function CaptainsTab({
  eventId,
  event,
  applicants,
  data,
}: {
  eventId: string;
  event: EventDetail;
  applicants: ApplicantView[];
  data: DraftTabData;
}) {
  const router = useRouter();
  const { players, config } = data;

  const accepted = applicants.filter((row) => row.status === "accepted");

  const [picks, setPicks] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(data.teams.map((team) => [team.id, team.captainUserId]))
  );
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [override, setOverride] = useState<ApplicantView[] | null>(null);

  const nameOf = (row: ApplicantView) =>
    row.member.displayName ?? row.member.discordId ?? "Unknown member";

  const applicantOf = (userId: string | null): ApplicantView | null =>
    userId === null ? null : (accepted.find((row) => row.member.id === userId) ?? null);

  const choose = (teamId: string, userId: string | null) => {
    setPicks((current) => ({ ...current, [teamId]: userId }));
    setState("dirty");
    setError(null);
    setErrors({});
    setNote(null);
  };

  /** Who a given team may still pick: nobody another team has already claimed. */
  const availableTo = (teamId: string): ApplicantView[] => {
    const taken = new Set(
      Object.entries(picks)
        .filter(([id, userId]) => id !== teamId && userId !== null)
        .map(([, userId]) => userId as string)
    );
    return accepted.filter((row) => !taken.has(row.member.id));
  };

  const chosen = Object.values(picks).filter((userId) => userId !== null).length;
  const ineligible = Object.values(picks)
    .map(applicantOf)
    .filter((row): row is ApplicantView => row !== null && !row.eligibility.canCaptain);

  const attemptSave = () => {
    if (ineligible.length > 0) {
      setOverride(ineligible);
      return;
    }
    void commit();
  };

  const commit = async () => {
    setOverride(null);
    setState("saving");
    setError(null);
    setErrors({});
    try {
      const result = await saveCaptainsAction(
        eventId,
        data.teams.map((team) => ({ teamId: team.id, userId: picks[team.id] ?? null }))
      );
      if (!result.ok) {
        setError(result.error);
        setErrors(result.errors ?? {});
        setState("error");
        return;
      }
      setPicks(
        Object.fromEntries(result.data.captains.map((row) => [row.teamId, row.userId]))
      );
      setNote(`Saved · ${plural(chosen, "captain")}`);
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- The rule that changes every other number --------------- */}
      <Panel as="section" className="space-y-3">
        <Eyebrow>A captain fills a roster slot</Eyebrow>
        <p className="text-sm leading-relaxed">
          A captain is on their team from the moment you choose them — a roster row costing{" "}
          <span className="num text-gold">0</span> — and they{" "}
          <span className="text-chalk">never enter the draft pool</span>. With a roster target
          of <span className="num text-gold">{config.rosterTarget}</span>, each team drafts{" "}
          <span className="num text-gold">{Math.max(0, config.rosterTarget - 1)}</span> more
          {config.rosterTarget - 1 === 1 ? " player" : " players"}.
        </p>
        <p className="text-xs text-muted">
          Settled in plan §13 and recorded in §14. Choosing a captain takes them out of the
          pool automatically; clearing one puts the slot back but does not put them back in
          the pool — reseed it on the Draft tab.
        </p>

        <div className="flex flex-wrap gap-8 border-t border-hair pt-4">
          <StatTile
            label="Captains chosen"
            value={`${chosen}/${data.teams.length}`}
            valueClassName={
              data.teams.length > 0 && chosen === data.teams.length ? "text-signal" : "text-gold"
            }
          />
          <StatTile label="Accepted applicants" value={accepted.length} />
          <StatTile
            label="Clear the captain bar"
            value={accepted.filter((row) => row.eligibility.canCaptain).length}
            valueClassName="text-muted"
          />
          <StatTile
            label="Left to draft"
            value={Math.max(0, accepted.length - chosen)}
            valueClassName="text-muted"
          />
          {event.minRankToCaptain && (
            <StatTile
              label="Minimum to captain"
              value={event.minRankToCaptain}
              valueClassName="text-muted"
            />
          )}
        </div>
      </Panel>

      {data.teams.length === 0 ? (
        <Panel>
          <EmptyState>
            No teams yet. Add them on the Teams tab and they appear here waiting for a
            captain.
          </EmptyState>
        </Panel>
      ) : accepted.length === 0 ? (
        <Panel>
          <EmptyState>
            Nobody has been accepted into this event yet. A captain has to be an accepted
            applicant — accept somebody on the Applicants tab and they show up here.
          </EmptyState>
        </Panel>
      ) : (
        <Panel as="section" className="space-y-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <Eyebrow>One captain per team</Eyebrow>
            <span className="eyebrow text-muted/70">
              Accepted applicants only · {plural(accepted.length, "person", "people")}
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {data.teams.map((team) => {
              const pick = picks[team.id] ?? null;
              const row = applicantOf(pick);
              const problem = errors[team.id];
              const options = availableTo(team.id);

              // The saved captain is shown on the roster; a pending choice is
              // not on it yet, so the card gets the roster it actually has and
              // the pending pick is stated separately rather than faked in.
              const pending = pick !== team.captainUserId;

              return (
                <TeamCard
                  key={team.id}
                  team={team}
                  players={players}
                  warnNoCaptain
                  active={pending}
                  footer={
                    <div className="w-full space-y-2">
                      <Select
                        label="Captain"
                        value={pick ?? ""}
                        error={problem}
                        onChange={(input) =>
                          choose(team.id, input.target.value === "" ? null : input.target.value)
                        }
                      >
                        <option value="">— nobody yet —</option>
                        {options.map((option) => (
                          <option key={option.id} value={option.member.id}>
                            {nameOf(option)}
                            {option.rank ? ` · ${option.rank}` : " · no rank recorded"}
                            {option.eligibility.canCaptain ? "" : " · below the bar"}
                          </option>
                        ))}
                      </Select>

                      {row && (
                        <p
                          className={cx(
                            "text-xs leading-relaxed",
                            row.eligibility.canCaptain ? "text-muted" : "text-gold"
                          )}
                        >
                          {row.eligibility.captainReason}
                        </p>
                      )}

                      {pending && (
                        <p className="eyebrow text-gold">
                          {pick === null ? "Captaincy cleared" : "Not saved yet"}
                        </p>
                      )}

                      {pending && pick !== null && (
                        <div className="border-t border-hair/60 pt-2">
                          <Eyebrow className="mb-1">Roster once saved</Eyebrow>
                          <RosterList
                            members={[
                              { teamId: team.id, userId: pick, price: 0, isCaptain: true },
                              ...team.members.filter((member) => !member.isCaptain),
                            ]}
                            players={{
                              ...players,
                              [pick]: { displayName: row ? nameOf(row) : "Unknown player" },
                            }}
                            target={config.rosterTarget}
                          />
                        </div>
                      )}
                    </div>
                  }
                >
                  {!pending && (
                    <div className="border-t border-hair/60 pt-2">
                      <Eyebrow className="mb-1">Roster</Eyebrow>
                      <RosterList
                        members={team.members}
                        players={players}
                        target={config.rosterTarget}
                        emptyMessage="Nobody yet — the captain will be the first row."
                      />
                    </div>
                  )}
                </TeamCard>
              );
            })}
          </div>

          <SaveRow
            state={state}
            note={note}
            onSave={attemptSave}
            label="Save captains"
          >
            <span className="text-xs text-muted">
              Saved in one write, so two captains can swap teams without either blocking the
              other.
            </span>
          </SaveRow>
        </Panel>
      )}

      {/* --- Who is not on offer, and why -------------------------- */}
      {applicants.length > accepted.length && (
        <Panel as="section" className="space-y-2">
          <Eyebrow>Not on the list</Eyebrow>
          <p className="text-sm text-muted">
            {plural(applicants.length - accepted.length, "applicant")} cannot be picked here
            because they have not been accepted. That gate is not overridable from this tab
            on purpose — accept them on the{" "}
            <span className="text-chalk">Applicants</span> tab and the decision is recorded
            where it belongs.
          </p>
        </Panel>
      )}

      {/* --- The deliberate override -------------------------------- */}
      <Modal
        open={override !== null}
        onClose={() => setOverride(null)}
        size="sm"
        eyebrow="§8.3 — the gate is guidance"
        title={
          override && override.length === 1
            ? "That captain is below the bar"
            : "Those captains are below the bar"
        }
        footer={
          <>
            <Button size="sm" onClick={() => setOverride(null)}>
              Pick somebody else
            </Button>
            <Button
              size="sm"
              variant="gold"
              disabled={state === "saving"}
              onClick={() => void commit()}
            >
              {state === "saving" ? "Saving…" : "Yes, they captain anyway"}
            </Button>
          </>
        }
      >
        {override && (
          <>
            <Alert tone="gold">
              This event asks for {event.minRankToCaptain ?? "a minimum rank"} to captain.
              Nothing stops you — sometimes you want the Gold player who is filling in for a
              mate — but it should be a decision, not a mis-click.
            </Alert>

            <ul className="space-y-2">
              {override.map((row) => (
                <li key={row.id} className="border border-hair p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm text-chalk">{nameOf(row)}</span>
                    <Badge>{row.rank ?? "No rank recorded"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-gold/90">{row.eligibility.captainReason}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </div>
  );
}
