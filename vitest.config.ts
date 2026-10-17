import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const outsideTheBuild = ["prototypes/**", "spikes/**", "node_modules/**", "dist/**", "e2e/**"];

export default defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    // Declared up front: if Vite discovers a dependency mid-run it re-optimizes and reloads the
    // browser tests, which fails them in CI ("Vite unexpectedly reloaded a test").
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
    // onnxruntime-web finds its WASM threads relative to its own module, which pre-bundling breaks.
    exclude: ["onnxruntime-web"],
  },
  worker: { format: "es" },
  // Cross-origin isolation, as in vite.config.ts, so the analysis worker gets its 4 WASM threads.
  server: {
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["{src,shared,server,scripts}/**/*.test.{ts,tsx}"],
          exclude: [...outsideTheBuild, "**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["{src,shared}/**/*.browser.test.{ts,tsx}"],
          exclude: outsideTheBuild,
          browser: {
            enabled: true,
            headless: true,
            // --mute-audio: tests never play sound through the speakers.
            provider: playwright({ launchOptions: { args: ["--mute-audio"] } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
