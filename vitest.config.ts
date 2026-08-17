import path from "node:path";
import { defineConfig } from "vitest/config";

// Several helpers format or parse times in the ambient zone, so the suite pins one.
// Must be set before the worker threads read it.
process.env.TZ = "Europe/Budapest";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // Several files stand up their own in-memory Postgres in `beforeAll`
    // (`freshDatabase()`), and PGlite is a WASM build that has to boot and then
    // apply every migration. One at a time that is well under a second; a dozen
    // workers doing it at once on a cold cache is not, and the 10s default
    // starts failing hooks that are not actually broken.
    hookTimeout: 60_000,
    env: {
      TZ: "Europe/Budapest",
    },
  },
});
