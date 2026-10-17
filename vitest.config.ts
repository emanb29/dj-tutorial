import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const outsideTheBuild = ["prototypes/**", "spikes/**", "node_modules/**", "dist/**", "e2e/**"];

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["{src,shared,server}/**/*.test.{ts,tsx}"],
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
