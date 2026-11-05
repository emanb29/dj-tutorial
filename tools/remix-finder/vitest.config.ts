import { defineConfig } from "vitest/config";

// Its own suite: the app's vitest.config.ts never includes tools/.
export default defineConfig({
  // The app's analysis code imports @shared/…; tsconfig.json maps it.
  resolve: { tsconfigPaths: true },
  test: { name: "remix-finder", environment: "node", include: ["src/**/*.test.ts"] },
});
