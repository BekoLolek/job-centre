"use client";

import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Eyebrow,
  Field,
  plural,
} from "@/components/ui";
// Type-only: `src/lib/heroes.ts` reaches Postgres, and a value import here
// would drag Drizzle and PGlite into the browser bundle. `FormatTab.tsx` carries
// the same note against `src/lib/format.ts` for the same reason, and
// `format-policy.ts` is the client-safe half it reaches for instead. The three
// role names are mirrored below rather than imported, and pinned to the enum by
// a test — see `HERO_ROLE_BOXES`.
import type { Hero, HeroRole } from "@/db";
import {
  createHeroAction,
  renameHeroAction,
  restoreHeroAction,
  retireHeroAction,
  setHeroRolesAction,
} from "@/app/admin/games/actions";

/**
 * A game's heroes — what each one is called and which roles it may be dealt in
 * (R-214 / UC-40).
 *
 * ## Why it is shaped like `QuestionList` and not like `LadderEditor`
 *
 * The rank ladder beside it holds its edits locally until Save, because the
 * ladder is **one** value — a jsonb array on the game — and it is normally
 * rearranged in several moves, so writing after each one would orphan answers
 * halfway through a rethink.
 *
 * A hero is a **row**. Five of them have nothing to do with each other, each
 * edit is its own audited fact about who changed what (UC-40 4), and there is
 * no order to rearrange: `listHeroes` returns them by name. So every control
 * here writes immediately and the page re-reads, which is `QuestionList`'s
 * shape — retire and restore sitting on the row they are about, beside the
 * name they are about. A Save button over 54 rows would also mean holding 54
 * rows of draft state to answer a question nobody asked.
 *
 * The one exception is the roles row, which has a Save beside it: three
 * checkboxes are one decision, and writing on each tick would send
 * `{Vanguard}` to the server on the way to `{Vanguard, Duelist}` — three
 * audit lines and, worse, a moment where `heroes_roles_distinct_nonempty`
 * refuses the empty set somebody is passing through on the way to a different
 * one. Unticking the last box before ticking the next is a normal way to use
 * three checkboxes, and it must not be a refusal.
 *
 * ## The rename, which is the trap on this screen
 *
 * A hero is identified by `(game, name)` and there is no stable key column, so
 * a rename frees the old name and the next run of the seed plants it again as a
 * second hero. **The screen says so before the write**, as a confirm carrying
 * {@link heroRenameSeedWarning}, and the audit line keeps both names because
 * nothing on the row does. This is the one control here that asks twice, and
 * that is why: a rename looks like an edit and is also a future insert.
 *
 * ## Nothing deletes
 *
 * There is no delete button and no dialog that could grow one. A hero removed
 * from the game is still in hands that were dealt, so retiring is the whole
 * control (UC-40 4a) — see {@link HERO_RETIRING_EXPLAINER}, which is printed
 * where the buttons are and is the same string `retireHero` is documented
 * against.
 *
 * ## At 400px
 *
 * Every row is a `flex-wrap` column stack that becomes a line when there is
 * room: the name and its badges, then the three role checkboxes, then the
 * buttons. The checkboxes are `Checkbox`, whose hit area is 44px square
 * regardless of the 16px box, so the narrow case is a tappable one.
 */

/**
 * The three roles, as the boxes to draw, in the order the draw reads them.
 *
 * A **mirror** of `heroRole.enumValues`, not an import of it: `HERO_ROLES` is
 * derived from a Drizzle `pgEnum`, so taking it from `src/lib/heroes.ts` would
 * put Drizzle and the database client in the browser bundle. The property that
 * list exists for — the database's idea of the roles and the code's cannot
 * drift — is kept here by a test that asserts this array equals
 * `heroRole.enumValues` exactly, order included. A fourth role would be a
 * migration, and that test is what makes it fail here rather than silently
 * leave the new role unofferable.
 */
export const HERO_ROLE_BOXES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

/**
 * What retiring does, and what it deliberately does not do (UC-40 4a).
 *
 * Printed where the retire buttons are, and exported so a test pins it against
 * what `retireHero` actually writes. Copy that merely reassures is worse than
 * none — `QuestionList.RETIRING_EXPLAINER` carries the same note for the same
 * reason, and the wording it replaced promised the opposite of the code.
 */
export const HERO_RETIRING_EXPLAINER =
  "Retiring takes a hero out of future draws and nothing else. Every hand already dealt " +
  "still names it, because the row stays exactly where it is — what was dealt was dealt. " +
  "Nothing here deletes a hero.";

/**
 * The consequence of a rename, stated before the write rather than discovered.
 *
 * **This is the (game, name) trap Task 73 recorded as inherited, and the screen
 * is not allowed to pretend otherwise.** The long form of the argument is at
 * `renameHero` in `src/lib/heroes.ts`; the short form is that a hero is
 * identified by its name within its game, there is no stable key column, and so
 * renaming frees the old name for the next run of the seed to plant again.
 *
 * Nothing on the row can detect that afterwards, which is exactly why the
 * warning comes first: after the write there is no field left saying this hero
 * was ever called anything else. The `hero.renamed` audit line is the only
 * record, and it carries both names for that reason.
 */
export function heroRenameSeedWarning(previousName: string, nextName: string): string {
  return (
    `A hero is identified by its name, so renaming ${previousName} to ${nextName} frees ` +
    `the name ${previousName} up. If ${previousName} is on the roster the seed plants, ` +
    `the next run of it will add a second hero under that name beside this one — retire ` +
    `that duplicate when it appears. Hands already dealt are untouched either way.`
  );
}

/** Why there is no delete, said where somebody would look for one. */
export const HERO_NO_DELETE =
  "There is deliberately no delete. A hero that was dealt to somebody is part of their " +
  "hand, and removing the row would either break that hand or quietly rewrite it.";

/** What the pool counts mean, because 15 + 28 + 13 does not equal 54. */
export const HERO_POOL_EXPLAINER =
  "A hero counts once for every role it holds, so the three pools add up to more than the " +
  "number of heroes. Deadpool is in all three.";

export type HeroEditorProps = {
  gameId: string;
  gameName: string;
  /** Every hero of this game, retired ones included, by name. */
  heroes: readonly Hero[];
  busy?: boolean;
  /** Re-reads the page's server data after a write. */
  onChanged: () => void;
};

export default function HeroEditor({
  gameId,
  gameName,
  heroes,
  busy,
  onChanged,
}: HeroEditorProps) {
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<HeroRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [renaming, setRenaming] = useState<{ hero: Hero; to: string } | null>(null);

  const locked = busy || working;

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setWorking(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else onChanged();
      return result.ok;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setWorking(false);
    }
  };

  const add = async () => {
    const wanted = name.trim();
    if (!wanted || roles.length === 0) return;
    if (await run(() => createHeroAction(gameId, wanted, roles))) {
      setName("");
      setRoles([]);
    }
  };

  const confirmRename = async () => {
    if (!renaming) return;
    if (await run(() => renameHeroAction(renaming.hero.id, renaming.to))) setRenaming(null);
  };

  const live = heroes.filter((hero) => hero.retiredAt === null);
  const retired = heroes.filter((hero) => hero.retiredAt !== null);
  /*
   * The same grouping `drawableByRole` does, counted rather than collected and
   * over the rows already on screen. Not an import of it, for the bundle reason
   * at the top of this file — and it is one `filter` per role, so a second copy
   * of the rule is not what this is: the rule is "a retired hero is not
   * drawable", and `live` is where that is applied, once.
   */
  const pool = (role: HeroRole) => live.filter((hero) => hero.roles.includes(role)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Heroes — what a draw may deal</Eyebrow>
        <Badge>{plural(live.length, "hero", "heroes")}</Badge>
        {retired.length > 0 && <Badge tone="flare">{retired.length} retired</Badge>}
        {/*
          * The drawable count per role, flared below three — UC-39 2a refuses a
          * draw outright when a role holds fewer than three, so a pool one
          * short is a draw that fails on the night and the admin should see it
          * from here rather than from a player.
          */}
        {HERO_ROLE_BOXES.map((role) => (
          <Badge key={role} tone={pool(role) >= 3 ? "default" : "flare"}>
            {role} {pool(role)}
          </Badge>
        ))}
      </div>

      {/*
        * Announced: `error` is handler state and can only be here because the
        * admin just pressed something. It is the refusal UC-40 3a and 3b are
        * about, so it is the one Alert on this screen that has to interrupt.
        */}
      {error && <Alert>{error}</Alert>}

      {/*
        * Announced for the same reason: this confirm exists because the admin
        * clicked Rename on a row, never on arrival.
        */}
      {renaming && (
        <Alert tone="flare">
          <span className="block font-medium">Before you rename this hero</span>
          <span className="mt-2 block opacity-90">
            {heroRenameSeedWarning(renaming.hero.name, renaming.to)}
          </span>
          <span className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="flare" disabled={locked} onClick={() => void confirmRename()}>
              Rename it anyway
            </Button>
            <Button size="sm" disabled={locked} onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </span>
        </Alert>
      )}

      {/* --- The list ---------------------------------------------- */}
      {live.length === 0 ? (
        <EmptyState size="sm">
          {gameName} has no heroes, so a draw on it deals nothing rather than an empty hand.
          Add them below — or run the seed, which plants the whole roster at once.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
          {live.map((hero) => (
            <HeroRow
              key={hero.id}
              hero={hero}
              locked={locked}
              onRename={(to) => setRenaming({ hero, to })}
              onRoles={(next) => void run(() => setHeroRolesAction(hero.id, next))}
              onRetire={() => void run(() => retireHeroAction(hero.id))}
            />
          ))}
        </ul>
      )}

      {/* --- Add ---------------------------------------------------- */}
      <div className="space-y-3 border-t border-hair pt-4">
        <Eyebrow>Add a hero</Eyebrow>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Name"
            hint="As the game spells it. One name per game."
            value={name}
            maxLength={60}
            wrapperClassName="flex-1 min-w-[12rem]"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
          <div>
            <Eyebrow className="mb-1">Roles</Eyebrow>
            <RoleBoxes
              roles={roles}
              disabled={locked}
              labelFor={(role) => `${role} for the new hero`}
              onChange={setRoles}
            />
          </div>
          <Button
            variant="union"
            disabled={locked || !name.trim() || roles.length === 0}
            onClick={() => void add()}
          >
            Add hero
          </Button>
        </div>
        <p className="text-12 leading-relaxed text-muted">
          Tick every role the hero can be played in — more than one is normal, and all three
          is correct for Deadpool. {HERO_POOL_EXPLAINER}
        </p>
      </div>

      {/* --- Retired ------------------------------------------------ */}
      <div className="space-y-3 border-t border-hair pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow>Retired — kept, not dealt</Eyebrow>
          <Badge tone={retired.length > 0 ? "flare" : "default"}>{retired.length}</Badge>
        </div>
        <p className="text-12 leading-relaxed text-muted">{HERO_RETIRING_EXPLAINER}</p>
        {retired.length > 0 && (
          <ul className="divide-y divide-hair/60 rounded-lg border border-hair">
            {retired.map((hero) => (
              <li key={hero.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-14 text-muted">{hero.name}</span>
                <span className="text-12 text-muted">{hero.roles.join(", ")}</span>
                <Button
                  size="sm"
                  disabled={locked}
                  aria-label={`Bring ${hero.name} back into the draw`}
                  onClick={() => void run(() => restoreHeroAction(hero.id))}
                >
                  Bring back
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-12 leading-relaxed text-muted">{HERO_NO_DELETE}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One hero                                                           */
/* ------------------------------------------------------------------ */

function HeroRow({
  hero,
  locked,
  onRename,
  onRoles,
  onRetire,
}: {
  hero: Hero;
  locked: boolean;
  onRename: (to: string) => void;
  onRoles: (roles: HeroRole[]) => void;
  onRetire: () => void;
}) {
  const [name, setName] = useState(hero.name);
  const [roles, setRoles] = useState<HeroRole[]>([...hero.roles]);

  const renamed = name.trim().length > 0 && name.trim() !== hero.name;
  const rolesChanged = HERO_ROLE_BOXES.some(
    (role) => roles.includes(role) !== hero.roles.includes(role)
  );

  return (
    <li className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:flex-wrap sm:items-end">
      <Field
        label={`Name — ${hero.name}`}
        value={name}
        maxLength={60}
        disabled={locked}
        wrapperClassName="flex-1 min-w-[10rem]"
        onChange={(event) => setName(event.target.value)}
      />

      <div>
        <Eyebrow className="mb-1">Roles</Eyebrow>
        <RoleBoxes
          roles={roles}
          disabled={locked}
          labelFor={(role) => `${role} for ${hero.name}`}
          onChange={setRoles}
        />
      </div>

      <span className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          size="sm"
          disabled={locked || !renamed}
          aria-label={`Rename ${hero.name}`}
          onClick={() => onRename(name.trim())}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="union"
          disabled={locked || !rolesChanged || roles.length === 0}
          aria-label={`Save the roles for ${hero.name}`}
          onClick={() => onRoles(roles)}
        >
          Save roles
        </Button>
        <Button
          size="sm"
          variant="flare"
          disabled={locked}
          aria-label={`Retire ${hero.name}`}
          onClick={onRetire}
        >
          Retire
        </Button>
      </span>
    </li>
  );
}

/**
 * The three roles as three boxes, in {@link HERO_ROLE_BOXES} order.
 *
 * It reports the whole set on every tick rather than one role at a time, so the
 * caller holds one value and `parseHeroRoles` sees the finished selection. The
 * rebuild is a `filter` over the canonical order rather than a splice into the
 * old array, so the set the server receives is already in `HERO_ROLES` order
 * whatever order the boxes were clicked in.
 */
function RoleBoxes({
  roles,
  disabled,
  labelFor,
  onChange,
}: {
  roles: readonly HeroRole[];
  disabled: boolean;
  labelFor: (role: HeroRole) => string;
  onChange: (roles: HeroRole[]) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      {HERO_ROLE_BOXES.map((role) => (
        <Checkbox
          key={role}
          checked={roles.includes(role)}
          disabled={disabled}
          label={role}
          aria-label={labelFor(role)}
          onChange={(on) =>
            onChange(
              HERO_ROLE_BOXES.filter((each) => (each === role ? on : roles.includes(each)))
            )
          }
        />
      ))}
    </span>
  );
}
