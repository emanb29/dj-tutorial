import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the built app (`vite preview`) and the API server.
// They use ports 4179/4180, not the dev ports 5179/5180, so they never clash with
// a running dev server. Build first: `npm run test:e2e` does.
const PREVIEW_PORT = 4179;
const API_PORT = 4180;
const previewUrl = `http://127.0.0.1:${String(PREVIEW_PORT)}`;
const isCi = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Tests never play sound through the speakers.
        launchOptions: { args: ["--mute-audio"] },
      },
    },
  ],
  webServer: [
    {
      command: "npm run start:api",
      env: { API_PORT: String(API_PORT) },
      url: `http://127.0.0.1:${String(API_PORT)}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
      env: { API_PORT: String(API_PORT) },
      url: previewUrl,
      reuseExistingServer: false,
    },
  ],
});
