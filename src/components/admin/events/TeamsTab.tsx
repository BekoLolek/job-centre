"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
  plural,
} from "@/components/ui";
import { Money, PlayerChip, playerName } from "@/components/draft";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import { NIGHT_FORMATS, type NightFormat, teamFormatFrom } from "@/lib/events-policy";
// The pure half, for the reason `EventEditor` imports `admin-templates-policy`
// rather than `admin-templates`: `planTeams` is arithmetic over two numbers and
// carries no database handle, so the screen can answer UC-41 4 — how many teams
// and which are short — without a round trip, using the *same* function the
// write uses. A second copy here is how a screen and its server start
// disagreeing about what is about to be saved.
import { planTeams } from "@/lib/random-teams";
import {
  type RosterMove,
  type TeamFields,
  type TeamsImpact,
  placeOnRosterAction,
  previewTeamCountAction,
  previewTeamsAction,
  randomiseTeamsAction,
  removeFromRosterAction,
  saveNightFormatAction,
  saveTeamsAction,
  setTeamCountAction,
} from "@/app/admin/events/draft-actions";
import SaveRow, { type SaveState } from "./SaveRow";
import type { DraftTabData } from "./types";

/**
 * Teams — two to eight of them, named, seeded, funded and filled (UC-15).
 *
 * ## The count is one control and one action
 *
 * UC-15 1 is "the manager sets the number of teams", and that is now what the
 * screen asks: a figure between two and eight, and a button that writes it.
 * It used to be "+ Add a team" eight times, each click inventing a row that the
 * list save then posted — and the invented rows carried invented *names*, which
 * is how a placeholder reached `setTeams` looking exactly like something
 * somebody had typed. `setTeamCount` writes the placeholders itself and records
 * them as placeholders, so the name box below is now unambiguously the manager
 * talking: type over "Team 3" and it is yours for good (UC-15 4a).
 *
 * The minimum is enforced on the count, and only there. `setTeams` still does
 * not nag about it while names are being typed one at a time, for the reason
 * its docblock gives; a count is a single number chosen in full, so "between
 * two and eight" is answerable the moment it is submitted.
 *
 * ## Lowering it says what it costs first
 *
 * Both writes ask before they clear anything — `previewTeamCountAction` for the
 * count and `previewTeamsAction` for the list — because `setTeams` reports
 * `removed` in its *result*, which is one moment too late for a confirm dialog
 * (R-161 / UC-15 E1). A team that has actually won lots is refused outright,
 * and the dialog says so before the admin meets it as an error.
 *
 * ## Rosters are moved one player at a time, and only accepted ones
 *
 * UC-15 5 is the manager placing the remaining players by hand, so each move is
 * its own write rather than a pending edit on a Save button: a roster is shared
 * ground — the draft writes it, the captains write it — and a screenful of
 * staged moves posted at once would be a screenful of decisions taken against
 * a roster that has since changed. `placeOnRoster` hands back every roster as
 * it now stands and the tab adopts it, the same way the team list adopts the
 * ids it is given.
 *
 * Only accepted applicants are offered, because only accepted applicants may be
 * placed: a waitlisted member on a roster is a seat given away by the back
 * door. The server holds that rule — it is re-read inside the write — and this
 * screen does not offer what the server would refuse.
 *
 * ## Balances follow the mode, and the mode lives on the Draft tab
 *
 * Under `uniform` every team starts on the event's default and `setTeams`
 * ignores any per-team figure sent to it. Rather than show an input whose value
 * is discarded, this shows the figure read-only and says where to change it. A
 * form that disagrees with the rule is worse than a form that omits it.
 *
 * ## The format and the shuffle sit above all of it (UC-41)
 *
 * R-215's 6v6 or 3v3 is the first decision about teams, because it is what
 * sizes them, so it is the first panel. It is the **admin's** choice stored on
 * the event, not arithmetic over the head count — `teamFormatFrom` has the
 * reasoning — and the comp it implies is *printed and never enforced*: nothing
 * on this screen or behind it assigns a role or refuses a team for its
 * composition (UC-41 2).
 *
 * "Make random teams" (R-216) is the alternative to naming teams by hand, and
 * three things about it are rules rather than polish. It **says what it will
 * do before it does it** — how many teams, which come out short, how many
 * existing teams get discarded (UC-41 3a, 4a) — using the same `planTeams`
 * the server uses, so the dialog and the write cannot disagree. It is
 * **refused outright once a lot has been awarded** (3b) rather than offered
 * and then rejected, which is why `data.started` disables the button *and*
 * explains itself. And **re-running is expected** (5a): the dialog is what
 * stops a reshuffle being an accident, not a limit on how many are allowed.
 *
 * The button is also disabled while the format chip differs from what is
 * stored. The write reads the stored format, so shuffling on an unsaved chip
 * would make teams of a size the admin had not saved.
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

/* ------------------------------------------------------------------ */
/* What the screen may offer                                          */
/* ------------------------------------------------------------------ */

/**
 * The accepted applicants who are on no roster — everybody UC-15 5 is about.
 *
 * Two filters, and both of them are rules rather than tidiness. **Accepted**,
 * because `placeOnRoster` refuses anybody else and a chip that produces a
 * refusal is worse than no chip. **Not already placed**, because somebody on a
 * roster is moved from where they are, not placed again — offering them twice
 * is how a screen ends up asking the server to put one person on two teams.
 *
 * Application order, which is the order the Applicants tab shows.
 */
export function unplacedAccepted(
  applicants: readonly ApplicantView[],
  rosters: readonly RosterMove[]
): string[] {
  const placed = new Set(rosters.map((row) => row.userId));
  return applicants
    .filter((row) => row.status === "accepted" && !placed.has(row.member.id))
    .map((row) => row.member.id);
}

/**
 * The teams a player may be put on: not the one they are already on, and not
 * one whose roster is full.
 *
 * A full roster is `rosterTarget` including the captain (§14), which is the
 * same count `placeOnRoster` refuses on. The team they are on is left out
 * because "move to where you are" is not a move — the server treats it as a
 * no-op rather than an error, and an option that does nothing still should not
 * be in the list.
 */
export function teamsOpenTo(
  teams: readonly { id: string; name: string }[],
  rosters: readonly RosterMove[],
  target: number,
  userId: string
): { id: string; name: string }[] {
  const on = rosters.find((row) => row.userId === userId)?.teamId ?? null;
  return teams.filter(
    (team) =>
      team.id !== on &&
      rosters.filter((row) => row.teamId === team.id).length < target
  );
}

/**
 * How many people the shuffle has to work with — UC-41's "accepted
 * participants", counted the same way the server counts them.
 *
 * `assignRandomTeams` reads `applications.status = 'accepted'`, so this counts
 * exactly that and nothing else. A screen that counted everybody on the
 * Applicants tab would promise teams for people who are on the waitlist, and
 * the refusal the admin then met would name a different number from the one
 * they had just read.
 */
export function acceptedCount(applicants: readonly ApplicantView[]): number {
  return applicants.filter((row) => row.status === "accepted").length;
}

let counter = 0;
const nextKey = () => `new-${(counter += 1)}`;

export default function TeamsTab({
  eventId,
  applicants,
  data,
}: {
  eventId: string;
  applicants: ApplicantView[];
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

  /* --- The count ------------------------------------------------- */

  const [count, setCount] = useState<number | null>(data.teams.length || MIN_TEAMS);
  const [countBusy, setCountBusy] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  /** The figure the pending confirm would write. Null when none is pending. */
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  /* --- The night's format, and the shuffle (UC-41) ---------------- */

  const [format, setFormat] = useState<NightFormat>(data.teamFormat.format);
  const [formatBusy, setFormatBusy] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const [shuffleBusy, setShuffleBusy] = useState(false);
  const [shuffleError, setShuffleError] = useState<string | null>(null);
  const [shuffleNote, setShuffleNote] = useState<string | null>(null);
  /** True while the confirm for UC-41 3a / 4a is open. */
  const [shuffleAsking, setShuffleAsking] = useState(false);

  /* --- The rosters ----------------------------------------------- */

  const [rosters, setRosters] = useState<RosterMove[]>(() =>
    data.teams.flatMap((team) => team.members.map((member) => ({ ...member })))
  );
  const [moving, setMoving] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

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

  /** Adopt what the server wrote — ids, names and rosters alike. */
  const adopt = (written: Array<TeamFields & { id: string }>) => {
    setTeams(
      written.map((team) => ({
        key: team.id,
        id: team.id,
        name: team.name,
        seed: team.seed,
        balanceStart: team.balanceStart,
      }))
    );
    setCount(written.length);
  };

  /* --- Writing the count ----------------------------------------- */

  const attemptCount = async () => {
    if (count === null) return;
    setCountBusy(true);
    setCountError(null);
    try {
      if (count < teams.length) {
        const preview = await previewTeamCountAction(eventId, count);
        if (preview.removed.length > 0) {
          setImpact(preview);
          setPendingCount(count);
          return;
        }
      }
      await commitCount(count);
    } catch {
      setCountError("Could not reach the server. Nothing was saved.");
    } finally {
      setCountBusy(false);
    }
  };

  const commitCount = async (wanted: number) => {
    setCountBusy(true);
    setCountError(null);
    try {
      const result = await setTeamCountAction(eventId, wanted);
      if (!result.ok) {
        setCountError(result.error);
        return;
      }
      setImpact(null);
      setPendingCount(null);
      adopt(result.data.teams);
      // A removal takes rosters with it, so the local copy is stale the moment
      // it lands. The teams that remain carry theirs; the rest are gone.
      const alive = new Set(result.data.teams.map((team) => team.id));
      setRosters((current) => current.filter((row) => alive.has(row.teamId)));
      setState("idle");
      setNote(null);
      router.refresh();
    } catch {
      setCountError("Could not reach the server. Nothing was saved.");
    } finally {
      setCountBusy(false);
    }
  };

  /* --- Writing the format, and the shuffle (UC-41) --------------- */

  const saveFormat = async () => {
    setFormatBusy(true);
    setFormatError(null);
    setFormatNote(null);
    try {
      const result = await saveNightFormatAction(eventId, format);
      if (!result.ok) {
        setFormatError(result.error);
        return;
      }
      // Adopt what was *stored*, not what was clicked — the same rule the
      // schedule settings follow.
      setFormat(result.data.teamFormat.format);
      setFormatNote(`Saved · ${result.data.teamFormat.format}`);
      router.refresh();
    } catch {
      setFormatError("Could not reach the server. Nothing was saved.");
    } finally {
      setFormatBusy(false);
    }
  };

  /**
   * Shuffle for real. Only ever reached from the confirm dialog, which is
   * UC-41 3a's "say so explicitly" and 5a's guard against an accident.
   */
  const commitShuffle = async () => {
    setShuffleBusy(true);
    setShuffleError(null);
    try {
      const result = await randomiseTeamsAction(eventId, true);
      if (!result.ok) {
        setShuffleError(result.error);
        setShuffleAsking(false);
        return;
      }
      setShuffleAsking(false);
      adopt(result.data.teams);
      setRosters(result.data.rosters);
      setShuffleNote(
        `Shuffled into ${plural(result.data.teams.length, "team")}${
          result.data.short.length > 0
            ? ` · ${plural(result.data.short.length, "team")} short of ${data.teamFormat.teamSize}`
            : ""
        }`
      );
      setState("idle");
      setNote(null);
      router.refresh();
    } catch {
      setShuffleError("Could not reach the server. Nothing was saved.");
    } finally {
      setShuffleBusy(false);
    }
  };

  /* --- Writing the list ------------------------------------------ */

  /** Ask what this would cost. Only writes once the answer has been read. */
  const attemptSave = async () => {
    setState("saving");
    setError(null);
    setErrors({});
    try {
      const preview = await previewTeamsAction(eventId, fields());
      if (preview.removed.length > 0) {
        setImpact(preview);
        setPendingCount(null);
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
      adopt(result.data.teams);
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

  /* --- Writing a roster ------------------------------------------ */

  const place = async (userId: string, teamId: string) => {
    setMoving(userId);
    setRosterError(null);
    try {
      const result = await placeOnRosterAction(teamId, userId);
      if (!result.ok) {
        setRosterError(result.error);
        return;
      }
      setRosters(result.data.rosters);
      router.refresh();
    } catch {
      setRosterError("Could not reach the server. Nothing was saved.");
    } finally {
      setMoving(null);
    }
  };

  const unplace = async (userId: string, teamId: string) => {
    setMoving(userId);
    setRosterError(null);
    try {
      const result = await removeFromRosterAction(teamId, userId);
      if (!result.ok) {
        setRosterError(result.error);
        return;
      }
      setRosters(result.data.rosters);
      router.refresh();
    } catch {
      setRosterError("Could not reach the server. Nothing was saved.");
    } finally {
      setMoving(null);
    }
  };

  const named = teams.filter((team) => team.name.trim().length > 0).length;
  const placeable = unplacedAccepted(applicants, rosters);

  /*
   * UC-41 4, worked out with the same function the write uses.
   *
   * **Sized from the stored format, and from nothing else.** That is what
   * `assignRandomTeams` reads, so a plan drawn from the chip the admin has
   * clicked but not saved would promise teams of three and then save teams of
   * six. There is deliberately no second size in scope for this to be
   * confused with: the comp each format implies is printed on the chips
   * themselves, through the real `teamFormatFrom`, rather than held in a
   * `chosen` variable sitting beside `data.teamFormat` waiting to be picked by
   * mistake.
   */
  const accepted = acceptedCount(applicants);
  const planned = planTeams(accepted, data.teamFormat.teamSize);
  const unsavedFormat = format !== data.teamFormat.format;
  const sized = teams.filter((team): team is DraftTeam & { id: string } =>
    team.id !== undefined
  );

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- The format, and teams nobody picked (UC-41) ----------- */}
      <Panel as="section" padding="none" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>The night&rsquo;s format</Eyebrow>
          <Badge tone="default">{data.teamFormat.format}</Badge>
        </div>

        {formatError && <Alert>{formatError}</Alert>}

        <ChoiceRow>
          {NIGHT_FORMATS.map((option) => {
            // The comp comes off the real reader, so the 6v6 → 2-2-2 mapping
            // exists once in the codebase and this screen cannot drift from
            // what the draw page states or the write reads.
            const shape = teamFormatFrom({ teamFormat: option });
            return (
              <ChoiceChip
                key={option}
                selected={format === option}
                disabled={formatBusy}
                aria-label={`Run this night as ${option}, a ${shape.comp} comp`}
                onClick={() => {
                  setFormat(option);
                  setFormatError(null);
                  setFormatNote(null);
                }}
              >
                {option} · {shape.comp}
              </ChoiceChip>
            );
          })}
        </ChoiceRow>

        <p className="max-w-prose text-12 text-muted">
          {data.teamFormat.format} states a {data.teamFormat.comp} comp and makes teams of{" "}
          {data.teamFormat.teamSize}. The comp is stated, never enforced — nobody is
          assigned a role, and a team that fields three Duelists is not refused.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="union"
            disabled={formatBusy || !unsavedFormat}
            onClick={() => void saveFormat()}
          >
            {formatBusy ? "Saving…" : "Save format"}
          </Button>
          {formatNote && <span className="text-12 text-muted">{formatNote}</span>}
        </div>

        <div className="space-y-4 border-t border-hair pt-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <Eyebrow>Random teams</Eyebrow>
            <Badge tone="default">{plural(accepted, "accepted player")}</Badge>
          </div>

          {shuffleError && <Alert tone="flare">{shuffleError}</Alert>}

          {data.started ? (
            // UC-41 3b. Refused outright rather than confirmed: the lots were
            // awarded against the teams that exist, so replacing them would
            // leave the prices paid attached to nothing.
            <Alert tone="union" standing>
              <span className="block font-medium">
                The draft has already awarded lots
              </span>
              <span className="mt-1 block opacity-90">
                Random teams would replace the teams those lots were awarded against, so
                it is refused. Void the lots in the draft room first.
              </span>
            </Alert>
          ) : planned.ok ? (
            <p className="max-w-prose text-12 text-muted">
              {plural(accepted, "accepted player")} make{" "}
              {plural(planned.plan.teams, "team")} of {planned.plan.sizes.join(", ")}.{" "}
              {planned.plan.short.length === 0
                ? `Every team is a full ${data.teamFormat.teamSize}.`
                : `${planned.plan.short.length === 1 ? "Team" : "Teams"} ${planned.plan.short.join(", ")} ${planned.plan.short.length === 1 ? "is" : "are"} short of ${data.teamFormat.teamSize} — the remainder is spread one per team rather than left on one short team.`}
            </p>
          ) : (
            // `standing`, by `alert-announcement.test.ts`'s rule: this is
            // derived from the applicants and the stored format alone, so it is
            // already in the markup when the page arrives. Announcing it would
            // interrupt every admin who opens the tab on an event that has not
            // filled up yet.
            <Alert tone="union" standing>
              {planned.error}
            </Alert>
          )}

          {/*
            UC-41 3a, said on the panel rather than only in the dialog.
            `Modal` renders nothing while it is closed, so a count that lives
            only inside it is a count no test can read — and step 4 is meant to
            say what the shuffle costs *before* step 5 asks.
          */}
          {!data.started && planned.ok && data.teams.length > 0 && (
            <p className="max-w-prose text-12 text-union">
              Shuffling discards the {plural(data.teams.length, "team")} that already
              exist, with their names, seeds and{" "}
              {plural(rosters.length, "roster place")}.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="union"
              disabled={shuffleBusy || data.started || !planned.ok || unsavedFormat}
              onClick={() => {
                setShuffleError(null);
                setShuffleNote(null);
                setShuffleAsking(true);
              }}
            >
              {shuffleBusy ? "Shuffling…" : "Make random teams"}
            </Button>
            {shuffleNote && <span className="text-12 text-muted">{shuffleNote}</span>}
            {unsavedFormat && (
              <span className="text-12 text-union">
                Save the format first — the shuffle uses what is stored.
              </span>
            )}
          </div>

          <p className="max-w-prose text-12 text-dim">
            Asking twice is fine: the second shuffle is a fresh one and replaces the
            first.
          </p>
        </div>
      </Panel>

      {/* --- How many (UC-15 1) ------------------------------------ */}
      <Panel as="section" padding="none" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>How many teams</Eyebrow>
          <Badge tone="default">
            {teams.length}/{MAX_TEAMS}
          </Badge>
        </div>

        {countError && <Alert>{countError}</Alert>}

        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[11rem]">
            <Eyebrow as="span" className="mb-1 block text-inherit">Teams</Eyebrow>
            <Stepper
              value={count}
              min={MIN_TEAMS}
              max={MAX_TEAMS}
              aria-label="Number of teams"
              disabled={countBusy}
              onChange={(value) => {
                setCount(value);
                setCountError(null);
              }}
            />
          </label>
          <Button
            size="sm"
            variant="union"
            disabled={countBusy || count === null || count === teams.length}
            onClick={() => void attemptCount()}
          >
            {countBusy ? "Saving…" : "Set team count"}
          </Button>
          <span className="max-w-prose text-12 text-muted">
            New teams arrive as “Team 1”, “Team 2” and so on. Choose a captain and the
            name becomes theirs — type a name below instead and it stays yours.
          </span>
        </div>
      </Panel>

      {/* --- Names, seeds, balances ------------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Names and seeds</Eyebrow>
          {perTeam ? (
            <Eyebrow as="span">Per-team balances</Eyebrow>
          ) : (
            <Eyebrow as="span">
              Uniform balances · everyone starts on{" "}
              <Money value={config.defaultBalance} size="sm" />
            </Eyebrow>
          )}
        </div>

        {teams.length === 0 ? (
          <EmptyState>
            No teams yet. Set the count above to between {MIN_TEAMS} and {MAX_TEAMS} — the
            draft, the bracket and the schedule all count from there.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
            {teams.map((team, index) => {
              const existing = team.id ? existingById.get(team.id) : undefined;
              const problem = errors[team.id ?? `new-${index}`];

              return (
                <li key={team.key} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <span className="num w-10 shrink-0 self-center text-12 text-muted">
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
                      <Eyebrow as="span" className="mb-1 block text-inherit">Seed</Eyebrow>
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
                        <Eyebrow as="span" className="mb-1 block text-inherit">Starting balance</Eyebrow>
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
                    </span>
                  </div>

                  {existing && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-10 text-12 text-muted">
                      <span className="num">
                        {existing.roster.size}/{existing.roster.target} on the roster
                      </span>
                      <span>
                        {existing.captainUserId ? (
                          <>Captain {playerName(players, existing.captainUserId)}</>
                        ) : (
                          <span className="text-union">No captain yet</span>
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
          <Alert tone="union">
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
          <p className="text-12 text-muted">
            A draft needs {MIN_TEAMS} teams to run. Set the count above.
          </p>
        )}

        <SaveRow
          state={state}
          note={note}
          onSave={() => void attemptSave()}
          label="Save names and seeds"
        >
          <Button size="sm" disabled={teams.length === 0} onClick={seedByOrder}>
            Seed by list order
          </Button>
          <span className="text-12 text-muted">
            Reordering keeps every roster — a team carries its identity with it.
          </span>
        </SaveRow>
      </Panel>

      {/* --- Rosters by hand (UC-15 5, 6) ------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>Rosters</Eyebrow>
          <Eyebrow as="span">
            {plural(config.rosterTarget, "place")} a team, captain included
          </Eyebrow>
        </div>

        {rosterError && <Alert tone="flare">{rosterError}</Alert>}

        {data.started && (
          <Alert tone="union" standing>
            <span className="block font-medium">The draft has started</span>
            <span className="mt-1 block opacity-90">
              Rosters are filled in the draft room from here on. Void the lots first if one
              has to be changed by hand.
            </span>
          </Alert>
        )}

        {sized.length === 0 ? (
          <EmptyState>Set the team count above and the rosters appear here.</EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {sized.map((team) => {
              const on = rosters.filter((row) => row.teamId === team.id);
              const full = on.length >= config.rosterTarget;

              return (
                <li key={team.id} className="rounded-lg border border-hair p-3">
                  <div className="mb-2 flex flex-wrap items-baseline gap-2">
                    <span className="font-display text-16">{team.name}</span>
                    <Badge tone={full ? "union" : "default"}>
                      {on.length}/{config.rosterTarget}
                    </Badge>
                  </div>

                  {on.length === 0 ? (
                    <EmptyState size="sm">Nobody on this roster yet.</EmptyState>
                  ) : (
                    <ul>
                      {[...on]
                        .sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain))
                        .map((member) => (
                          <li key={member.userId}>
                            <PlayerChip
                              name={playerName(players, member.userId)}
                              trailing={
                                member.isCaptain ? (
                                  <Badge tone="union">Captain</Badge>
                                ) : member.price > 0 ? (
                                  <Money value={member.price} size="sm" />
                                ) : null
                              }
                              dimmed={moving === member.userId}
                              actions={
                                member.isCaptain ? (
                                  <span className="text-11 text-dim">Captains tab</span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <Select
                                      aria-label={`Move ${playerName(players, member.userId)} to another team`}
                                      value=""
                                      disabled={moving !== null || data.started}
                                      className="text-12"
                                      onChange={(input) => {
                                        const to = input.target.value;
                                        if (to) void place(member.userId, to);
                                      }}
                                    >
                                      <option value="">Move to…</option>
                                      {teamsOpenTo(
                                        sized,
                                        rosters,
                                        config.rosterTarget,
                                        member.userId
                                      ).map((other) => (
                                        <option key={other.id} value={other.id}>
                                          {other.name}
                                        </option>
                                      ))}
                                    </Select>
                                    <Button
                                      size="sm"
                                      variant="flare"
                                      disabled={moving !== null || data.started}
                                      onClick={() => void unplace(member.userId, team.id)}
                                    >
                                      Off
                                    </Button>
                                  </span>
                                )
                              }
                            />
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-2">
          <Eyebrow>Accepted and not on a team</Eyebrow>
          {placeable.length === 0 ? (
            <EmptyState size="sm">
              Everybody accepted has a team. Accept more on the Applicants tab to place
              them here.
            </EmptyState>
          ) : (
            <ul>
              {placeable.map((userId) => (
                <li key={userId}>
                  <PlayerChip
                    name={playerName(players, userId)}
                    dimmed={moving === userId}
                    actions={
                      <Select
                        aria-label={`Place ${playerName(players, userId)} on a team`}
                        value=""
                        disabled={moving !== null || data.started || sized.length === 0}
                        className="text-12"
                        onChange={(input) => {
                          const to = input.target.value;
                          if (to) void place(userId, to);
                        }}
                      >
                        <option value="">Place on…</option>
                        {teamsOpenTo(sized, rosters, config.rosterTarget, userId).map(
                          (team) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          )
                        )}
                      </Select>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {/* --- The shuffle confirm (UC-41 3a, 4a, 5) ----------------- */}
      <Modal
        open={shuffleAsking}
        onClose={() => setShuffleAsking(false)}
        size="sm"
        eyebrow="Before this is saved"
        title={
          data.teams.length > 0 ? "This replaces the teams that exist" : "Make random teams"
        }
        footer={
          <>
            <Button size="sm" onClick={() => setShuffleAsking(false)}>
              Leave them alone
            </Button>
            <Button
              size="sm"
              variant="flare"
              disabled={shuffleBusy}
              onClick={() => void commitShuffle()}
            >
              {shuffleBusy ? "Shuffling…" : "Shuffle and save"}
            </Button>
          </>
        }
      >
        {/*
          UC-41 3a: how many teams go, named before anything is written. The
          count is `data.teams.length` — what the server last told this screen
          exists — rather than the local edit list, because that is what the
          write will actually discard.
        */}
        {data.teams.length > 0 && (
          <Alert tone="flare">
            <span className="block font-medium">
              {plural(data.teams.length, "team")} discarded, with{" "}
              {plural(rosters.length, "roster place")}
            </span>
            <span className="mt-1 block opacity-90">
              Their names, seeds and rosters go. Everybody accepted is dealt out again
              from scratch. Nothing has been changed yet.
            </span>
          </Alert>
        )}

        {planned.ok && (
          <div className="space-y-2">
            <p className="text-14">
              {plural(accepted, "accepted player")} into{" "}
              {plural(planned.plan.teams, "team")} of {data.teamFormat.teamSize} —{" "}
              {data.teamFormat.format}, a {data.teamFormat.comp} comp that is stated and
              not enforced.
            </p>
            <ul className="rounded-lg border border-hair">
              {planned.plan.sizes.map((size, index) => (
                <li
                  key={index}
                  className="flex items-baseline justify-between gap-3 border-b border-hair/60 p-2 last:border-b-0"
                >
                  <span className="text-14">Team {index + 1}</span>
                  <span className="flex items-baseline gap-2">
                    <span className="num text-12 text-muted">
                      {size}/{data.teamFormat.teamSize}
                    </span>
                    {size < data.teamFormat.teamSize && (
                      <Badge tone="union">
                        Short by {data.teamFormat.teamSize - size}
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {/* --- The confirm ------------------------------------------- */}
      <Modal
        open={impact !== null}
        onClose={() => {
          setImpact(null);
          setPendingCount(null);
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
                setPendingCount(null);
                setState("dirty");
              }}
            >
              Leave them alone
            </Button>
            <Button
              size="sm"
              variant="flare"
              disabled={state === "saving" || countBusy || impact?.anyBlocked}
              onClick={() =>
                void (pendingCount === null ? commit() : commitCount(pendingCount))
              }
            >
              {state === "saving" || countBusy ? "Saving…" : "Remove and save"}
            </Button>
          </>
        }
      >
        {impact && (
          <>
            {impact.anyBlocked ? (
              <Alert tone="flare">
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
              <Alert tone="flare">
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
                <li key={team.id} className="rounded-lg border border-hair p-3">
                  <div className="mb-1 flex flex-wrap items-baseline gap-2">
                    <span className="font-display text-16">{team.name}</span>
                    {team.blocked && <Badge tone="flare">Refused</Badge>}
                    {team.spent > 0 && (
                      <span className="flex items-baseline gap-1 text-12 text-muted">
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
