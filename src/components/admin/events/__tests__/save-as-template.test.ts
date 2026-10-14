import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * Nothing here calls a server action — the control is rendered, not driven —
 * but importing the editor imports every panel, and every panel imports its
 * `"use server"` module. Those reach `@/lib/auth` and `next/server`, neither of
 * which loads outside a Next request. Replaced exactly as
 * `src/app/admin/host/__tests__/decisions.test.ts` replaces them, and for the
 * same reason.
 */
vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => null,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const { SaveAsTemplate, showsSaveAsTemplate } = await import("../EventEditor");

/*
 * "Save as template" in the event editor (R-22 / UC-08 10a:
 * "Manager saves the setup as a template (admin only) — System stores a
 * template with a name").
 *
 * The bracket is the whole test. Every screen in `/admin/events/[id]` is
 * reachable by a **host** as well as an admin — `requireEventManager` is the
 * door, and it lets a host through for the one event they were given — so a
 * control placed in that editor is placed in front of two different readers.
 * A template changes what every future event starts from, which is not a
 * host's decision to make.
 *
 * `createTemplateFromEventAction` is the refusal that counts (`requireAdmin()`,
 * and the row it writes is a new template, so there is no event row to
 * authorise against — see the component's docblock). This file covers the
 * other half: that a host is never shown the button in the first place.
 */

/** The control as the editor renders it, markup and all. */
function render(isAdmin: boolean | undefined): string {
  return renderToStaticMarkup(
    createElement(SaveAsTemplate, {
      eventId: "11111111-1111-1111-1111-111111111111",
      title: "Rivals Winter Cup",
      isAdmin,
    })
  );
}

describe("who is offered Save as template (UC-08 10a)", () => {
  it("offers it to an admin", () => {
    expect(showsSaveAsTemplate(true)).toBe(true);
  });

  it("does not offer it to a host, who manages one event and mints nothing", () => {
    expect(showsSaveAsTemplate(false)).toBe(false);
  });

  it("does not offer it when nobody said who is reading", () => {
    // A caller that has not been told hides an admin control rather than
    // showing one. Failing open here would hand every host the button.
    expect(showsSaveAsTemplate(undefined)).toBe(false);
  });
});

describe("what the editor actually renders (UC-08 10a)", () => {
  it("renders the control for an admin", () => {
    expect(render(true)).toContain("Save as template");
  });

  it("renders nothing whatsoever for a host", () => {
    // The component, not the predicate: both of the sentences above are true
    // however the component hands them out, and handing them out the wrong way
    // round is the defect this is written for.
    expect(render(false)).toBe("");
  });

  it("renders nothing when the caller passed no reader at all", () => {
    expect(render(undefined)).toBe("");
  });
});

describe("what the control promises an admin (UC-08 10a)", () => {
  it("says what it is for, on the button and beside it", () => {
    // The opened state — name field, "Make template", the omissions list — is
    // behind a click, and a Node render has nothing to click with. What is
    // pinned here is the closed state: the offer, and the sentence saying the
    // next event of this shape starts from this one.
    const markup = render(true);
    expect(markup).toContain("Save as template");
    expect(markup).toContain("Starts the next event of this shape");
  });
});

/*
 * ## What this file cannot reach
 *
 * The control's open state — the name field, "Make template", the omissions
 * list and the error alert — is behind a click, and `environment: "node"` has
 * nothing to click with. Nor can the editor be rendered whole: every panel
 * calls `useRouter()`, and there is no App Router to mount outside a browser,
 * so the assertions above are made against the control itself rather than
 * against the header it sits in.
 *
 * That the button refuses while a panel is dirty is the `useNavigationLock`
 * path, covered as a decision in `unsaved-changes.test.ts`; that this control
 * is wired to it is wiring, and only the browser pass can show it.
 */
