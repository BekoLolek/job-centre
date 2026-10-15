import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminTemplateView, AdminTemplatesView } from "@/lib/admin-templates";

/*
 * What `/admin/templates` offers an admin walking UC-28 (R-125 to R-130).
 *
 * The library tests prove the writes; this proves the screen has the controls
 * the use case's steps need and says the true thing about the one that cannot
 * be undone:
 *
 *  - step 2, the list "in order, each with how many events used it and whether
 *    it is on" — the three things on the row;
 *  - step 7, "moves the copy to the top" — two arrows, which nothing on this
 *    screen had until Task 35, so the order was whatever `createTemplate`
 *    appended and R-129 had no control behind it at all;
 *  - 8a, deleting a template events were created from — offered, and the
 *    confirm says those events keep working, because `deleteTemplate` and the
 *    `on delete set null` foreign key mean they do.
 *
 * The two modules the component cannot have here are mocked, as in
 * `question-copy.test.ts`: the router (there is no Next request) and the
 * actions (`"use server"`, and nothing is clicked in a static render).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/admin/templates/actions", () => ({
  createTemplateAction: async () => ({ ok: true, data: { id: "" } }),
  createTemplateFromEventAction: async () => ({ ok: true, data: { id: "", name: "" } }),
  deleteTemplateAction: async () => ({ ok: true, data: { usedBy: 0 } }),
  duplicateTemplateAction: async () => ({ ok: true, data: { id: "" } }),
  moveTemplateAction: async () => ({ ok: true, data: null }),
  setTemplateActiveAction: async () => ({ ok: true, data: { id: "" } }),
  updateTemplateAction: async () => ({ ok: true, data: { id: "" } }),
}));

const { default: TemplatesManager, DEACTIVATE_INSTEAD, templateDeleteWarning } =
  await import("../TemplatesManager");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function template(over: Partial<AdminTemplateView> = {}): AdminTemplateView {
  return {
    id: "template-1",
    name: "Rivals monthly",
    type: "tournament",
    gameId: null,
    gameName: null,
    config: { teams: 4 },
    questions: [],
    sort: 0,
    isActive: true,
    createdAt: new Date("2026-03-01T18:00:00Z"),
    events: 0,
    liveEvents: 0,
    ...over,
  };
}

function view(templates: AdminTemplateView[]): AdminTemplatesView {
  return { templates, games: [], sources: [], profileFields: [] };
}

function render(templates: AdminTemplateView[]): string {
  return renderToStaticMarkup(
    createElement(TemplatesManager, { view: view(templates) })
  );
}

/** The `<article>` one template's row sits in, so "on the row" can be asserted. */
function rowFor(markup: string, name: string): string {
  const row = markup.split("<article").find((part) => part.includes(name));
  expect(row, `no row for ${name}`).toBeDefined();
  return row as string;
}

const USED = template({ id: "used", name: "Rivals monthly", events: 4, liveEvents: 1 });
const NEVER_USED = template({ id: "fresh", name: "Quiz night", sort: 1 });
const HIDDEN = template({ id: "off", name: "Summer league", sort: 2, isActive: false, events: 2 });

/* ------------------------------------------------------------------ */
/* Step 2: the list                                                   */
/* ------------------------------------------------------------------ */

describe("the list (UC-28 2)", () => {
  it("says how many events used each template, and whether it is on", () => {
    const markup = render([USED, NEVER_USED, HIDDEN]);

    expect(rowFor(markup, "Rivals monthly")).toContain("used 4 times");
    expect(rowFor(markup, "Rivals monthly")).toContain("Active");
    expect(rowFor(markup, "Quiz night")).toContain("never used");
    expect(rowFor(markup, "Summer league")).toContain("Hidden");
  });

  it("keeps the order it was given, which is the order sort put them in", () => {
    const markup = render([USED, NEVER_USED, HIDDEN]);
    const at = (name: string) => markup.indexOf(name);

    expect(at("Rivals monthly")).toBeLessThan(at("Quiz night"));
    expect(at("Quiz night")).toBeLessThan(at("Summer league"));
  });
});

/* ------------------------------------------------------------------ */
/* Step 7: moving one                                                 */
/* ------------------------------------------------------------------ */

describe("moving a template (UC-28 7, R-129)", () => {
  it("offers an up and a down arrow on every row, named for the template", () => {
    const markup = render([USED, NEVER_USED, HIDDEN]);

    expect(markup).toContain('aria-label="Move Quiz night up"');
    expect(markup).toContain('aria-label="Move Quiz night down"');
  });

  it("disables the arrow that would do nothing at either end", () => {
    const markup = render([USED, NEVER_USED, HIDDEN]);

    // The first row cannot go up and the last cannot go down. An enabled
    // button that does nothing is the failure dense `sort` exists to prevent,
    // and this is the half of it the screen owns.
    expect(rowFor(markup, "Rivals monthly")).toMatch(
      /aria-label="Move Rivals monthly up"[^>]*disabled/
    );
    expect(rowFor(markup, "Rivals monthly")).not.toMatch(
      /aria-label="Move Rivals monthly down"[^>]*disabled/
    );
    expect(rowFor(markup, "Summer league")).toMatch(
      /aria-label="Move Summer league down"[^>]*disabled/
    );
  });

  it("offers them on a hidden template too — a kept setup stays where it was", () => {
    const markup = render([HIDDEN, USED]);
    expect(rowFor(markup, "Summer league")).toContain('aria-label="Move Summer league down"');
  });
});

/* ------------------------------------------------------------------ */
/* 8a: deleting one                                                   */
/* ------------------------------------------------------------------ */

describe("what the screen says about deleting a used template (UC-28 8a)", () => {
  it("promises the events keep working, and names how many there are", () => {
    const warning = templateDeleteWarning(4);

    expect(warning).toContain("4 events");
    expect(warning).toMatch(/keep working/);
    expect(warning).toMatch(/copied into an event and then forgotten/);
    // The only loss, stated: the provenance note, not the event.
    expect(warning).toMatch(/where they came from/);
  });

  it("does not claim an event is deleted, changed or lost with it", () => {
    // `deleteTemplate` keeps every event (`on delete set null`), so copy
    // saying otherwise would talk an admin out of a safe action — the same
    // failure `question-copy.test.ts` guards one screen over.
    for (const text of [templateDeleteWarning(0), templateDeleteWarning(1), templateDeleteWarning(9)]) {
      expect(text).not.toMatch(
        /\bevents?\b[^.]{0,60}\b(?:are|is|will be|would be|gets?)\s+(?:deleted|removed|lost|cancelled)/i
      );
      expect(text).not.toMatch(
        /\b(?:deletes?|deleting|removes?|removing|cancels?)\b[^.]{0,40}\bevents?\b/i
      );
    }
  });

  it("says nothing depends on a template nobody has used", () => {
    expect(templateDeleteWarning(0)).toMatch(/nothing depends on it/);
    expect(templateDeleteWarning(0)).not.toContain("0 events");
  });

  it("counts one event as one, and agrees with it", () => {
    /*
     * The numeral was asserted here and the verb was not, so "1 event were
     * made from this template and all of them keep working" was green — on the
     * delete confirm *and* on the card, where the admin reads it before
     * clicking anything. `plural` counts; it does not conjugate, and a test
     * that only reads the count cannot see the difference.
     *
     * So the whole clause is pinned, both numbers, and the plural one with it:
     * a future edit that drops the branch fails here rather than shipping.
     */
    expect(templateDeleteWarning(1)).toContain(
      "1 event was made from this template and it keeps working"
    );
    expect(templateDeleteWarning(1)).not.toContain("1 events");
    expect(templateDeleteWarning(1)).not.toMatch(/\b1 event\b[^.]*\bwere\b/);
    expect(templateDeleteWarning(1)).not.toMatch(/\ball of them\b/);

    expect(templateDeleteWarning(4)).toContain(
      "4 events were made from this template and all of them keep working"
    );
  });

  it("points at deactivating, which is the one that keeps the template", () => {
    expect(DEACTIVATE_INSTEAD).toMatch(/keeps the setup for next season/);
  });

  it("keeps the delete off the collapsed row, where the arrows live", () => {
    // The row an admin scans down offers the two reversible things — move it,
    // copy it — and nothing that cannot be undone. Deleting is two deliberate
    // steps away: open the card, then confirm.
    const markup = render([USED]);

    expect(markup).toContain('aria-label="Move Rivals monthly down"');
    expect(markup).toContain("Duplicate");
    expect(markup).not.toContain("Delete template");
  });
});
