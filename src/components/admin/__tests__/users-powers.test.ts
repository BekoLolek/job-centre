import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminUserView } from "@/lib/admin-users";
import { POWERS, PRESETS, type Power } from "@/lib/permissions-policy";

/*
 * The screen that grants (Task 131, R-262, R-264 / UC-55).
 *
 * Rendered rather than reasoned about, as `host-queue.test.ts` is: what is
 * pinned is what an admin is offered - every power and only those, the ones
 * held already marked, the presets as buttons, and the sentences that say what
 * a preset does. The router and the actions are the two modules a static
 * render cannot have.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/admin/users/actions", () => ({
  addUserNoteAction: async () => ({ ok: true, data: { id: "" } }),
  endSessionsAction: async () => ({ ok: true, data: { ended: 0 } }),
  grantAdminAction: async () => ({ ok: true, data: { admins: 1 } }),
  listUserNotesAction: async () => [],
  revokeAdminAction: async () => ({ ok: true, data: { admins: 1 } }),
  saveMemberPowersAction: async () => ({ ok: true, data: { added: [], removed: [] } }),
}));

const {
  default: UsersManager,
  ADMIN_HAS_NO_LIST,
  CLEAR_STORED_POWERS,
  PRESET_CLEARS_NOTHING,
  PRESET_IS_NOT_FOLLOWED,
  PowersDialog,
  flagReplacesList,
  storedOnAnAdmin,
  withPreset,
} = await import("../UsersManager");

function member(overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id: "member-1",
    discordId: null,
    displayName: "Ada",
    handle: "ada",
    avatarUrl: null,
    isAdmin: false,
    fromAllowlist: false,
    createdAt: new Date("2026-03-01T18:00:00Z"),
    lastSeenAt: null,
    eventsPlayed: 0,
    notes: 0,
    powers: [],
    ...overrides,
  };
}

function renderDialog(powers: Power[]): string {
  return renderToStaticMarkup(
    createElement(PowersDialog, { member: member({ powers }), onClose() {}, onSaved() {} })
  );
}

function renderList(...rows: AdminUserView[]): string {
  return renderToStaticMarkup(
    createElement(UsersManager, {
      view: {
        users: rows,
        total: rows.length,
        admins: rows.filter((row) => row.isAdmin).length,
        pendingAllowlist: [],
      },
      currentUserId: "somebody-else",
    })
  );
}

/** Every checkbox in the markup: the power it stands for, and whether it is ticked. */
function boxes(markup: string): Array<{ power: string; ticked: boolean }> {
  return [...markup.matchAll(/<input type="checkbox"[^>]*>/g)].map(([tag]) => ({
    power: /value="([^"]*)"/.exec(tag)?.[1] ?? "",
    ticked: tag.includes(' checked=""'),
  }));
}

const PRESET_NAMES = Object.keys(PRESETS) as Array<keyof typeof PRESETS>;

describe("a preset", () => {
  it.each(PRESET_NAMES)("%s marks exactly its own powers on an empty list", (name) => {
    expect(withPreset(new Set(), name)).toEqual(new Set(PRESETS[name]));
  });

  it("does not clear a power the member already held outside it", () => {
    const held = new Set<Power>(["audit.read"]);

    const marked = withPreset(held, "Curator");

    expect(marked).toEqual(new Set(["audit.read", "games.manage", "templates.manage"]));
  });

  it("composes: a second preset does not erase the first", () => {
    const marked = withPreset(withPreset(new Set(), "Curator"), "Announcer");

    expect(marked).toEqual(new Set([...PRESETS.Curator, ...PRESETS.Announcer]));
  });

  it("hands back a new set rather than changing the one it was given", () => {
    const held = new Set<Power>(["audit.read"]);

    withPreset(held, "Curator");

    expect(held).toEqual(new Set(["audit.read"]));
  });
});

describe("a member's powers dialog", () => {
  it("offers every power in the vocabulary, and nothing that is not in it", () => {
    const offered = boxes(renderDialog([])).map((box) => box.power);

    expect(offered).toEqual([...POWERS]);
  });

  it("marks the powers the member holds, and only those", () => {
    const ticked = boxes(renderDialog(["polls.manage", "audit.read"]))
      .filter((box) => box.ticked)
      .map((box) => box.power);

    expect(new Set(ticked)).toEqual(new Set(["polls.manage", "audit.read"]));
  });

  it.each(PRESET_NAMES)("has the %s preset as a button", (name) => {
    expect(renderDialog([])).toMatch(new RegExp(`<button[^>]*>${name}</button>`));
  });

  it("says on the screen that a preset is applied, not followed", () => {
    expect(PRESET_IS_NOT_FOLLOWED).toMatch(/later release changes nobody/);
    expect(renderDialog([])).toContain(PRESET_IS_NOT_FOLLOWED);
  });

  it("says on the screen that a preset clears nothing", () => {
    expect(PRESET_CLEARS_NOTHING).toMatch(/clears nothing/);
    expect(renderDialog([])).toContain(PRESET_CLEARS_NOTHING);
  });

  it("has no control for the admin flag", () => {
    const markup = renderDialog([]);

    expect(markup).not.toMatch(/Make admin|Revoke admin/);
  });
});

describe("a row on the members list", () => {
  it("offers a member who is not an admin their powers, with how many they hold", () => {
    const markup = renderList(member({ powers: ["polls.manage", "audit.read"] }));

    expect(markup).toMatch(/<button[^>]*>Powers \(2\)<\/button>/);
  });

  it("offers an admin no power list", () => {
    const markup = renderList(member({ isAdmin: true }));

    expect(markup).not.toMatch(/<button[^>]*>Powers/);
  });

  it("says on an admin's row why there is no list", () => {
    expect(ADMIN_HAS_NO_LIST).toMatch(/can do everything/);
    expect(renderList(member({ isAdmin: true }))).toContain(ADMIN_HAS_NO_LIST);
  });

  it("does not say that on the row of a member who is not an admin", () => {
    expect(renderList(member())).not.toContain(ADMIN_HAS_NO_LIST);
  });
});

/*
 * Task 151. The flag replaces the list, and the screen says so on both sides
 * of the button: before a promotion that will delete a list, and on the row of
 * an admin who still has rows stored - which a sign-in can leave, because it
 * sets the flag without going through this screen.
 */
describe("a row on the members list and the admin flag", () => {
  const clearButton = new RegExp(`<button[^>]*>${CLEAR_STORED_POWERS}</button>`);

  it("names the powers still stored for an admin and says they return with a demotion", () => {
    const notice = storedOnAnAdmin(["polls.manage", "audit.read"]);

    expect(notice).toMatch(/polls\.manage, audit\.read/);
    expect(notice).toMatch(/come back into force if the admin flag is taken away/);
    expect(
      renderList(member({ isAdmin: true, powers: ["polls.manage", "audit.read"] }))
    ).toContain(notice);
  });

  it("does not tell an admin with stored rows that there is no list", () => {
    const markup = renderList(member({ isAdmin: true, powers: ["polls.manage"] }));

    expect(markup).not.toContain(ADMIN_HAS_NO_LIST);
  });

  it("offers to clear the rows stored for an admin", () => {
    const markup = renderList(member({ isAdmin: true, powers: ["polls.manage"] }));

    expect(markup).toMatch(clearButton);
  });

  it("offers nothing to clear on an admin with no stored rows", () => {
    const markup = renderList(member({ isAdmin: true }));

    expect(markup).not.toMatch(clearButton);
  });

  it("offers nothing to clear on a member who is not an admin: their list is live", () => {
    const markup = renderList(member({ powers: ["polls.manage"] }));

    expect(markup).not.toMatch(clearButton);
  });

  it("says on the row, before the click, that making a holder an admin removes their list", () => {
    // As text on the row and not a hover title: a title is not shown on a
    // phone, and this is a sentence about a list that is about to be deleted.
    const warning = flagReplacesList(["polls.manage", "audit.read"]);

    expect(warning).toMatch(/removes the 2 powers on their list/);
    expect(warning).toMatch(/polls\.manage, audit\.read/);
    expect(renderList(member({ powers: ["polls.manage", "audit.read"] }))).toContain(
      `>${warning}</p>`
    );
  });

  it("says nothing of the kind on the row of a member who holds nothing", () => {
    expect(renderList(member())).not.toContain("Making them an admin");
  });

  it("says nothing of the kind on the row of an admin: there is no promotion to warn about", () => {
    const markup = renderList(member({ isAdmin: true, powers: ["polls.manage"] }));

    expect(markup).not.toContain("Making them an admin");
  });
});
