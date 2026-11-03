// The Mix Editor's Renders on the API (ISS-190): segment upload, concatenation, the WAV and MP3
// exports, and every cap. The audio is a few generated frames, never a file. Without ffmpeg (or its
// MP3 encoder) the MP3 transcode test skips with a message; the unavailable path is always tested.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RENDER_SEC, MAX_RENDER_SEGMENT_BYTES, renderExportPath, renderPath, renderSegmentPath, RENDERS_PATH, wavHeader, type RenderSession } from "@shared/mix-render.ts";
import { AudioExporter } from "./audio-export.ts";
import { MAX_RENDERS, RENDER_START_RATE_RULE } from "./renders.ts";
import { APP_ORIGIN, appRequest, startTestServer, type TestServer } from "./test-support.ts";

const exporter = await AudioExporter.detect();
const missingReason = exporter.status.available ? null : exporter.status.reason;
if (missingReason !== null) console.warn(`[renders.test] skipping the MP3 transcode: ${missingReason}`);

const RATE = 44_100;
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(options: { audioExport?: AudioExporter } = {}): Promise<TestServer> {
  server = await startTestServer({ client: null, renders: true, ...options });
  return server;
}

/** 16-bit stereo PCM of a 1 kHz tone, `frames` long, starting at frame `from`. */
function pcm(frames: number, from = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < frames; index++) {
    const sample = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * (from + index)) / RATE));
    view.setInt16(index * 4, sample, true);
    view.setInt16(index * 4 + 2, sample, true);
  }
  return bytes;
}

async function start(test: TestServer, frames: number, name = "Friday set"): Promise<RenderSession> {
  const response = await appRequest(test.app, RENDERS_PATH, { body: { name, tracks: ["Artist 1 – Track 1", "Artist 2 – Track 2"], sampleRate: RATE, frames } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: RenderSession }).data;
}

const upload = (test: TestServer, id: string, index: number, body: Uint8Array<ArrayBuffer>, contentType = "application/octet-stream") =>
  test.app.request(renderSegmentPath(id, index), { method: "PUT", headers: { origin: APP_ORIGIN, "content-type": contentType }, body });

describe("POST /api/renders", () => {
  it("starts a Render and says which formats it can be had in", async () => {
    const test = await serve();
    const session = await start(test, RATE * 2);
    expect(session).toMatchObject({ frames: RATE * 2, sampleRate: RATE, receivedFrames: 0, complete: false });
    expect(session.formats.wav).toEqual({ available: true, bytes: 44 + RATE * 2 * 4 });
    // This test server has no ffmpeg: the MP3 says why.
    expect(session.formats.mp3).toEqual({ available: false, reason: "The server was started without the audio export. Restart it with `npm run dev`." });
  });

  it("lists every problem with a bad start, and refuses a set over 3 hours", async () => {
    const test = await serve();
    const bad = await appRequest(test.app, RENDERS_PATH, { body: { name: 5, sampleRate: 22_050, frames: -1 } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: string[] }).issues.length).toBeGreaterThanOrEqual(4);
    const long = await appRequest(test.app, RENDERS_PATH, { body: { name: "Marathon", tracks: [], sampleRate: RATE, frames: (MAX_RENDER_SEC + 1) * RATE } });
    expect(long.status).toBe(413);
    const text = await appRequest(test.app, RENDERS_PATH, { body: "not json", headers: { "content-type": "text/plain" } });
    expect(text.status).toBe(415);
  });

  it("refuses a page from another origin", async () => {
    const test = await serve();
    const response = await test.app.request(RENDERS_PATH, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x", tracks: [], sampleRate: RATE, frames: 10 }) });
    expect(response.status).toBe(403);
  });

  it(`keeps at most ${String(MAX_RENDERS)} Renders uploading at once, making room by dropping a finished one`, async () => {
    const test = await serve();
    const first = await start(test, 100);
    await start(test, 100);
    const full = await appRequest(test.app, RENDERS_PATH, { body: { name: "Third", tracks: [], sampleRate: RATE, frames: 100 } });
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toBe("2 Renders are already uploading. Let one finish, or cancel it, then render again.");
    expect((await upload(test, first.id, 0, pcm(100))).status).toBe(200);
    await start(test, 100, "Third");
    expect((await appRequest(test.app, renderPath(first.id))).status).toBe(404);
  });

  it("rate-limits starts", async () => {
    const test = await serve();
    for (let count = 0; count < RENDER_START_RATE_RULE.burst; count++) {
      const session = await start(test, 4);
      expect((await upload(test, session.id, 0, pcm(4))).status).toBe(200);
    }
    const over = await appRequest(test.app, RENDERS_PATH, { body: { name: "One more", tracks: [], sampleRate: RATE, frames: 4 } });
    expect(over.status).toBe(429);
  });
});

describe("PUT /api/renders/:id/segments/:index", () => {
  it("concatenates segments in order, and serves them as one WAV behind a header", async () => {
    const test = await serve();
    const session = await start(test, 3000);
    const parts = [pcm(1000, 0), pcm(1500, 1000), pcm(500, 2500)];
    for (const [index, part] of parts.entries()) {
      const response = await upload(test, session.id, index, part);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: RenderSession }).data.complete).toBe(index === parts.length - 1);
    }
    const wav = await test.app.request(renderExportPath(session.id, "wav"));
    expect(wav.status).toBe(200);
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(wav.headers.get("content-disposition")).toBe('attachment; filename="friday-set-render.wav"');
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.length).toBe(44 + 3000 * 4);
    expect(wav.headers.get("content-length")).toBe(String(bytes.length));
    expect(bytes.subarray(0, 44)).toEqual(wavHeader(3000, RATE));
    expect(bytes.subarray(44)).toEqual(pcm(3000));
  });

  it("serves a byte range of the WAV, so a player can seek in a long set", async () => {
    const test = await serve();
    const session = await start(test, 1000);
    await upload(test, session.id, 0, pcm(1000));
    const whole = new Uint8Array(await (await test.app.request(renderExportPath(session.id, "wav"))).arrayBuffer());
    for (const [range, from, to] of [["bytes=0-9", 0, 9], ["bytes=40-99", 40, 99], ["bytes=2000-", 2000, whole.length - 1], ["bytes=-16", whole.length - 16, whole.length - 1]] as const) {
      const part = await test.app.request(renderExportPath(session.id, "wav"), { headers: { range } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes ${String(from)}-${String(to)}/${String(whole.length)}`);
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(whole.subarray(from, to + 1));
    }
    expect((await test.app.request(renderExportPath(session.id, "wav"), { headers: { range: "bytes=999999-" } })).status).toBe(416);
  });

  it("refuses a segment out of order, one that is not whole frames, one past the declared length, and one over the size cap", async () => {
    const test = await serve();
    const session = await start(test, 1000);
    expect((await upload(test, session.id, 1, pcm(10))).status).toBe(409);
    expect((await upload(test, session.id, 0, new Uint8Array(6))).status).toBe(400);
    expect((await upload(test, session.id, 0, pcm(1001))).status).toBe(413);
    expect((await upload(test, session.id, 0, pcm(10), "audio/wav")).status).toBe(415);
    const huge = await upload(test, session.id, 0, new Uint8Array(MAX_RENDER_SEGMENT_BYTES + 4));
    expect(huge.status).toBe(413);
    // None of those were kept.
    expect(((await (await appRequest(test.app, renderPath(session.id))).json()) as { data: RenderSession }).data.receivedFrames).toBe(0);
  });

  it("says when the Render is unknown, and cannot be downloaded before it is complete", async () => {
    const test = await serve();
    expect((await upload(test, "nope", 0, pcm(4))).status).toBe(404);
    const session = await start(test, 1000);
    await upload(test, session.id, 0, pcm(500));
    expect((await test.app.request(renderExportPath(session.id, "wav"))).status).toBe(409);
    const dropped = await test.app.request(renderPath(session.id), { method: "DELETE", headers: { origin: APP_ORIGIN } });
    expect(dropped.status).toBe(200);
    expect((await test.app.request(renderExportPath(session.id, "wav"))).status).toBe(404);
  });
});

describe("GET /api/renders/:id/export.mp3", () => {
  it("says the MP3 is unavailable without ffmpeg", async () => {
    const test = await serve();
    const session = await start(test, 100);
    await upload(test, session.id, 0, pcm(100));
    const response = await test.app.request(renderExportPath(session.id, "mp3"));
    expect(response.status).toBe(503);
  });

  it.skipIf(missingReason !== null)("transcodes the Render's PCM to a tagged 320 kbit/s MP3", async () => {
    const test = await serve({ audioExport: exporter });
    const frames = RATE * 2;
    const session = await start(test, frames);
    expect(session.formats.mp3).toEqual({ available: true, bytes: 80_000 });
    await upload(test, session.id, 0, pcm(frames));
    const response = await test.app.request(renderExportPath(session.id, "mp3"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // ID3v2 tags first, then about 2 s at 320 kbit/s.
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe("ID3");
    expect(bytes.length).toBeGreaterThan(60_000);
    expect(bytes.length).toBeLessThan(120_000);
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 400))).toContain("Friday set");
  });
});
