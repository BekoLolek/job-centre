import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Several helpers format or parse times in the ambient zone, so the suite pins one.
// Must be set before the worker threads read it.
process.env.TZ = "Europe/Budapest";

/**
 * The one test file that is not safe to run beside the others.
 *
 * Everything else stands its database up in memory; this file also writes one
 * to a real temporary directory and reopens it, so it is doing filesystem work
 * — on Windows, behind whatever the machine's indexer and antivirus are doing
 * to those same files — while a dozen workers boot their own WASM Postgres
 * around it. Alone the file costs about 25 seconds; under the parallel pool the
 * reopen test alone was measured at 64 seconds, seven times its solo cost, and
 * timed out against a budget set at twice that cost.
 *
 * Raising the budget again would only be a bigger bet on the contention factor.
 * Removing the contention is the fix, and it is the cheaper one: the file runs
 * on its own, so its solo cost *is* its cost, and the budget below can be sized
 * from a measurement instead of a guess.
 */
const SERIAL_TESTS = "src/db/__tests__/migrations.test.ts";

/*
 * The same argument, for a second kind of expensive file.
 *
 * These four compile `src/app/globals.css` with the real Tailwind config over
 * the real `src/**` content globs, because what they assert is the *emitted*
 * stylesheet — which rule wins, which class survived the purge — and nothing
 * short of a real compile answers that. Solo each is about two seconds. A
 * dozen workers each running a Tailwind build at once is not, and
 * `dead-names.test.ts` was failing its 5s budget on a timeout rather than an
 * assertion: a green test reported red by contention, which is the exact
 * failure `migrations.test.ts` already has this treatment for.
 *
 * Raising the budget instead would have hidden it rather than fixed it, and
 * would have had to be sized against the worst parallel case rather than the
 * real cost of the work.
 */
const STYLESHEET_TESTS = [
  "src/app/__tests__/dead-names.test.ts",
  "src/components/ui/__tests__/checkbox-hit-area.test.ts",
  "src/components/ui/__tests__/eyebrow-colour.test.ts",
  "src/components/ui/__tests__/field-ordering.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Several files stand up their own in-memory Postgres in `beforeAll`
    // (`freshDatabase()`), and PGlite is a WASM build that has to boot and then
    // apply every migration. One at a time that is well under a second; a dozen
    // workers doing it at once on a cold cache is not, and the 10s default
    // starts failing hooks that are not actually broken.
    hookTimeout: 60_000,
    env: {
      TZ: "Europe/Budapest",
    },
    /*
     * Two projects, both inheriting everything above, differing only in which
     * files they take and whether those files may share the machine.
     *
     * `fileParallelism: false` resolves to `maxWorkers: 1` for that project,
     * and vitest puts a single-worker project in a group of its own that runs
     * once the parallel groups are done — so `migrations` gets the machine to
     * itself at the end of the run rather than slowing the other 40-odd files
     * down for the whole of it.
     *
     * `include` is spelled out per project rather than inherited from above:
     * `extends` merges arrays by concatenating them, so an inherited pattern
     * would be added to the narrow one rather than replaced by it, and both
     * projects would end up running every file.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          include: ["src/**/__tests__/**/*.test.ts"],
          exclude: [...configDefaults.exclude, SERIAL_TESTS, ...STYLESHEET_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "migrations",
          include: [SERIAL_TESTS],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "stylesheet",
          include: STYLESHEET_TESTS,
          fileParallelism: false,
        },
      },
    ],
  },
});
