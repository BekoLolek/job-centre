/**
 * A server component may not call a value exported from a `"use client"` module.
 *
 * ## The failure this exists for, which production found first
 *
 * `src/app/admin/settings/page.tsx` imported `posted` from
 * `src/components/admin/AnnouncementSettings.tsx` and called it. That file is
 * `"use client"`, so **everything it exports is a client reference**: the server
 * does not receive the function, it receives a marker React can render as a
 * component or pass as a prop. Calling it throws, on the deployed page, for
 * every admin who opens Settings:
 *
 *     Error: Attempted to call posted() from the server but posted is on the
 *     client. It's not possible to invoke a client function from the server…
 *
 * **Nothing in this repo caught it.** `tsc --noEmit` sees two ordinary exports
 * of compatible types. `next build` compiles both sides without complaint — the
 * boundary is a runtime contract, not a type. And the whole suite renders
 * components directly in a node environment where there is no server/client
 * split at all, so every test of that page and that component passed. The first
 * thing that knew was Vercel's log.
 *
 * `posted` was one pure line with no state, which is what made it easy: purity
 * is not the test. **The directive at the top of the file is the test**, and
 * that is a fact about a file, which is why this is a sweep rather than a
 * behaviour.
 *
 * ## What is and is not allowed
 *
 * A **default** import is fine and is the normal case — that is a component,
 * which is exactly what the boundary is for. A **type-only** import is fine:
 * types are erased and never reach either runtime.
 *
 * What fails is a **named value** import, because that is the shape that gets
 * called. A server file that needs such a value imports it from a module with
 * no directive, which both sides may use — see
 * `src/components/admin/announcement-posting.ts`, which exists for that reason.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Forward slashes throughout: `walk` normalises what it returns, and on Windows
// `path.resolve` does not, so a set built from one and queried with the other
// never matches. The canary below is what caught that.
const SRC = path.resolve(__dirname, "../..").replace(/\\/g, "/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full.replace(/\\/g, "/")] : [];
  });
}

const FILES = walk(SRC);

/** `"use client"` has to be the first statement, so only the head matters. */
function isClientModule(file: string): boolean {
  return /^\s*["']use client["']/.test(readFileSync(file, "utf8").slice(0, 200));
}

const CLIENT = new Set(FILES.filter(isClientModule));

/** Resolve an import specifier the way the bundler does, `@/` alias included. */
function resolve(importer: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(importer), spec);
  else return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const candidate = (base + ext).replace(/\\/g, "/");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type Offence = { importer: string; target: string; names: string[] };

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const file of FILES) {
    // A client module importing from another client module is not this bug,
    // and a test file is not shipped to either runtime.
    if (CLIENT.has(file) || file.includes("/__tests__/")) continue;
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(/import\s+(?!type\b)([^;]+?)\s+from\s+["']([^"']+)["']/g);
    for (const [, clause, spec] of imports) {
      const target = resolve(file, spec);
      if (!target || !CLIENT.has(target)) continue;
      const braced = /\{([^}]*)\}/.exec(clause);
      if (!braced) continue; // a default import is a component — the allowed case
      const names = braced[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !name.startsWith("type "));
      if (names.length > 0) {
        found.push({ importer: path.relative(SRC, file).replace(/\\/g, "/"), target, names });
      }
    }
  }
  return found;
}

describe("the server/client boundary", () => {
  /*
   * The floors. A sweep that matched nothing would pass this file silently,
   * which is the failure mode every other sweep in this repo has had to be
   * guarded against — so the corpus is asserted to be real before anything is
   * concluded from its emptiness.
   */
  it("is looking at the whole of src, and finds the client modules in it", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(150);
    expect(CLIENT.size).toBeGreaterThanOrEqual(50);
  });

  /*
   * And the resolver is asserted to work, in both directions, against the two
   * files this bug was actually about. Without this, a resolver that returned
   * null for everything would report a clean sweep for ever.
   */
  it("recognises a client module, and does not mistake a plain one for it", () => {
    const settings = `${SRC}/components/admin/AnnouncementSettings.tsx`;
    const pure = `${SRC}/components/admin/announcement-posting.ts`;
    expect(CLIENT.has(settings), "AnnouncementSettings.tsx is a client module").toBe(true);
    expect(CLIENT.has(pure), "announcement-posting.ts carries no directive").toBe(false);
    expect(resolve(`${SRC}/app/admin/settings/page.tsx`, "@/components/admin/AnnouncementSettings")).toBe(
      settings
    );
  });

  it("is never crossed by a value a server file could call", () => {
    const crossings = offences();
    const detail = crossings
      .map((o) => `  ${o.importer}\n    imports { ${o.names.join(", ")} } from ${o.target}`)
      .join("\n");
    expect(
      crossings,
      crossings.length === 0
        ? ""
        : `A server or shared file imports a named value from a "use client" module. ` +
            `Calling it throws at runtime on the deployed page, and nothing else here catches that — ` +
            `not tsc, not next build, not a component test. Move the value into a module with no ` +
            `directive, as src/components/admin/announcement-posting.ts does.\n${detail}`
    ).toEqual([]);
  });
});
