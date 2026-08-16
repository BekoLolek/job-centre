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
    env: {
      TZ: "Europe/Budapest",
    },
  },
});
