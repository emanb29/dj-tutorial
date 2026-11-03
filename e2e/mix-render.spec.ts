import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newMixPlan } from "../shared/mix-plan-recipes.ts";
import { mixPlanFileText } from "../shared/mix-plan-file.ts";
import type { PlanGrid } from "../shared/mix-plan.ts";
import { hashTrackBytes } from "../shared/track-hash.ts";
import { ensureProfile, learner } from "./lesson-support.ts";

// The Render (ISS-190) end to end: a two-track plan over the Learner's own files, rendered, cancelled
// and rendered again from the keyboard (LOAD A), then downloaded as WAV and MP3. The folder picker
// is replaced (init script) by an in-memory folder of two synthetic 30-second tracks written here,
// with a hand-written rekordbox.xml for their grids, so no real music is involved and nothing is analysed.

const RATE = 44_100;
const SECONDS = 30;
const NAMES = ["Test Signal - Pulse 120.wav", "Test Signal - Pulse 124.wav"] as const;
const BPMS = [120, 124] as const;

/** A mono 16-bit WAV: a kick on every beat (first beat at 0.05 s) and a held tone, `hz`. */
function synthTrack(bpm: number, hz: number): Buffer {
  const frames = SECONDS * RATE;
  const data = Buffer.alloc(44 + frames * 2);
  const beat = 60 / bpm;
  for (let index = 0; index < frames; index++) {
    const time = index / RATE;
    const sinceBeat = (time - 0.05 + beat) % beat;
    const kick = time < 0.05 ? 0 : 0.5 * Math.exp(-sinceBeat * 18) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-sinceBeat * 30)) * sinceBeat);
    const sample = kick + 0.12 * Math.sin((2 * Math.PI * hz * index) / RATE);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), 44 + index * 2);
  }
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(frames * 2, 40);
  return data;
}

const rekordboxXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
${NAMES.map(
  (name, index) =>
    `    <TRACK Name="Pulse ${String(BPMS[index])}" Artist="Test Signal" Genre="Test" AverageBpm="${String(BPMS[index])}.00" TotalTime="${String(SECONDS)}" Location="file://localhost/Users/dj/Music/${encodeURIComponent(name)}"><TEMPO Inizio="0.05" Bpm="${String(BPMS[index])}.00" Metro="4/4" Battito="1"/></TRACK>`,
).join("\n")}
  </COLLECTION>
</DJ_PLAYLISTS>`;

/** A cut on the 1 from track 1 to track 2, made the way the Mix plans page makes plans, by content hash. */
async function planFile(tracks: readonly Buffer[]): Promise<string> {
  const grids: PlanGrid[] = BPMS.map((bpm) => ({ bpm, firstBeatSec: 0.05, downbeatPhase: 0, durationSec: SECONDS }));
  const picked = await Promise.all(
    tracks.map(async (bytes, index) => ({
      track: { contentHash: await hashTrackBytes(bytes, SECONDS), fileName: NAMES[index] ?? "", durationMs: SECONDS * 1000, title: `Pulse ${String(BPMS[index])}`, artist: "Test Signal" },
      grid: grids[index] ?? grids[0] ?? { bpm: 120, firstBeatSec: 0, downbeatPhase: 0, durationSec: SECONDS },
    })),
  );
  return mixPlanFileText(newMixPlan({ id: "e2e-render", name: "Render check", now: "2026-11-03T12:00:00.000Z", picked, recipe: "cut-on-the-1" }));
}

/** Replaces the folder picker with an in-memory folder whose files the page fetches from a route this test answers. */
async function stubFolder(page: Page, files: Readonly<Record<string, Buffer | string>>): Promise<void> {
  await page.route("**/__e2e-folder/**", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const body = files[name];
    return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ status: 200, body: typeof body === "string" ? Buffer.from(body) : body });
  });
  await page.addInitScript((names: string[]) => {
    const entries = names.map((name, index) => ({ name, lastModified: 1_700_000_000_000 + index * 1000 }));
    const root = {
      kind: "directory",
      name: "Music",
      async *values() {
        for (const entry of entries) {
          yield await Promise.resolve({
            kind: "file",
            name: entry.name,
            getFile: async () => new File([await (await fetch(`/__e2e-folder/${encodeURIComponent(entry.name)}`)).blob()], entry.name, { lastModified: entry.lastModified }),
          });
        }
      },
      queryPermission: () => Promise.resolve("granted"),
      requestPermission: () => Promise.resolve("granted"),
    };
    Object.assign(window, { showDirectoryPicker: () => Promise.resolve(root) });
  }, Object.keys(files));
}

declare global {
  interface Window {
    __renderFlx4?: { send(bytes: number[]): void };
  }
}

/** A DDJ-FLX4 with no hardware: navigator.requestMIDIAccess replaced before the app loads, as e2e/hardware.spec.ts does. */
async function fakeFlx4(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const input = Object.assign(new EventTarget(), { id: "in-flx4", name: "DDJ-FLX4", type: "input", state: "connected" });
    const output = { id: "out-flx4", name: "DDJ-FLX4", type: "output", state: "connected", send: () => undefined };
    const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]) });
    Object.defineProperty(navigator, "requestMIDIAccess", { value: () => Promise.resolve(access), configurable: true });
    const query = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, "query", {
      value: (descriptor: { name: string }) => (descriptor.name === "midi" ? Promise.resolve({ state: "granted" }) : query(descriptor as PermissionDescriptor)),
      configurable: true,
    });
    window.__renderFlx4 = {
      send(bytes) {
        const event = new Event("midimessage");
        Object.defineProperties(event, { data: { value: new Uint8Array(bytes) }, timeStamp: { value: performance.now() } });
        input.dispatchEvent(event);
      },
    };
  });
}

/** LOAD A pressed and released (AlphaTheta's list: note 0x46 on channel 7). */
const loadA = (page: Page) =>
  page.evaluate(() => {
    window.__renderFlx4?.send([0x96, 0x46, 0x7f]);
    window.__renderFlx4?.send([0x96, 0x46, 0x00]);
  });

test("Mix plans: render a two-track plan from the Learner's own files, cancel, render again by LOAD A, and download it", async ({ page }) => {
  test.setTimeout(120_000);
  const tracks = [synthTrack(BPMS[0], 220), synthTrack(BPMS[1], 330)];
  await stubFolder(page, { [NAMES[0]]: tracks[0] ?? Buffer.alloc(0), [NAMES[1]]: tracks[1] ?? Buffer.alloc(0), "rekordbox.xml": rekordboxXml() });
  await fakeFlx4(page);
  const id = learner("mix-render");
  await ensureProfile(page, id);
  await page.goto(`/?learner=${id}`);
  await page.getByRole("link", { name: "Controller" }).click();
  const folder = page.getByRole("region", { name: "Music folder" });
  await folder.getByRole("button", { name: "Pick a folder" }).click();
  await expect(folder.getByTestId("rekordbox-status")).toHaveText("rekordbox: matched 2 of 2");
  await page.getByRole("button", { name: /Lessons/ }).click();
  await page.getByRole("button", { name: "Mix plans" }).click();

  await page.getByLabel("Upload a plan").setInputFiles({ name: "render-check.mixplan.json", mimeType: "application/json", buffer: Buffer.from(await planFile(tracks)) });
  await page.locator("li[data-plan]", { hasText: "Render check" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("No problems found.")).toBeVisible();
  const render = page.getByRole("region", { name: "Render" });
  // 16 s of track 1, then all of track 2 (29.95 s, stretched to 120 BPM: 30.95 s), and the tail.
  await expect(render).toContainText("0:47 · WAV 8 MB, MP3 2 MB");

  // Start, then cancel: nothing is kept.
  await render.getByRole("button", { name: "Render the set" }).click();
  await expect(render.getByRole("progressbar", { name: "Render progress" })).toBeVisible();
  await render.getByRole("button", { name: "Cancel" }).click();
  await expect(render.getByRole("status")).toHaveText("Cancelled. Nothing was kept.");

  // LOAD A on the FLX4, with nothing ringed, presses the page's default: Render again, through to the end.
  await expect(render.getByRole("button", { name: "Render again" })).toContainText("LOAD A");
  await loadA(page);
  await expect(render.getByRole("status").first()).toContainText("Rendered 0:47", { timeout: 90_000 });
  await expect(render).toContainText("not normalised");
  await expect(render).toContainText("Master Tempo on: every track keeps its key at the set's tempo.");

  const wavDownload = page.waitForEvent("download");
  await render.getByRole("link", { name: /Download WAV/ }).click();
  const wav = await readFile(await (await wavDownload).path());
  expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
  expect(wav.readUInt32LE(24)).toBe(RATE);
  // 16-bit stereo: the data is 4 bytes a frame, about 47 s of them.
  const seconds = wav.readUInt32LE(40) / 4 / RATE;
  expect(seconds).toBeGreaterThan(46.5);
  expect(seconds).toBeLessThan(47.5);
  expect(wav.length).toBe(44 + wav.readUInt32LE(40));

  const mp3Link = render.getByRole("link", { name: /Download MP3/ });
  if ((await mp3Link.count()) === 0) {
    // CI installs ffmpeg for this; without it the page says why.
    await expect(render).toContainText("MP3: ");
    return;
  }
  const mp3Download = page.waitForEvent("download");
  await mp3Link.click();
  const mp3 = await readFile(await (await mp3Download).path());
  expect(mp3.subarray(0, 3).toString("ascii")).toBe("ID3");
  expect(mp3.length).toBeGreaterThan(1_000_000);
});

test("Mix plans: a plan whose track is missing says which file to find before it renders", async ({ page }) => {
  const tracks = [synthTrack(BPMS[0], 220), synthTrack(BPMS[1], 330)];
  // Only track 1 is in the folder.
  await stubFolder(page, { [NAMES[0]]: tracks[0] ?? Buffer.alloc(0), "rekordbox.xml": rekordboxXml() });
  const id = learner("mix-render-missing");
  await ensureProfile(page, id);
  await page.goto(`/?learner=${id}`);
  await page.getByRole("link", { name: "Controller" }).click();
  const folder = page.getByRole("region", { name: "Music folder" });
  await folder.getByRole("button", { name: "Pick a folder" }).click();
  await expect(folder.getByTestId("rekordbox-status")).toHaveText("rekordbox: matched 1 of 1");
  await page.getByRole("button", { name: /Lessons/ }).click();
  await page.getByRole("button", { name: "Mix plans" }).click();
  await page.getByLabel("Upload a plan").setInputFiles({ name: "render-check.mixplan.json", mimeType: "application/json", buffer: Buffer.from(await planFile(tracks)) });
  await page.locator("li[data-plan]", { hasText: "Render check" }).getByRole("button", { name: "Open" }).click();
  const render = page.getByRole("region", { name: "Render" });
  await expect(render.getByRole("list", { name: "Before rendering" })).toHaveText(`Find ${NAMES[1]} above.`);
  await expect(render.getByRole("button", { name: "Render the set" })).toBeDisabled();
});
