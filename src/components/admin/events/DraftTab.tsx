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
  Panel,
  StatTile,
  Stepper,
  cx,
  plural,
} from "@/components/ui";
import {
  BALANCE_MODES,
  BIDDING_MODES,
  BID_VISIBILITIES,
  BidCeiling,
  type Choice,
  EXCLUSION_REASONS,
  type ExclusionReason,
  Money,
  PlayerChip,
  SELECTION_MODES,
  playerName,
} from "@/components/draft";
import type { DraftPoolKind } from "@/db/schema";
import { type DraftConfig, draftConfigFrom } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import {
  movePoolPlayerAction,
  saveDraftConfigAction,
  seedDraftPoolAction,
} from "@/app/admin/events/draft-actions";
import SaveRow, { type SaveState } from "./SaveRow";
import type { DraftTabData } from "./types";

/**
 * Draft — §9's configuration, and the pool it will run on.
 *
 * ## Why the money is on screen while the rules are being chosen
 *
 * §9's last roster bullet is one checkbox — "whether a captain must keep enough
 * balance to fill their roster" — and it silently changes what every team may
 * bid for the whole draft. A rule nobody can see the effect of gets switched on
 * and then resented: the first a captain hears of it is a refused bid at the
 * worst possible moment, and the conclusion in the room is that the board is
 * broken.
 *
 * So the ceiling is shown *here*, against the settings currently on screen
 * rather than the ones last saved, and it moves as they are dragged around.
 * Every figure comes from `maxBidFor` and `rosterState` — the same functions
 * `canPlaceBid` will consult on the night — because a preview computed a second
 * way is a preview that will one day promise something the draft then refuses.
 *
 * ## What the config screen refuses to pretend
 *
 * Two of §9's settings interact and the plan lists them side by side without
 * saying so. `draftConfigFrom` upgrades open bidding with `admin_only`
 * visibility to `captains`, because "bid at least ten more than a number you
 * cannot see" is not a rule anybody can follow. The screen shows that happening
 * rather than letting the admin save a contradiction and discover it later.
 *
 * Likewise, once a lot has been awarded `setDraftConfig` refuses to lower the
 * roster target and stops rewriting starting balances. The controls say so
 * before they are touched instead of offering a rejection.
 *
 * ## The pool, and who is not in it
 *
 * `setDraftPool` does the excluding — captains never enter the pool (§14), and
 * anyone already bought is not still for sale — so this only asks for the seed
 * and then explains the result. "Who is missing and why" is the half that
 * usually goes unbuilt and is the half an admin actually needs: somebody
 * accepted after the pool was seeded is otherwise never drafted and nobody
 * notices until the wheel runs out of names.
 */

/* ------------------------------------------------------------------ */
/* Small shared controls                                              */
/* ------------------------------------------------------------------ */

/** A row of chips over one `Choice` list, with the chosen option's hint below. */
function Options<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
  forced,
}: {
  label: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** A note about a value the rules overrode, shown instead of the plain hint. */
  forced?: string;
}) {
  const hint = choices.find((choice) => choice.value === value)?.hint;
  return (
    <div className="space-y-1.5">
      <Eyebrow>{label}</Eyebrow>
      <ChoiceRow>
        {choices.map((choice) => (
          <ChoiceChip
            key={choice.value}
            selected={choice.value === value}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </ChoiceChip>
        ))}
      </ChoiceRow>
      <p className={cx("text-xs leading-relaxed", forced ? "text-gold" : "text-muted")}>
        {forced ?? hint}
      </p>
    </div>
  );
}

/** An on/off setting where neither state is "unanswered". */
function Switch({
  label,
  value,
  onChange,
  onLabel = "On",
  offLabel = "Off",
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  onLabel?: string;
  offLabel?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Eyebrow>{label}</Eyebrow>
      <ChoiceRow>
        <ChoiceChip selected={value} disabled={disabled} onClick={() => onChange(true)}>
          {onLabel}
        </ChoiceChip>
        <ChoiceChip selected={!value} disabled={disabled} onClick={() => onChange(false)}>
          {offLabel}
        </ChoiceChip>
      </ChoiceRow>
      {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

function Number_({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  hint,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Eyebrow>{label}</Eyebrow>
      <Stepper
        value={value}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
      {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The tab                                                            */
/* ------------------------------------------------------------------ */

export default function DraftTab({
  eventId,
  applicants,
  data,
}: {
  eventId: string;
  applicants: ApplicantView[];
  data: DraftTabData;
}) {
  const router = useRouter();
  const { players, teams, started } = data;

  /* --- Configuration ------------------------------------------- */

  const [form, setForm] = useState<DraftConfig>(data.config);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Everything downstream prices against the *sanitised* form, not the raw one:
  // a half-typed increment or an impossible visibility must not make the
  // ceiling below disagree with what the draft would actually enforce.
  const config = useMemo(() => draftConfigFrom(form), [form]);

  const set = <K extends keyof DraftConfig>(key: K, value: DraftConfig[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setState("dirty");
    setError(null);
    setNote(null);
  };

  const visibilityForced =
    form.biddingMode === "open" && form.bidVisibility === "admin_only"
      ? "Open bidding needs at least Captains — a raise over an amount you cannot see is not a rule anybody can follow, so this is saved as Captains."
      : undefined;

  const saveConfig = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveDraftConfigAction(eventId, config);
      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }
      // Adopt what was actually stored — `draftConfigFrom` may have upgraded
      // the visibility on the way in, and a form still showing the old value
      // would send it straight back on the next save.
      setForm(result.data.config);
      setNote(
        result.data.rebalanced > 0
          ? `Saved · ${plural(result.data.rebalanced, "team")} rebalanced`
          : null
      );
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  /* --- The pool ------------------------------------------------- */

  const [pool, setPool] = useState(data.pool);
  const [poolBusy, setPoolBusy] = useState<string | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [poolNote, setPoolNote] = useState<string | null>(null);

  const nameOf = (row: ApplicantView) =>
    row.member.displayName ?? row.member.discordId ?? "Unknown member";

  const applicantByUser = new Map(applicants.map((row) => [row.member.id, row]));
  const rankOf = (userId: string): string | undefined =>
    applicantByUser.get(userId)?.rank ?? undefined;

  const captains = new Map<string, string>();
  const drafted = new Map<string, string>();
  for (const team of teams) {
    if (team.captainUserId) captains.set(team.captainUserId, team.name);
    for (const member of team.members) {
      if (!member.isCaptain) drafted.set(member.userId, team.name);
    }
  }

  /** Everyone accepted into the event who is deliberately or accidentally out. */
  const excluded: Array<{ userId: string; reason: ExclusionReason; detail?: string }> = [
    ...[...captains.entries()].map(([userId, team]) => ({
      userId,
      reason: "captain" as const,
      detail: team,
    })),
    ...[...drafted.entries()].map(([userId, team]) => ({
      userId,
      reason: "drafted" as const,
      detail: team,
    })),
    ...data.discarded.map((userId) => ({ userId, reason: "discarded" as const })),
    ...applicants
      .filter((row) => row.status !== "accepted")
      .map((row) => ({
        userId: row.member.id,
        reason: "not_accepted" as const,
        detail: row.status,
      })),
  ];

  const runPool = async (
    key: string,
    call: () => Promise<
      | { ok: true; data: { pool: { main: string[]; reserve: string[] } } }
      | { ok: false; error: string }
    >,
    success: (data: { pool: { main: string[]; reserve: string[] } }) => string | null
  ) => {
    setPoolBusy(key);
    setPoolError(null);
    setPoolNote(null);
    try {
      const result = await call();
      if (!result.ok) {
        setPoolError(result.error);
        return;
      }
      setPool(result.data.pool);
      setPoolNote(success(result.data));
      router.refresh();
    } catch {
      setPoolError("Could not reach the server. Nothing was changed.");
    } finally {
      setPoolBusy(null);
    }
  };

  const seed = () =>
    void runPool(
      "seed",
      () => seedDraftPoolAction(eventId, {}),
      (result) => `Pool is ${plural(result.pool.main.length, "player")} in the main list`
    );

  const resetToMain = () =>
    void runPool(
      "reset",
      () => seedDraftPoolAction(eventId, { keepReserve: false }),
      () => "Everyone is back in the main pool"
    );

  const movePlayer = (userId: string, to: DraftPoolKind) =>
    void runPool(
      `move-${userId}`,
      () => movePoolPlayerAction(eventId, userId, to),
      () =>
        to === "reserve"
          ? `${playerName(players, userId)} is held over to the reserve pool`
          : `${playerName(players, userId)} is back in the main pool`
    );

  const acceptedCount = applicants.filter((row) => row.status === "accepted").length;
  const poolTotal = pool.main.length + (config.reserveEnabled ? pool.reserve.length : 0);
  const slotsToFill = teams.reduce(
    (total, team) => total + Math.max(0, config.rosterTarget - team.members.length),
    0
  );

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {started && (
        <Alert tone="gold">
          <span className="block font-medium">This draft has already awarded players</span>
          <span className="mt-1 block opacity-90">
            The roster size can go up but not down, and changing the default balance no
            longer rewrites what teams started with — moving the starting line mid-draft
            would silently rewrite what everyone can still afford.
          </span>
        </Alert>
      )}

      {/* --- Money --------------------------------------------------- */}
      <Panel as="section" className="space-y-5">
        <Eyebrow as="h2">Money</Eyebrow>

        <div className="grid gap-6 md:grid-cols-2">
          <Options
            label="Balances"
            choices={BALANCE_MODES}
            value={form.balanceMode}
            onChange={(value) => set("balanceMode", value)}
          />
          <Number_
            label={form.balanceMode === "uniform" ? "Everyone starts on" : "Default balance"}
            value={form.defaultBalance}
            min={0}
            max={1_000_000}
            step={50}
            onChange={(value) => set("defaultBalance", value ?? 0)}
            hint={
              form.balanceMode === "uniform"
                ? started
                  ? "Teams already have their starting balances; this no longer rewrites them."
                  : "Saving rewrites every team's starting balance to match — a mode that says the balances are equal and teams that disagree is not a state worth reaching."
                : "What a new team starts on. Set each team's own figure on the Teams tab."
            }
          />
        </div>
      </Panel>

      {/* --- Bidding ------------------------------------------------- */}
      <Panel as="section" className="space-y-5">
        <Eyebrow as="h2">Bidding</Eyebrow>

        <div className="grid gap-6 md:grid-cols-2">
          <Options
            label="Style"
            choices={BIDDING_MODES}
            value={form.biddingMode}
            onChange={(value) => set("biddingMode", value)}
          />
          <Options
            label="Who sees the amounts, live"
            choices={BID_VISIBILITIES}
            value={form.bidVisibility}
            onChange={(value) => set("bidVisibility", value)}
            forced={visibilityForced}
          />
          <Number_
            label="Minimum bid"
            value={form.minBid}
            min={0}
            max={1_000_000}
            step={10}
            onChange={(value) => set("minBid", value ?? 0)}
            hint="Zero is today's behaviour — a captain can claim an unwanted player for nothing."
          />
          <Number_
            label="Minimum increment"
            value={form.minIncrement}
            min={1}
            max={1_000}
            onChange={(value) => set("minIncrement", value ?? 1)}
            disabled={form.biddingMode !== "open"}
            hint={
              form.biddingMode === "open"
                ? "How far above the standing bid a raise has to go."
                : "Only used by open bidding."
            }
          />
        </div>

        <div className="grid gap-6 border-t border-hair pt-5 md:grid-cols-2">
          <Switch
            label="Bid timer"
            value={form.bidTimerSeconds !== null}
            onChange={(on) => set("bidTimerSeconds", on ? 60 : null)}
            onLabel="Timed"
            offLabel="No timer"
            hint="No timer is how the draft runs today — the admin closes a lot when the room is ready."
          />
          {form.bidTimerSeconds !== null && (
            <Number_
              label="Seconds a lot stays open"
              value={form.bidTimerSeconds}
              min={5}
              max={600}
              step={5}
              suffix="seconds"
              onChange={(value) => set("bidTimerSeconds", value ?? 60)}
            />
          )}
        </div>
      </Panel>

      {/* --- Rosters, and what the rule costs ------------------------ */}
      <Panel as="section" className="space-y-5">
        <Eyebrow as="h2">Rosters</Eyebrow>

        <div className="grid gap-6 md:grid-cols-2">
          <Number_
            label="Roster target"
            value={form.rosterTarget}
            min={started ? data.config.rosterTarget : 1}
            max={20}
            onChange={(value) => set("rosterTarget", value ?? 1)}
            hint={`Including the captain (§14), so each team drafts ${Math.max(
              0,
              config.rosterTarget - 1
            )} more.${started ? " It cannot be lowered now that players have been awarded." : ""}`}
          />
          <Switch
            label="Must fill your roster"
            value={form.mustFillRoster}
            onChange={(value) => set("mustFillRoster", value)}
            onLabel="Protected"
            offLabel="Spend freely"
            hint="§9's blind-bid protection: a captain has to keep back enough to buy somebody for every slot they have left."
          />
        </div>

        <BidCeiling teams={teams} config={config} bare className="border-t border-hair pt-5" />
      </Panel>

      {/* --- Selection and the reserve pool -------------------------- */}
      <Panel as="section" className="space-y-5">
        <Eyebrow as="h2">Selection</Eyebrow>

        <div className="grid gap-6 md:grid-cols-2">
          <Options
            label="Who goes up next"
            choices={SELECTION_MODES}
            value={form.selectionMode}
            onChange={(value) => set("selectionMode", value)}
          />
          <Switch
            label="Reserve pool"
            value={form.reserveEnabled}
            onChange={(value) => set("reserveEnabled", value)}
            hint="The second wheel: names that went for nothing first time round get another chance once the money is spent."
          />
          {form.reserveEnabled && (
            <Number_
              label="Reserve rounds"
              value={form.reserveRounds}
              min={1}
              max={10}
              suffix={form.reserveRounds === null ? "unlimited" : "rounds"}
              onChange={(value) => set("reserveRounds", value)}
              hint="Clear the box for unlimited."
            />
          )}
        </div>

        <SaveRow
          state={state}
          note={note}
          onSave={() => void saveConfig()}
          label="Save draft rules"
        >
          <span className="text-xs text-muted">
            The figures above update as you change these — nothing is saved until you press
            the button.
          </span>
        </SaveRow>
      </Panel>

      {/* --- The pool ------------------------------------------------ */}
      <Panel as="section" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow as="h2">The pool</Eyebrow>
          <span className="eyebrow text-muted/70">Seeded from accepted applicants</span>
        </div>

        {poolError && <Alert>{poolError}</Alert>}
        {poolNote && <Alert tone="signal">{poolNote}</Alert>}

        <div className="flex flex-wrap gap-8">
          <StatTile
            label="Main pool"
            value={pool.main.length}
            valueClassName={pool.main.length > 0 ? "text-gold" : "text-muted"}
          />
          <StatTile
            label="Reserve"
            value={config.reserveEnabled ? pool.reserve.length : "off"}
            valueClassName="text-muted"
          />
          <StatTile label="Accepted" value={acceptedCount} valueClassName="text-muted" />
          <StatTile
            label="Slots to fill"
            value={slotsToFill}
            valueClassName={
              slotsToFill > poolTotal ? "text-ember" : "text-signal"
            }
          />
          <StatTile
            label="Not yet pooled"
            value={data.unpooled.length}
            valueClassName={data.unpooled.length > 0 ? "text-gold" : "text-muted"}
          />
        </div>

        {slotsToFill > poolTotal && teams.length > 0 && (
          <Alert tone="gold">
            There are {plural(slotsToFill, "slot")} to fill and only{" "}
            {plural(poolTotal, "player")} in the pool. The draft will end with teams short —
            accept more applicants, or lower the roster target.
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-4">
          <Button
            size="sm"
            variant="gold"
            disabled={poolBusy !== null}
            onClick={seed}
          >
            {poolBusy === "seed" ? "Seeding…" : "Seed from accepted applicants"}
          </Button>
          <Button
            size="sm"
            disabled={poolBusy !== null || pool.reserve.length === 0}
            onClick={resetToMain}
          >
            Everyone back to the main pool
          </Button>
          <span className="text-xs text-muted">
            Seeding keeps anybody already held over in the reserve pool, and never adds a
            captain or a player who has been bought.
          </span>
        </div>

        <div className="grid gap-6 border-t border-hair pt-5 lg:grid-cols-2">
          <PoolList
            title="Main pool"
            eyebrow="The wheel draws from here"
            userIds={pool.main}
            players={players}
            rankOf={rankOf}
            busy={poolBusy}
            empty="Nothing in the main pool. Seed it from the accepted applicants above."
            action={
              config.reserveEnabled
                ? {
                    label: "Hold over →",
                    onClick: (userId) => movePlayer(userId, "reserve"),
                  }
                : undefined
            }
          />

          <PoolList
            title="Reserve pool"
            eyebrow={
              config.reserveEnabled
                ? "Comes round again once the main pool is empty"
                : "Switched off — these names are out of the draft"
            }
            userIds={pool.reserve}
            players={players}
            rankOf={rankOf}
            busy={poolBusy}
            dimmed={!config.reserveEnabled}
            empty="Nobody held over."
            action={
              config.reserveEnabled
                ? {
                    label: "← Back to main",
                    onClick: (userId) => movePlayer(userId, "main"),
                  }
                : undefined
            }
          />
        </div>

        {/* --- Who is not in it, and why ------------------------- */}
        <div className="space-y-3 border-t border-hair pt-5">
          <Eyebrow>Not in the pool</Eyebrow>

          {data.unpooled.length > 0 && (
            <Alert tone="gold">
              <span className="block font-medium">
                {plural(data.unpooled.length, "accepted applicant")} in neither a roster nor
                the pool
              </span>
              <span className="mt-1 block opacity-90">
                {data.unpooled.map((userId) => playerName(players, userId)).join(", ")} —
                accepted after the pool was seeded. Seed it again to add them.
              </span>
            </Alert>
          )}

          {excluded.length === 0 ? (
            <EmptyState size="sm">
              Everybody accepted into this event is in the pool.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hair/50 rounded-xl border border-hair">
              {excluded.map((entry) => (
                <li key={`${entry.reason}-${entry.userId}`} className="px-3">
                  <PlayerChip
                    name={playerName(players, entry.userId)}
                    meta={rankOf(entry.userId)}
                    dimmed={entry.reason !== "captain"}
                    trailing={
                      <>
                        {entry.detail && entry.reason !== "not_accepted" && (
                          <Badge>{entry.detail}</Badge>
                        )}
                        <span
                          className={cx(
                            "text-xs",
                            entry.reason === "captain" ? "text-gold" : "text-muted"
                          )}
                        >
                          {EXCLUSION_REASONS[entry.reason]}
                        </span>
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs leading-relaxed text-muted">
            A captain being out of the pool is the settled rule, not an omission — plan §14.
            They already have their roster slot, so drafting them would be buying somebody
            the team already has.
          </p>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One pool                                                           */
/* ------------------------------------------------------------------ */

function PoolList({
  title,
  eyebrow,
  userIds,
  players,
  rankOf,
  busy,
  empty,
  dimmed,
  action,
}: {
  title: string;
  eyebrow: string;
  userIds: readonly string[];
  players: DraftTabData["players"];
  rankOf: (userId: string) => string | undefined;
  busy: string | null;
  empty: string;
  dimmed?: boolean;
  action?: { label: string; onClick: (userId: string) => void };
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <Eyebrow>{title}</Eyebrow>
        <Badge>{userIds.length}</Badge>
      </div>
      <p className="text-xs text-muted">{eyebrow}</p>

      {userIds.length === 0 ? (
        <EmptyState size="sm">{empty}</EmptyState>
      ) : (
        <ul className="divide-y divide-hair/50 rounded-xl border border-hair">
          {userIds.map((userId, index) => (
            <li key={userId} className="px-3">
              <PlayerChip
                index={index + 1}
                name={playerName(players, userId)}
                meta={rankOf(userId)}
                dimmed={dimmed || busy === `move-${userId}`}
                actions={
                  action && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => action.onClick(userId)}
                    >
                      {busy === `move-${userId}` ? "…" : action.label}
                    </Button>
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
