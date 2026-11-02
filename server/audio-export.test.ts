// The final project's WAV/MP3 export, through ffmpeg. The fixture is a one-second Opus WebM that
// ffmpeg itself makes, so no audio file is committed and nothing is played. Without ffmpeg (or its
// MP3 encoder) the real-transcode tests skip with a message; the unavailable path is always tested.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyLearnerRecord, type FinalProject } from "@shared/learner.ts";
import { AudioExporter } from "./audio-export.ts";
import { APP_ORIGIN, startTestServer, type TestServer } from "./test-support.ts";

const exporter = await AudioExporter.detect();
const missingReason = exporter.status.available ? null : exporter.status.reason;
if (missingReason !== null) console.warn(`[audio-export.test] skipping the ffmpeg transcodes: ${missingReason}`);

const PROJECT: FinalProject = {
  attemptId: "attempt-1",
  recordedAt: "2026-10-17T20:15:00.000Z",
  mode: "cold",
  outcome: "passed",
  band: "pass",
  durationSec: 1,
  audio: { mimeType: "audio/webm", bytes: 100 },
  tracks: [
    { title: "Set Groove C", artist: "DJ Tutorial", bpm: 124, credit: "", shareable: true },
    { title: "Set Groove Am", artist: "DJ Tutorial", bpm: 124, credit: "", shareable: true },
  ],
  transitions: [],
};

let server: TestServer | undefined;
let fixtureDir: string | undefined;
let fixture: Uint8Array<ArrayBuffer> = new Uint8Array(0);

beforeAll(async () => {
  if (missingReason !== null) return;
  fixtureDir = await mkdtemp(join(tmpdir(), "ltd-export-fixture-"));
  const path = join(fixtureDir, "set.webm");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-c:a", "libopus", "-y", path]);
  fixture = new Uint8Array(await readFile(path));
});

afterAll(async () => {
  if (fixtureDir !== undefined) await rm(fixtureDir, { recursive: true, force: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function keep(test: TestServer): Promise<void> {
  const put = await test.app.request("/api/learners/default/final-project/audio", { method: "PUT", headers: { origin: APP_ORIGIN, "content-type": "audio/webm" }, body: fixture });
  expect(put.status).toBe(200);
  await test.profiles.put({ ...emptyLearnerRecord("default"), finalProject: PROJECT });
}

const exportDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("ltd-export-") && !name.startsWith("ltd-export-fixture-"));

describe.skipIf(missingReason !== null)("exporting the final project with ffmpeg", () => {
  it("reports the export as available", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    expect(await (await server.app.request("/api/final-project/export-status")).json()).toEqual({ success: true, data: { available: true } });
  });

  it("gives a 320 kbit/s MP3 with ID3 tags (title, track list) and leaves no temp file", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    await keep(server);
    const before = await exportDirs();
    const response = await server.app.request("/api/learners/default/final-project/export.mp3");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="dj-tutorial-set-2026-10-17.mp3"');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 3).toString("latin1")).toBe("ID3");
    const text = bytes.toString("utf16le") + bytes.toString("latin1");
    expect(text).toContain("My first set");
    expect(text).toContain("DJ Tutorial");
    expect(text).toContain("Set Groove Am");
    // 320 kbit/s CBR: the first MPEG frame header's bitrate index is 14 (MPEG-1 Layer III).
    const id3Size = ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
    let frame = 10 + id3Size;
    while (frame < bytes.length - 1 && !(bytes[frame] === 0xff && ((bytes[frame + 1] ?? 0) & 0xe0) === 0xe0)) frame += 1;
    expect(((bytes[frame + 2] ?? 0) >> 4) & 0x0f).toBe(14);
    expect(await exportDirs()).toEqual(before);
  });

  it("gives a lossless WAV", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    await keep(server);
    const response = await server.app.request("/api/learners/default/final-project/export.wav");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(bytes.length).toBeGreaterThan(100_000); // a second of 48 kHz stereo 16-bit PCM
  });

  it("says 404 with a fix when nothing was kept", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    const response = await server.app.request("/api/learners/default/final-project/export.mp3");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("Keep a set first");
  });

  it("rate-limits exports per Learner", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    await keep(server);
    const statuses: number[] = [];
    for (let at = 0; at < 4; at += 1) {
      const response = await server.app.request("/api/learners/default/final-project/export.mp3");
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("reports a stored file ffmpeg cannot read as a failure with a fix", async () => {
    server = await startTestServer({ client: null, audioExport: exporter });
    await server.app.request("/api/learners/default/final-project/audio", { method: "PUT", headers: { origin: APP_ORIGIN, "content-type": "audio/webm" }, body: new Uint8Array([1, 2, 3, 4]) });
    await server.profiles.put({ ...emptyLearnerRecord("default"), finalProject: PROJECT });
    const response = await server.app.request("/api/learners/default/final-project/export.mp3");
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toMatch(/ffmpeg could not convert the set .*retry/);
  });

  it("stops ffmpeg at the time limit", async () => {
    const slow = await AudioExporter.detect("ffmpeg", 1);
    server = await startTestServer({ client: null, audioExport: slow });
    await keep(server);
    const response = await server.app.request("/api/learners/default/final-project/export.wav");
    expect(response.status).toBe(504);
  });
});

describe("without ffmpeg", () => {
  it("says the export is unavailable, and why, and refuses the download", async () => {
    const missing = await AudioExporter.detect("/nonexistent/ffmpeg");
    server = await startTestServer({ client: null, audioExport: missing });
    const status = (await (await server.app.request("/api/final-project/export-status")).json()) as { data: { available: boolean; reason: string } };
    expect(status.data.available).toBe(false);
    expect(status.data.reason).toContain("Install ffmpeg");
    const response = await server.app.request("/api/learners/default/final-project/export.mp3");
    expect(response.status).toBe(503);
  });
});
