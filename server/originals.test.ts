import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { memoryLogger } from "./logger.ts";
import { sameOriginPolicy } from "./same-origin.ts";
import { APP_ORIGIN, appRequest } from "./test-support.ts";

const META = {
  id: "001",
  title: "Lamplight Moths",
  topic: "moths",
  genre: "house",
  subgenre: "deep house",
  bpm: 123,
  key: "A minor (dorian)",
  camelot: "8A",
  durationSec: 343.414626,
  firstDownbeatSec: 0,
  bars: 176,
  phrases: [
    { startBar: 0, lengthBars: 32, section: "intro" },
    { startBar: 32, lengthBars: 144, section: "drop" },
  ],
  introBars: 32,
  outroBars: 32,
  loudnessLUFS: -8.6,
  truePeakDb: -1.5,
  generatorVersion: "0.1.0",
  seed: 1001,
};

let root: string;
let outside: string;
const logger = memoryLogger();
const MP3_BYTES = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);

function indexLine(id: string, title: string, directory: string) {
  const { genre, subgenre, bpm, key, camelot, durationSec, bars, introBars, outroBars } = META;
  const summary = { id, title, genre, subgenre, bpm, key, camelot, durationSec, bars, introBars, outroBars };
  return JSON.stringify({ ...summary, path: `/somewhere/else/${directory}` });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ltd-originals-"));
  outside = await mkdtemp(join(tmpdir(), "ltd-outside-"));
  await mkdir(join(root, "001-lamplight-moths"));
  await writeFile(join(root, "001-lamplight-moths", "meta.json"), JSON.stringify(META));
  await writeFile(join(root, "001-lamplight-moths", "track.mp3"), MP3_BYTES);
  await writeFile(join(outside, "track.mp3"), "secret");
  await writeFile(join(outside, "meta.json"), JSON.stringify({ ...META, id: "evil" }));
  await symlink(outside, join(root, "002-escape"));
  await writeFile(
    join(root, "index.jsonl"),
    [
      indexLine("001", "Lamplight Moths", "001-lamplight-moths"),
      "{ not json",
      indexLine("002", "Escape", "002-escape"),
      JSON.stringify({ id: "../etc", title: "Bad id", path: "/x/.." }),
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function app(originalsDir = root) {
  return createApp({ sameOrigin: sameOriginPolicy([APP_ORIGIN], ["127.0.0.1:5180"]), originalsDir, logger });
}

describe("GET /api/originals", () => {
  it("lists the valid index entries without their on-disk paths, and logs the bad lines", async () => {
    const response = await appRequest(app(), "/api/originals");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: true; data: Record<string, unknown>[] };
    expect(body.success).toBe(true);
    expect(body.data.map((entry) => entry["id"])).toEqual(["001", "002"]);
    expect(body.data[0]).toMatchObject({ id: "001", title: "Lamplight Moths", bpm: 123, camelot: "8A", durationSec: 343.414626 });
    expect(JSON.stringify(body)).not.toContain("/somewhere/else");
    expect(logger.events.some((event) => event.level === "warn" && event.event === "originals.badIndexLine")).toBe(true);
  });

  it("answers an empty list when no originals have been generated", async () => {
    const response = await appRequest(app(join(root, "missing")), "/api/originals");

    expect(await response.json()).toEqual({ success: true, data: [] });
  });

  it("is behind the same-origin guard", async () => {
    const response = await app().request("/api/originals", { headers: { origin: "http://evil.test" } });

    expect(response.status).toBe(403);
  });

  it("is not served when the app has no originals directory", async () => {
    const response = await appRequest(createApp(), "/api/originals");

    expect(response.status).toBe(404);
  });
});

describe("GET /api/originals/:id/audio", () => {
  it("streams track.mp3 as audio/mpeg with its length", async () => {
    const response = await appRequest(app(), "/api/originals/001/audio");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES);
  });

  it("answers a byte range with 206", async () => {
    const response = await appRequest(app(), "/api/originals/001/audio", { headers: { range: "bytes=10-19" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES.slice(10, 20));
  });

  it("answers an unsatisfiable range with 416", async () => {
    const response = await appRequest(app(), "/api/originals/001/audio", { headers: { range: "bytes=5000-" } });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
  });

  it("ignores an invalid range (end before start) and sends the whole file", async () => {
    const response = await appRequest(app(), "/api/originals/001/audio", { headers: { range: "bytes=5-2" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
  });

  it("serves an empty track.mp3 as an empty 200, not a crash", async () => {
    await writeFile(join(root, "001-lamplight-moths", "track.mp3"), "");

    const response = await appRequest(app(), "/api/originals/001/audio");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
  });

  it("refuses an index entry whose folder resolves outside the originals directory", async () => {
    const response = await appRequest(app(), "/api/originals/002/audio");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it.each(["..%2F..%2Fetc", "%2E%2E", "unknown", "a.b"])("answers 404 or 400 for the id %s, never a file", async (id) => {
    const response = await appRequest(app(), `/api/originals/${id}/audio`);

    expect([400, 404]).toContain(response.status);
    expect(await response.json()).toMatchObject({ success: false });
  });
});

describe("GET /api/originals/:id/meta", () => {
  it("returns meta.json, with its exact grid and phrases", async () => {
    const response = await appRequest(app(), "/api/originals/001/meta");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "001", bpm: 123, firstDownbeatSec: 0, bars: 176, phrases: META.phrases },
    });
  });

  it("answers 500 with a fix when meta.json is invalid", async () => {
    await writeFile(join(root, "001-lamplight-moths", "meta.json"), JSON.stringify({ id: "001" }));

    const response = await appRequest(app(), "/api/originals/001/meta");

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; issues: string[] };
    expect(body.error).toMatch(/meta\.json/);
    expect(body.issues.length).toBeGreaterThan(1);
  });
});
