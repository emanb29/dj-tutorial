import { defineConfig } from "vitest/config";

// Its own suite: the app's vitest.config.ts never includes tools/.
export default defineConfig({
  test: { name: "library-enrichment", environment: "node", include: ["src/**/*.test.ts"] },
});
