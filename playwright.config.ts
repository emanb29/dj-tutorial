import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the built app (`vite preview`) and the API server.
// They use ports 4179/4180 (and 4181/4182 for the Originals player) by default, not the dev
// ports 5179/5180, so they never clash with a running dev server; E2E_APP_PORT, E2E_API_PORT,
// E2E_ORIGINALS_APP_PORT and E2E_ORIGINALS_API_PORT move them, so parallel runs don't collide.
// Build first: `npm run test:e2e` does.
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name}=${raw} is not a usable port; set it to a whole number from 1024 to 65535, or unset it for ${String(fallback)}.`);
  }
  return port;
}
const PREVIEW_PORT = portFromEnv("E2E_APP_PORT", 4179);
const API_PORT = portFromEnv("E2E_API_PORT", 4180);
const previewUrl = `http://127.0.0.1:${String(PREVIEW_PORT)}`;
const isCi = process.env["CI"] !== undefined;
// The API keeps profiles in a throwaway folder (never the maintainer's .local/data) and serves no Originals.
const e2eData = join(tmpdir(), `dj-tutorial-e2e-${String(process.pid)}`);
// The Originals player has its own API and preview (4182/4181), serving a tiny fixture folder that
// e2e/originals.spec.ts writes and changes, so the Lessons never pick up those tracks. Set once, in
// the runner, so the workers (which re-read this file) inherit the same folder.
const ORIGINALS_PREVIEW_PORT = portFromEnv("E2E_ORIGINALS_APP_PORT", 4181);
const ORIGINALS_API_PORT = portFromEnv("E2E_ORIGINALS_API_PORT", 4182);
const originalsUrl = `http://127.0.0.1:${String(ORIGINALS_PREVIEW_PORT)}`;
// e2e/originals.spec.ts reads its base URL from here.
process.env["E2E_ORIGINALS_BASE_URL"] = originalsUrl;
process.env["E2E_ORIGINALS_DIR"] ??= join(tmpdir(), `dj-tutorial-e2e-originals-${String(process.pid)}`);
const e2eOriginals = process.env["E2E_ORIGINALS_DIR"];

// Never the maintainer's music library from .env: empty values win over .env and mean none.
// e2e/music-folder.spec.ts stands in for the server's library itself.
const NO_MUSIC_LIBRARY = { MUSIC_DIR: "", REKORDBOX_XML: "" };

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
      // The preview's origin, whichever port it is on, is the one the API accepts writes from.
      // Every test makes a fresh Learner (a first run is one with no profile): room for all of them.
      env: { API_PORT: String(API_PORT), ALLOWED_ORIGINS: previewUrl, DATA_DIR: join(e2eData, "data"), ORIGINALS_DIR: join(e2eData, "originals"), MAX_LEARNERS: "1000", ...NO_MUSIC_LIBRARY },
      url: `http://127.0.0.1:${String(API_PORT)}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
      env: { API_PORT: String(API_PORT) },
      url: previewUrl,
      reuseExistingServer: false,
    },
    {
      command: "npm run start:api",
      env: {
        API_PORT: String(ORIGINALS_API_PORT),
        ALLOWED_ORIGINS: originalsUrl,
        DATA_DIR: join(e2eOriginals, "data"),
        ORIGINALS_DIR: join(e2eOriginals, "originals"),
        ...NO_MUSIC_LIBRARY,
      },
      url: `http://127.0.0.1:${String(ORIGINALS_API_PORT)}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --port ${String(ORIGINALS_PREVIEW_PORT)} --strictPort`,
      env: { API_PORT: String(ORIGINALS_API_PORT) },
      url: originalsUrl,
      reuseExistingServer: false,
    },
  ],
});
