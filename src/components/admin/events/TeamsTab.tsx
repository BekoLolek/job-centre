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
// A type only: `src/lib/draft.ts` reaches Postgres, and a value import here
// would drag Drizzle and PGlite into the browser bundle.
import type { TeamsFill } from "@/lib/draft";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
// The pure half, for the reason `EventEditor` imports `admin-templates-policy`
// rather than `admin-templates`: `planSides` and `teamCountFrom` are arithmetic
// over the Format panel's figure and a head count, with no database handle, so
// the screen can answer UC-41 4 — how many teams and which are short — without
// a round trip, using the *same* functions the writes use. A second copy here
// is how a screen and its server start disagreeing about what is about to be
// saved.
import {
  type EventShape,
  NIGHT_FORMATS,
  type NightFormat,
  planSides,
  sizingConsequence,
  teamCountFrom,
  teamFormatFrom,
} from "@/lib/events-policy";
import type { TeamPlanResult } from "@/lib/random-teams";
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
 * existing teams get discarded (UC-41 3a, 4a) — using the same `planSides`
 * the server uses, so the dialog and the write cannot disagree. It is
 * **refused outright once a lot has been awarded** (3b) rather than offered
 * and then rejected, which is why `data.started` disables the button *and*
 * explains itself. And **re-running is expected** (5a): the dialog is what
 * stops a reshuffle being an accident, not a limit on how many are allowed.
 *
 * ## Three routes into one set of teams (R-220 / UC-42 6, 6a)
 *
 * By hand (the rosters at the bottom), at random (the shuffle), or from the
 * draft (the Draft tab, when the Format panel says there is one). They are
 * not three features sharing a table: the first panel says so, and says
 * **which of them filled the teams that exist now** — `data.fill`, read on the
 * server off the rows and the mark the shuffle leaves — because "fill randomly"
 * over a hand-built roster is the destructive case and the admin has to know
 * what they are replacing before they are asked (6a). The same sentence is on
 * the panel and in the confirm, from one function, so the two cannot differ.
 *
 * ## The count follows the Format panel (R-218)
 *
 * The Format panel is where the sizing is decided — a count of teams, or
 * players per team — and this tab carries it out rather than arguing with it.
 * Once `teamCountFrom` can say how many teams that makes, the count control is
 * locked to the figure and says where to change it; the shuffle plans with
 * `planSides` from the same figure; and `setTeamCount` refuses anything else.
 * The night's 6v6/3v3 chip is left to do the one thing R-215 asks of it: state
 * the comp. It no longer sizes anything, which is why the shuffle no longer
 * waits for an unsaved chip to be saved.
 *
 * ## The decisions are functions, and the handlers obey them
 *
 * `shuffleGate`, `countControl`, `fillSentence` and `replacingSentence` are
 * exported pure functions for the reason Task 83's `manualPostStep` and Task
 * 80's `standingOn` are: the confirm state is reachable only by clicking, and
 * the suite is a node environment with nothing to click. Decided over plain
 * data they are asserted over every combination; inline in a handler they
 * would be guards no test could kill.
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

/* ------------------------------------------------------------------ */
/* The decisions the handlers obey (R-220 / UC-42 6, 6a)              */
/* ------------------------------------------------------------------ */

/** "23 Oct", in the reader's locale. */
function onDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Which route filled the current teams, in one sentence (UC-42 6).
 *
 * Captains are left out of every count, because choosing one is not a way of
 * filling a team; the empty case says so rather than reporting a captain-only
 * roster as "filled".
 */
export function fillSentence(fill: TeamsFill): string {
  switch (fill.route) {
    case "empty":
      return "Nobody has been placed on a team yet — captains aside, who are chosen on the Captains tab.";
    case "hand":
      return `Filled by hand — ${plural(fill.placed, "roster place")}, one at a time.`;
    case "random":
      return `Filled at random on ${onDate(fill.at)} — ${fill.dealt} dealt${
        fill.byHandSince > 0 ? `, ${fill.byHandSince} placed by hand since` : ""
      }.`;
    case "draft":
      return `Filled by the draft — ${fill.won} won in the room${
        fill.byHand > 0 ? `, ${fill.byHand} placed by hand` : ""
      }.`;
  }
}

/**
 * What a reshuffle would throw away, named before it is asked for (UC-41 3a,
 * UC-42 6a). The count is what the server last said exists — `data.teams` —
 * because that is what the write will actually discard.
 */
export function replacingSentence(fill: TeamsFill, teams: number, rosterPlaces: number): string {
  const head = `Shuffling discards the ${plural(teams, "team")} that already exist, with their names, seeds and ${plural(rosterPlaces, "roster place")}`;
  switch (fill.route) {
    case "empty":
      return `${head} — nobody is on them yet.`;
    case "hand":
      return `${head} — every one of them placed by hand.`;
    case "random":
      return `${head} — dealt at random on ${onDate(fill.at)}${
        fill.byHandSince > 0 ? `, with ${fill.byHandSince} placed by hand since` : ""
      }.`;
    case "draft":
      return `${head} — won in the draft.`;
  }
}

/** UC-41 3b, in the screen's words. Refused, not confirmed. */
const STARTED_REFUSAL =
  "The draft has already awarded lots. Random teams would replace the teams those lots were awarded against, so it is refused. Void the lots in the draft room first.";

export type ShuffleGate = {
  /** May the button be pressed at all? */
  allowed: boolean;
  /** Why not, when it may not. */
  refusal: string | null;
  /** What goes if it is — null for a first fill with nothing to replace. */
  replacing: string | null;
};

/**
 * Whether the shuffle is offered, and what its confirmation has to name — the
 * whole of UC-41 3a/3b and UC-42 6a as one decision over plain data.
 *
 * Refusals first, and 3b ahead of the numbers: awarded lots are not a
 * confirmation question. Then the plan, whose refusal is the planner's own
 * sentence (4b, 4c). Only then is it allowed, carrying the replacement
 * sentence when there is anything to replace.
 */
export function shuffleGate(input: {
  started: boolean;
  planned: TeamPlanResult;
  fill: TeamsFill;
  teams: number;
  rosterPlaces: number;
}): ShuffleGate {
  if (input.started) return { allowed: false, refusal: STARTED_REFUSAL, replacing: null };
  if (!input.planned.ok) return { allowed: false, refusal: input.planned.error, replacing: null };
  return {
    allowed: true,
    refusal: null,
    replacing:
      input.teams > 0 ? replacingSentence(input.fill, input.teams, input.rosterPlaces) : null,
  };
}

export type CountControl = {
  /** The count the Format panel settles, or null while the control is the admin's. */
  fixed: number | null;
  /** Beside the control: where the figure comes from, or why it is still free. */
  note: string;
};

/**
 * Whether the count control is locked to the Format panel, and what it says
 * about that (R-218 / UC-42 6).
 *
 * The same `teamCountFrom` the write checks, so a locked control never offers
 * a figure `setTeamCount` would refuse, and a free one is free for the reason
 * the write leaves it free: the panel cannot yet say how many teams there are.
 */
export function countControl(shape: EventShape, accepted: number): CountControl {
  const fixed = teamCountFrom(shape, accepted);
  if (shape.sizing.mode === "teams") {
    return { fixed, note: `Setup → Format says ${shape.sizing.value} teams. Change it there.` };
  }
  const side = `Setup → Format sizes the teams at ${shape.sizing.value} a side`;
  if (fixed !== null) {
    return {
      fixed,
      note: `${side} — ${plural(fixed, "team")} from the ${accepted} accepted. Change the sizing there.`,
    };
  }
  if (accepted === 0) {
    return {
      fixed: null,
      note: `${side}, and nobody is accepted yet — so the count is yours until there are enough to settle it.`,
    };
  }
  const planned = planSides(shape.sizing, accepted);
  return {
    fixed: null,
    note: `${side}. ${planned.ok ? "" : `${planned.error} `}Until then the count is yours.`,
  };
}

let counter = 0;
const nextKey = () => `new-${(counter += 1)}`;

export default function TeamsTab({
  eventId,
  applicants,
  data,
  shape,
}: {
  eventId: string;
  applicants: ApplicantView[];
  data: DraftTabData;
  /** The Format panel's three answers, as stored — `eventShapeFrom(event.config)`. */
  shape: EventShape;
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
    if (wanted === null) return;
    setCountBusy(true);
    setCountError(null);
    try {
      if (wanted < teams.length) {
        const preview = await previewTeamCountAction(eventId, wanted);
        if (preview.removed.length > 0) {
          setImpact(preview);
          setPendingCount(wanted);
          return;
        }
      }
      await commitCount(wanted);
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
            ? ` · ${plural(result.data.short.length, "team")} ${shortOf}`
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
   * UC-41 4 and UC-42 6, worked out with the same functions the writes use.
   *
   * **Sized from the Format panel as stored, and from nothing else.** That is
   * what `assignRandomTeams` and `setTeamCount` read, so a plan drawn from
   * anything else would promise one shape and save another. The night's comp
   * chip is printed through the real `teamFormatFrom` and sizes nothing.
   */
  const accepted = acceptedCount(applicants);
  const planned = planSides(shape.sizing, accepted);
  const stated = sizingConsequence(shape.sizing, accepted).stated;
  const control = countControl(shape, accepted);
  /** The count the next write would carry: the panel's, or the admin's. */
  const wanted = control.fixed ?? count;
  const gate = shuffleGate({
    started: data.started,
    planned,
    fill: data.fill,
    teams: data.teams.length,
    rosterPlaces: rosters.length,
  });
  // What a short side is short *of*: the stated side under players per team,
  // the biggest side under a count of teams, where the gap is always one.
  const biggest = planned.ok ? Math.max(...planned.plan.sizes) : 0;
  const shortOf =
    shape.sizing.mode === "perTeam" ? `short of ${shape.sizing.value}` : "one light";
  const unsavedFormat = format !== data.teamFormat.format;
  const sized = teams.filter((team): team is DraftTeam & { id: string } =>
    team.id !== undefined
  );

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Three routes, one set of teams (R-220 / UC-42 6, 6a) --- */}
      <Panel as="section" padding="none" className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>How the teams get filled</Eyebrow>
          <Badge tone={data.fill.route === "empty" ? "default" : "union"}>
            {data.fill.route === "empty"
              ? "Not filled yet"
              : data.fill.route === "hand"
                ? "By hand"
                : data.fill.route === "random"
                  ? "At random"
                  : "From the draft"}
          </Badge>
        </div>

        {/*
          Which route filled the teams that exist now. Standing, because it is
          derived from props alone and is on the page as it arrives; it is the
          sentence the shuffle's confirmation repeats, so the admin has read it
          before they are asked (UC-42 6a).
        */}
        <Alert tone={data.fill.route === "empty" ? "union" : "success"} standing>
          {fillSentence(data.fill)}
        </Alert>

        <ul className="max-w-prose space-y-1.5 text-13 leading-relaxed text-muted">
          <li>
            <span className="text-chalk">By hand</span> — place accepted players on the
            rosters below, one at a time.
          </li>
          <li>
            <span className="text-chalk">At random</span> — deal everybody accepted into sides
            the Format panel sizes, under Random teams below.
          </li>
          <li>
            {shape.draft ? (
              <>
                <span className="text-chalk">From the draft</span> — captains bid for players in
                the draft room.
              </>
            ) : (
              <>
                No draft on this event, so the teams are filled here. Setup → Format is where
                that is decided.
              </>
            )}
          </li>
        </ul>
        <p className="max-w-prose text-12 text-dim">
          Whichever way, it is the same teams: the rosters below are what the draft bids into
          and what a shuffle replaces.
        </p>
      </Panel>

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
          {data.teamFormat.format} states a {data.teamFormat.comp} comp. The comp is stated,
          never enforced — nobody is assigned a role, and a team that fields three Duelists is
          not refused. Teams are sized in Setup → Format, not here.
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

          {gate.refusal !== null ? (
            // UC-41 3b and 4b/4c, refused outright rather than confirmed —
            // `shuffleGate`'s call, not this component's. `standing`, by
            // `alert-announcement.test.ts`'s rule: derived from props alone, it
            // is already in the markup when the page arrives, and announcing
            // it would interrupt every admin opening the tab on an event that
            // has not filled up yet.
            <Alert tone="union" standing>
              {gate.refusal}
            </Alert>
          ) : (
            planned.ok && (
              <p className="max-w-prose text-12 text-muted">
                {plural(accepted, "accepted player")} make{" "}
                {plural(planned.plan.teams, "team")} of {planned.plan.sizes.join(", ")} — sized
                by {stated} in Setup → Format.{" "}
                {planned.plan.short.length === 0
                  ? shape.sizing.mode === "perTeam"
                    ? `Every team is a full ${shape.sizing.value}.`
                    : "Every team is the same size."
                  : `${planned.plan.short.length === 1 ? "Team" : "Teams"} ${planned.plan.short.join(", ")} ${planned.plan.short.length === 1 ? "is" : "are"} ${shortOf} — the remainder is spread one per team rather than left on one short team.`}
              </p>
            )
          )}

          {/*
            UC-41 3a and UC-42 6a, said on the panel rather than only in the
            dialog. `Modal` renders nothing while it is closed, so a sentence
            that lives only inside it is one no test can read — and step 4 is
            meant to say what the shuffle costs *before* step 5 asks.
          */}
          {gate.replacing !== null && (
            <p className="max-w-prose text-12 text-union">{gate.replacing}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="union"
              disabled={shuffleBusy || !gate.allowed}
              onClick={() => {
                setShuffleError(null);
                setShuffleNote(null);
                setShuffleAsking(true);
              }}
            >
              {shuffleBusy ? "Shuffling…" : "Make random teams"}
            </Button>
            {shuffleNote && <span className="text-12 text-muted">{shuffleNote}</span>}
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

        {/*
          R-218 / UC-42 6: the count follows the Format panel. Locked to its
          figure once `countControl` has one — the write would refuse anything
          else — and the admin's own only while the panel cannot say yet.
        */}
        <p className="max-w-prose text-12 text-muted">{control.note}</p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[11rem]">
            <Eyebrow as="span" className="mb-1 block text-inherit">Teams</Eyebrow>
            <Stepper
              value={wanted}
              min={MIN_TEAMS}
              max={MAX_TEAMS}
              aria-label="Number of teams"
              disabled={countBusy || control.fixed !== null}
              onChange={(value) => {
                setCount(value);
                setCountError(null);
              }}
            />
          </label>
          <Button
            size="sm"
            variant="union"
            disabled={countBusy || wanted === null || wanted === teams.length}
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
          UC-41 3a and UC-42 6a: what goes, named before anything is written,
          in `shuffleGate`'s own words — the sentence the panel already showed.
          The count is `data.teams.length`, what the server last told this
          screen exists, because that is what the write will actually discard.
        */}
        {gate.replacing !== null && (
          <Alert tone="flare">
            <span className="block font-medium">{gate.replacing}</span>
            <span className="mt-1 block opacity-90">
              Everybody accepted is dealt out again from scratch. Nothing has been changed
              yet.
            </span>
          </Alert>
        )}

        {planned.ok && (
          <div className="space-y-2">
            <p className="text-14">
              {plural(accepted, "accepted player")} into{" "}
              {plural(planned.plan.teams, "team")} — sized by {stated} in Setup → Format.{" "}
              {data.teamFormat.format} states a {data.teamFormat.comp} comp, which is not
              enforced.
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
                      {size}/{shape.sizing.mode === "perTeam" ? shape.sizing.value : biggest}
                    </span>
                    {planned.plan.short.includes(index + 1) && (
                      <Badge tone="union">
                        Short by{" "}
                        {(shape.sizing.mode === "perTeam" ? shape.sizing.value : biggest) - size}
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
