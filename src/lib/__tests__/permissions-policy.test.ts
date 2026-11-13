import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POWERS, PRESETS, type Power, assertPower, holds, isPower } from "@/lib/permissions-policy";

/**
 * The vocabulary, the presets, and "may they" — with no database (R-261, R-262,
 * R-264 / UC-55).
 *
 * Everything here is asserted **name by name**. A count would pass under a
 * mutation that swapped one power for another, and swapping `audit.read` for
 * `settings.integrations` in a preset is exactly the mistake this file is for.
 */

const nobody = { isAdmin: false, powers: new Set<Power>() };
const admin = { isAdmin: true, powers: new Set<Power>() };

describe("the vocabulary", () => {
  it("is the fourteen names the owner approved, and no others", () => {
    expect([...POWERS]).toEqual([
      "events.create",
      "events.manage",
      "announce.post",
      "settings.announcements",
      "settings.integrations",
      "games.manage",
      "templates.manage",
      "championships.manage",
      "polls.manage",
      "suggestions.moderate",
      "hosts.approve",
      "members.read",
      "audit.read",
      "destructive",
    ]);
  });

  it("cannot be added to at runtime", () => {
    expect(Object.isFrozen(POWERS)).toBe(true);
  });
});

describe("the presets", () => {
  it("are the four the owner named", () => {
    expect(Object.keys(PRESETS)).toEqual(["Organiser", "Announcer", "Moderator", "Curator"]);
  });

  it("Organiser is events, announcing by hand, and championships", () => {
    expect([...PRESETS.Organiser]).toEqual([
      "events.create",
      "events.manage",
      "announce.post",
      "championships.manage",
    ]);
  });

  it("Announcer is announcing by hand and the announcement settings", () => {
    expect([...PRESETS.Announcer]).toEqual(["announce.post", "settings.announcements"]);
  });

  it("Moderator is polls, suggestions, the member list and the audit log", () => {
    expect([...PRESETS.Moderator]).toEqual([
      "polls.manage",
      "suggestions.moderate",
      "members.read",
      "audit.read",
    ]);
  });

  it("Curator is games and templates", () => {
    expect([...PRESETS.Curator]).toEqual(["games.manage", "templates.manage"]);
  });

  it("cannot be edited at runtime, the record or any list in it", () => {
    expect(Object.isFrozen(PRESETS)).toBe(true);
    expect(Object.values(PRESETS).map((powers) => Object.isFrozen(powers))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("holds", () => {
  it.each([...POWERS])("a member with no powers does not hold %s", (power) => {
    expect(holds(nobody, power)).toBe(false);
  });

  it.each([...POWERS])("an admin with no powers holds %s", (power) => {
    expect(holds(admin, power)).toBe(true);
  });

  it("a member holds the power they were given", () => {
    expect(holds({ isAdmin: false, powers: new Set<Power>(["polls.manage"]) }, "polls.manage")).toBe(true);
  });

  it("a member does not hold a power beside the one they were given", () => {
    expect(holds({ isAdmin: false, powers: new Set<Power>(["polls.manage"]) }, "audit.read")).toBe(false);
  });

  it("refuses a question about a power that does not exist, and names it", () => {
    expect(() => holds(nobody, "polls.destroy" as Power)).toThrow(/"polls\.destroy"/);
  });

  // R-264 / UC-55 5a: there is no power that grants powers, so even the one
  // holder who has everything cannot be asked about it.
  it("refuses an admin a power that does not exist, rather than saying yes", () => {
    expect(() => holds(admin, "permissions.grant" as Power)).toThrow(/"permissions\.grant"/);
  });

  // The type says a list cannot contain this; the cast is the hostile case,
  // a list built by something that did not go through `powersOf`. Even then a
  // name outside the vocabulary must not become a power by being asked for.
  it("refuses a made-up power even when the holder's list contains it", () => {
    const holder = { isAdmin: false, powers: new Set(["permissions.grant" as Power]) };
    expect(() => holds(holder, "permissions.grant" as Power)).toThrow(/"permissions\.grant"/);
  });
});

describe("isPower", () => {
  it.each([...POWERS])("says yes to %s", (power) => {
    expect(isPower(power)).toBe(true);
  });

  it("says no to a name outside the vocabulary", () => {
    expect(isPower("permissions.grant")).toBe(false);
  });

  // `"constructor" in {}` is true: a lookup against a plain object would let
  // every inherited property name through as a power.
  it("says no to a name that is only a property of every object", () => {
    expect(isPower("constructor")).toBe(false);
  });
});

describe("assertPower", () => {
  it("lets a power in the vocabulary through", () => {
    expect(() => assertPower("audit.read")).not.toThrow();
  });

  it("refuses a name that is not in it, and names it", () => {
    expect(() => assertPower("audit.write")).toThrow(/"audit\.write"/);
  });

  it("refuses a name that is only a property of every object", () => {
    expect(() => assertPower("constructor")).toThrow(/"constructor"/);
  });
});

describe("the module itself", () => {
  /*
   * A client component will import this file to draw the ticks (UC-55 2), and
   * anything it imports comes with it — one `@/db` and PGlite is in the
   * browser bundle. The module needs nothing from anywhere, so the rule is the
   * strictest one that is true: it imports nothing at all.
   *
   * Any line that begins with `import`, so the bare `import "@/db";` — which
   * has no `from` and is enough on its own — is caught with the rest; then a
   * re-export, which is an import by another name; then the two call forms.
   */
  it("imports nothing, so it can never reach a database", () => {
    const source = readFileSync(path.resolve(__dirname, "../permissions-policy.ts"), "utf8");
    expect(
      source.match(/^\s*import\b|^\s*export\b[^;]*\bfrom\s*["']|\bimport\s*\(|\brequire\s*\(/gm)
    ).toBeNull();
  });
});
