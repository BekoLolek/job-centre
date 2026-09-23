import { describe, expect, it } from "vitest";
import { ADMIN_SECTIONS } from "../AdminNav";

/**
 * What the admin bar admits the admin area contains.
 *
 * UC-07 1 is "Admin opens the availability view", and UC-21 1 is "Admin opens
 * the host application". Both pages existed and neither was in this bar — they
 * were reachable only from the account menu, which is the narrow-screen
 * fallback, so on a desktop the first step of two use cases was a step nobody
 * could take. That is the whole of this file: a list, and the two entries that
 * were missing from it.
 *
 * Only the list is tested. Rendering it needs `usePathname`, and the component
 * is otherwise seven lines of Link — there is no component-test setup in this
 * repo (node environment, no jsdom), and the part worth pinning has nothing to
 * do with rendering anyway.
 */

describe("the admin bar's sections", () => {
  const hrefs = ADMIN_SECTIONS.map((section) => section.href);

  it("links the availability view (UC-07 1)", () => {
    expect(hrefs).toContain("/admin/availability");
  });

  it("links the host queue (UC-21 1)", () => {
    expect(hrefs).toContain("/admin/host");
  });

  it("still links everything it linked before", () => {
    for (const href of [
      "/admin",
      "/admin/events",
      "/admin/championships",
      "/admin/templates",
      "/admin/games",
      "/admin/users",
      "/admin/audit",
      "/admin/settings",
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it("lights only itself, never every link at once", () => {
    /*
     * `/admin` is a prefix of every other href here, so it is the one entry
     * that has to match exactly — without that flag the bar lights "Tonight"
     * on every admin page, and an always-lit link tells the reader nothing.
     */
    const home = ADMIN_SECTIONS.find((section) => section.href === "/admin");
    expect(home && "exact" in home && home.exact).toBe(true);
    expect(
      ADMIN_SECTIONS.filter((section) => "exact" in section && section.exact)
    ).toHaveLength(1);
  });

  it("names each section once", () => {
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const labels = ADMIN_SECTIONS.map((section) => section.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
