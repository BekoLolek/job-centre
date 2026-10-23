import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type Hero, heroRole } from "@/db";
import type { AdminGameView, AdminGamesView } from "@/lib/admin-games";
import { HERO_GONE, HERO_NAME_REQUIRED, HERO_ROLE_REQUIRED, heroNameTakenRefusal } from "@/lib/heroes";

/**
 * The hero screen (R-214 / UC-40), and the wiring that makes it one.
 *
 * ## Why half of this file reads source off disk
 *
 * `src/lib/__tests__/heroes-editing.test.ts` proves the five writes against a
 * real Postgres. **None of that says the screen calls them**, and that is not a
 * hypothetical gap on this plan: `roles={roles}` was deleted from a page while
 * every test stayed green, because they all rendered the component directly.
 * The suite is a node environment with no DOM, so nothing here can click a
 * button — what it *can* do is hold the chain together at each hop:
 *
 *  - **page → `GamesManager`.** The page is a server component that awaits
 *    `requireAdmin()`, so it cannot be rendered here. Its two lines are read off
 *    disk: it must call `listHeroesByGame` and it must pass the result on.
 *  - **`GamesManager` → `HeroEditor`.** Rendered for real. The Heroes tab's
 *    count is computed from the `heroes` prop, so dropping it at either hop
 *    turns 54 into 0 and fails here.
 *  - **`HeroEditor` → the actions.** Read off disk: each of the five has to be
 *    imported *and* called. An import with no call is the shape that survives a
 *    deletion otherwise.
 *
 * ## And why the refusals are asserted whole
 *
 * `toBe` on the entire sentence, never `toContain` on a phrase. Task 78's 3b
 * assertion used `toContain` on wording a *different* refusal also carried, so
 * deleting the guard left it green. The `heroes-editing` file asserts the four
 * sentences share no substring; this one asserts the screen shows the string the
 * library produced rather than one of its own.
 */

const ROOT = path.resolve(__dirname, "../../..");

function source(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/*
 * The two modules the component cannot have here, mocked as
 * `templates-order-and-delete.test.ts` does it: the router (there is no Next
 * request) and the actions (`"use server"`, and nothing is clicked in a static
 * render).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/admin/games/actions", () => ({
  createGameAction: async () => ({ ok: true, data: { id: "" } }),
  renameGameAction: async () => ({ ok: true, data: null }),
  setGameActiveAction: async () => ({ ok: true, data: null }),
  moveGameAction: async () => ({ ok: true, data: null }),
  previewRankLadderAction: async () => ({ answers: 0, events: [], removed: [] }),
  setRankLadderAction: async () => ({ ok: true, data: { ladder: [], clearedAnswers: 0 } }),
  createFieldAction: async () => ({ ok: true, data: { id: "" } }),
  previewFieldEditAction: async () => ({ answers: 0, invalidated: 0 }),
  updateFieldAction: async () => ({ ok: true, data: { strandedAnswers: 0 } }),
  retireFieldAction: async () => ({ ok: true, data: { keptAnswers: 0 } }),
  restoreFieldAction: async () => ({ ok: true, data: { restoredAnswers: 0 } }),
  moveFieldAction: async () => ({ ok: true, data: null }),
  deleteFieldAction: async () => ({ ok: true, data: { deletedAnswers: 0 } }),
  createHeroAction: async () => ({ ok: true, data: { id: "" } }),
  renameHeroAction: async () => ({ ok: true, data: { name: "", previousName: "" } }),
  setHeroRolesAction: async () => ({ ok: true, data: { roles: [] } }),
  retireHeroAction: async () => ({ ok: true, data: { name: "" } }),
  restoreHeroAction: async () => ({ ok: true, data: { name: "" } }),
}));

const { default: HeroEditor, HERO_NO_DELETE, HERO_POOL_EXPLAINER, HERO_RETIRING_EXPLAINER, HERO_ROLE_BOXES, heroRenameSeedWarning } =
  await import("../HeroEditor");
const { default: GamesManager } = await import("../GamesManager");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function hero(name: string, roles: Hero["roles"], retiredAt: Date | null = null): Hero {
  return {
    id: `hero-${name}`,
    gameId: "game-1",
    name,
    roles,
    retiredAt,
    createdAt: new Date("2026-10-23T00:00:00Z"),
  };
}

/** Five heroes: three Vanguard, one Duelist, Deadpool in all three, one retired. */
const ROSTER: Hero[] = [
  hero("Deadpool", ["Vanguard", "Duelist", "Strategist"]),
  hero("Hulk", ["Vanguard"]),
  hero("Psylocke", ["Duelist"]),
  hero("The Hood", ["Vanguard"], new Date("2026-10-23T12:00:00Z")),
  hero("Thor", ["Vanguard"]),
];

function game(over: Partial<AdminGameView> = {}): AdminGameView {
  return {
    id: "game-1",
    key: "rivals",
    name: "Marvel Rivals",
    rankLadder: ["Bronze", "Silver"],
    isActive: true,
    sort: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    fields: [],
    retired: [],
    answers: 0,
    ...over,
  } as AdminGameView;
}

function view(games: AdminGameView[] = [game()]): AdminGamesView {
  return { games, globalFields: [], globalRetired: [], globalAnswers: 0 };
}

function editor(over: Partial<Parameters<typeof HeroEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(HeroEditor, {
      gameId: "game-1",
      gameName: "Marvel Rivals",
      heroes: ROSTER,
      onChanged: () => {},
      ...over,
    })
  );
}

/* ------------------------------------------------------------------ */
/* The roles the screen offers                                        */
/* ------------------------------------------------------------------ */

describe("the role boxes", () => {
  it("are the database's three roles, in the database's order", () => {
    /*
     * `HERO_ROLE_BOXES` is a **mirror** of the enum rather than an import of
     * it, because `src/lib/heroes.ts` reaches Postgres and a value import from
     * a `"use client"` module would put Drizzle in the browser bundle —
     * `FormatTab.tsx` carries the same note against `src/lib/format.ts`. This
     * assertion is the whole reason the mirror is allowed to exist: it is what
     * keeps the two from drifting, and a fourth role added by migration fails
     * here rather than quietly never appearing as a box.
     */
    expect([...HERO_ROLE_BOXES]).toEqual([...heroRole.enumValues]);
  });

  it("draws one box per role, each labelled for the hero it belongs to", () => {
    const html = editor();
    for (const role of heroRole.enumValues) {
      expect(html).toContain(`${role} for Hulk`);
      expect(html).toContain(`${role} for the new hero`);
    }
    // Checked where the hero holds the role, and not where it does not. Hulk is
    // Vanguard only, so exactly one of his three boxes is ticked.
    const hulkBoxes = [...html.matchAll(/<input[^>]*aria-label="(\w+) for Hulk"[^>]*>/g)];
    expect(hulkBoxes).toHaveLength(3);
    expect(hulkBoxes.filter(([tag]) => tag.includes("checked")).map(([, role]) => role)).toEqual([
      "Vanguard",
    ]);
  });

  it("ticks all three for a hero in all three (UC-40 3c)", () => {
    const html = editor();
    const boxes = [...html.matchAll(/<input[^>]*aria-label="(\w+) for Deadpool"[^>]*>/g)];
    expect(boxes.filter(([tag]) => tag.includes("checked")).map(([, role]) => role)).toEqual([
      "Vanguard",
      "Duelist",
      "Strategist",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The list, and what it says                                         */
/* ------------------------------------------------------------------ */

describe("the hero list", () => {
  it("shows every hero that is still dealt, with a control for each edit (UC-40 2)", () => {
    const html = editor();
    for (const name of ["Deadpool", "Hulk", "Psylocke", "Thor"]) {
      expect(html).toContain(`Rename ${name}`);
      expect(html).toContain(`Save the roles for ${name}`);
      expect(html).toContain(`Retire ${name}`);
    }
  });

  it("counts the drawable pool per role, and flares one that cannot be dealt from", () => {
    /*
     * UC-39 2a refuses a draw outright when a role holds fewer than three, so
     * the admin has to be able to see it from here rather than from a player on
     * the night. Vanguard is 3 (Deadpool, Hulk, Thor — The Hood is retired and
     * does not count), Duelist 2, Strategist 1.
     */
    const html = editor();
    expect(html).toContain("Vanguard 3");
    expect(html).toContain("Duelist 2");
    expect(html).toContain("Strategist 1");
  });

  it("leaves a retired hero out of every pool count but keeps it on the screen (UC-40 4a)", () => {
    const html = editor();
    // Still listed, with the way back.
    expect(html).toContain("The Hood");
    expect(html).toContain("Bring The Hood back into the draw");
    // But not offered the live-row controls, and not counted: Vanguard would be
    // 4 if a retired hero were still in its pool.
    expect(html).not.toContain("Retire The Hood");
    expect(html).toContain("Vanguard 3");
  });

  it("says what retiring does, in the words retireHero is documented against", () => {
    expect(editor()).toContain(HERO_RETIRING_EXPLAINER);
    // The claim itself, so the copy cannot drift into promising the opposite —
    // which is what `QuestionList`'s retiring copy did before it was pinned.
    expect(HERO_RETIRING_EXPLAINER).toContain("Every hand already dealt");
    expect(HERO_RETIRING_EXPLAINER).toContain("Nothing here deletes a hero.");
  });

  it("offers no delete anywhere, and says why", () => {
    const html = editor();
    expect(html).toContain(HERO_NO_DELETE);
    expect(html).not.toMatch(/>\s*Delete\s*</);
    // And the component imports nothing that could do one: there is no delete
    // action for a hero to call.
    expect(source("components/admin/HeroEditor.tsx")).not.toMatch(/deleteHero/);
  });

  it("explains why the pools add up to more than the number of heroes", () => {
    expect(editor()).toContain(HERO_POOL_EXPLAINER);
  });

  it("names the game rather than showing an empty list when it has no heroes", () => {
    const html = editor({ heroes: [] });
    expect(html).toContain("Marvel Rivals has no heroes");
    expect(html).not.toContain("Vanguard 3");
  });
});

/* ------------------------------------------------------------------ */
/* The rename warning — the (game, name) trap                         */
/* ------------------------------------------------------------------ */

describe("the rename warning", () => {
  it("names the freed name, the new name, and the duplicate the next seed plants", () => {
    const said = heroRenameSeedWarning("The Hood", "The Hood (reworked)");
    expect(said).toContain("renaming The Hood to The Hood (reworked) frees the name The Hood up");
    expect(said).toContain("add a second hero under that name beside this one");
    expect(said).toContain("retire that duplicate when it appears");
    // The half an admin most needs: the rename does not touch what was dealt.
    expect(said).toContain("Hands already dealt are untouched either way.");
  });

  it("is not on the screen until the admin asks to rename", () => {
    /*
     * The confirm is handler state, which is also why `alert-announcement`
     * records it as announced: it appears in place of the write, so nothing
     * else would tell a screen-reader user it is there. A render with no
     * interaction must therefore not contain it.
     */
    expect(editor()).not.toContain("Before you rename this hero");
    expect(editor()).not.toContain("frees the name");
  });

  it("stands between the Rename button and the action, in the component itself", () => {
    /*
     * The one assertion a static render cannot make, so it is made on the
     * source: `Rename` must set the confirm, and `renameHeroAction` must be
     * reachable only from the confirm's own handler. If the button called the
     * action directly, the warning would be decoration.
     */
    const code = source("components/admin/HeroEditor.tsx");
    expect(code).toMatch(/onClick=\{\(\) => onRename\(name\.trim\(\)\)\}/);
    expect(code).toMatch(/const confirmRename = async \(\) => \{[\s\S]*?renameHeroAction/);
    // Exactly one call site, and it is that one.
    expect([...code.matchAll(/renameHeroAction\(/g)]).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The refusals the screen shows                                      */
/* ------------------------------------------------------------------ */

describe("the refusals", () => {
  it("shows the sentence the library returned rather than one of its own", () => {
    /*
     * The screen writes no refusal copy for UC-40 3a or 3b — it renders
     * `result.error`, which is `heroNameTakenRefusal` or `HERO_ROLE_REQUIRED`
     * verbatim. So the strings must be absent from the component's own source:
     * a second copy of them here is how the two drift until the screen says
     * something the server never refused.
     */
    const code = source("components/admin/HeroEditor.tsx");
    for (const sentence of [HERO_ROLE_REQUIRED, HERO_NAME_REQUIRED, HERO_GONE, heroNameTakenRefusal("Hulk")]) {
      expect(code).not.toContain(sentence);
    }
    expect(code).toMatch(/setError\(result\.error \?\? "That did not work\."\)/);
  });

  it("will not send an add with no role or no name, so the refusal is not the only guard", () => {
    /*
     * Belt and braces in the right order. `createHero` refuses both (asserted
     * against Postgres in `heroes-editing.test.ts`) and
     * `heroes_roles_distinct_nonempty` refuses the empty set underneath that —
     * but a button whose only possible outcome is a refusal is not a choice,
     * so it is disabled until the form could succeed. `QuestionList` makes the
     * same argument about the delete it does not offer.
     */
    const code = source("components/admin/HeroEditor.tsx");
    expect(code).toMatch(/disabled=\{locked \|\| !name\.trim\(\) \|\| roles\.length === 0\}/);
    expect(code).toMatch(/if \(!wanted \|\| roles\.length === 0\) return;/);

    // Nothing ticked at first render, so the Add button starts disabled.
    const html = editor({ heroes: [] });
    const add = html.match(/<button[^>]*>Add hero<\/button>/)![0];
    expect(add).toContain("disabled");
  });

  it("will not send a roles save that has emptied every box", () => {
    // Unticking the last box on the way to a different set is a normal way to
    // use three checkboxes, and it must not reach the check constraint.
    expect(source("components/admin/HeroEditor.tsx")).toMatch(
      /disabled=\{locked \|\| !rolesChanged \|\| roles\.length === 0\}/
    );
  });
});

/* ------------------------------------------------------------------ */
/* The wiring — the roles={roles} guard                               */
/* ------------------------------------------------------------------ */

describe("the chain from the page to the writes", () => {
  it("has the page load the heroes and hand them to GamesManager", () => {
    /*
     * The hop a rendered test cannot reach: `page.tsx` is a server component
     * that awaits `requireAdmin()`. Both halves are asserted, because either
     * alone is survivable — a loader whose result is dropped, or a prop passed
     * from a value nothing filled.
     */
    const code = source("app/admin/games/page.tsx");
    expect(code).toMatch(/import \{ listHeroesByGame \} from "@\/lib\/heroes"/);
    expect(code).toMatch(/listHeroesByGame\(\)/);
    expect(code).toMatch(/<GamesManager view=\{view\} heroesByGame=\{heroesByGame\} \/>/);
  });

  it("has GamesManager reach HeroEditor with the heroes of that game", () => {
    /*
     * Rendered for real, and the Heroes tab's count is the proof: it is
     * computed from the `heroes` prop, so deleting it at either hop — the
     * `GameCard` call or the `HeroEditor` call — makes this 0.
     *
     * Four, not five: the count is the **drawable** ones, so retiring a hero
     * takes the number on the tab down, which is what retiring means.
     */
    const html = renderToStaticMarkup(
      createElement(GamesManager, { view: view(), heroesByGame: { "game-1": ROSTER } })
    );
    expect(html).toContain("Heroes");
    const tab = html.match(/Heroes<[^]*?<\/button>/)?.[0] ?? "";
    expect(tab).toMatch(/>4</);
  });

  it("asks for nothing and crashes on nothing when a game has no heroes", () => {
    // `listHeroesByGame` omits a game with no rows rather than keying it empty,
    // so the `?? []` at the call site is load-bearing.
    const html = renderToStaticMarkup(
      createElement(GamesManager, { view: view(), heroesByGame: {} })
    );
    expect(html).toContain("Heroes");
    expect(source("components/admin/GamesManager.tsx")).toMatch(
      /heroes=\{heroesByGame\[game\.id\] \?\? \[\]\}/
    );
  });

  it("puts the Heroes tab beside the rank ladder, which is the precedent it follows", () => {
    const code = source("components/admin/GamesManager.tsx");
    const ranks = code.indexOf('value: "ranks"');
    const heroes = code.indexOf('value: "heroes"');
    const settings = code.indexOf('value: "settings"');
    expect(ranks).toBeGreaterThan(-1);
    expect(heroes).toBeGreaterThan(ranks);
    expect(settings).toBeGreaterThan(heroes);
    // And it renders the editor, not a placeholder.
    expect(code).toMatch(/tab === "heroes" && \(\s*<HeroEditor/);
  });

  it("calls every one of the five writes from the screen", () => {
    /*
     * Imported **and** called, each exactly where it belongs. An import with no
     * call is the shape a deletion survives: the module graph still looks
     * right and the control does nothing.
     */
    const code = source("components/admin/HeroEditor.tsx");
    const calls: Record<string, RegExp> = {
      createHeroAction: /createHeroAction\(gameId, wanted, roles\)/,
      renameHeroAction: /renameHeroAction\(renaming\.hero\.id, renaming\.to\)/,
      setHeroRolesAction: /setHeroRolesAction\(hero\.id, next\)/,
      retireHeroAction: /retireHeroAction\(hero\.id\)/,
      restoreHeroAction: /restoreHeroAction\(hero\.id\)/,
    };
    for (const [name, call] of Object.entries(calls)) {
      expect(code, `${name} is not imported`).toContain(`  ${name},`);
      expect(code, `${name} is imported but never called`).toMatch(call);
    }
  });

  it("re-reads the server's rows after a write rather than editing a local copy", () => {
    // `onChanged` is `router.refresh()` through `GamesManager`, so what is on
    // screen is always the rows as Postgres has them. The component holds no
    // hero list of its own.
    const code = source("components/admin/HeroEditor.tsx");
    expect(code).toMatch(/else onChanged\(\)/);
    expect(code).not.toMatch(/useState<Hero\[\]>/);
  });
});

/* ------------------------------------------------------------------ */
/* At 400px                                                           */
/* ------------------------------------------------------------------ */

describe("at 400px", () => {
  it("stacks a hero's row until there is room for a line", () => {
    /*
     * The row carries the name box, three checkboxes and three buttons, which
     * is the most crowded line on this screen. `flex-col` until `sm:`, and
     * wrapping after it, so nothing is pushed off the side at phone width —
     * the Constraint in `docs/requirements.md`.
     */
    const code = source("components/admin/HeroEditor.tsx");
    expect(code).toMatch(/className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:flex-wrap/);
  });

  it("wraps every other row of controls rather than overflowing", () => {
    const html = editor();
    /*
     * Every flex **container** on this screen breaks rather than scrolls: it is
     * `flex-wrap`, or `flex-col`, or one of `Checkbox`'s own 44px wrappers,
     * which holds a single box and has nothing to wrap.
     *
     * Containers only — the token has to be exactly `flex`, because `flex-1` is
     * a flex *item* and says nothing about direction. An earlier version of
     * this matched `\bflex\b`, which `-` ends, so it collected the name boxes
     * and failed on classes that were never rows.
     */
    const containers = [...html.matchAll(/class="([^"]*)"/g)]
      .map(([, cls]) => cls)
      .filter((cls) => cls.split(/\s+/).some((token) => token === "flex"));
    expect(containers.length).toBeGreaterThan(5);
    const rigid = containers.filter((cls) => !/flex-wrap|flex-col|min-h-11/.test(cls));
    expect(rigid).toEqual([]);
  });

  it("keeps the role boxes tappable, because Checkbox sizes its own hit area", () => {
    // 44px minimum, which `Checkbox` guarantees from the inside — a call site
    // cannot reach the input, so it cannot shrink it back under the floor.
    expect(editor()).toContain("min-h-11");
  });
});
