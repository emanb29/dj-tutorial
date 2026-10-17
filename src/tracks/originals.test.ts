import { describe, expect, it } from "vitest";
import { createOriginalsSource } from "./originals.ts";
import { bytesOf, chunkedResponse, fakeDecoder, fakeFetch } from "./test-support.ts";
import type { Track } from "./types.ts";

const SUMMARY = {
  id: "007",
  title: "Short Loop",
  genre: "house",
  subgenre: "deep house",
  bpm: 120,
  key: "A minor",
  camelot: "8A",
  durationSec: 5,
  bars: 2,
  introBars: 1,
  outroBars: 1,
};
const META = {
  ...SUMMARY,
  firstDownbeatSec: 0.5,
  phrases: [
    { startBar: 0, lengthBars: 1, section: "intro" },
    { startBar: 1, lengthBars: 1, section: "outro" },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(overrides: { meta?: Response } = {}) {
  return fakeFetch((url) => {
    if (url === "/api/originals") return json({ success: true, data: [SUMMARY] });
    if (url === "/api/originals/007/audio") return chunkedResponse([bytesOf("ID3fake")]);
    if (url === "/api/originals/007/meta") return overrides.meta ?? json({ success: true, data: META });
    return json({ success: false, error: "no route", code: "notFound" }, 404);
  });
}

async function onlyTrack(source: ReturnType<typeof createOriginalsSource>): Promise<Track> {
  const listed = await source.list();
  if (!listed.ok || listed.value[0] === undefined) throw new Error("list failed");
  return listed.value[0];
}

describe("originals source", () => {
  it("lists the server's Originals as shareable tracks with key hints", async () => {
    const source = createOriginalsSource({ fetch: server().fetch, decode: fakeDecoder().decode });

    expect(await onlyTrack(source)).toMatchObject({
      id: "007",
      source: "original",
      title: "Short Loop",
      bpmHint: 120,
      keyHint: "8A (A minor)",
      genre: "house",
      shareable: true,
      durationSec: 5,
      analysisCacheKey: null,
      retention: "persistable",
    });
  });

  it("loads the audio and turns meta.json into an exact grid, so the track skips analysis", async () => {
    const { fetch, calls } = server();
    const source = createOriginalsSource({ fetch, decode: fakeDecoder(5).decode });

    const loaded = await source.load(await onlyTrack(source));

    expect(calls.map((call) => call.url)).toContain("/api/originals/007/audio");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.knownGrid).toEqual({
      origin: "generator-meta",
      bpm: 120,
      durationSec: 5,
      firstBeatSec: 0.5,
      downbeatPhase: 0,
      beatGrid: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
      phrases: [
        { startSec: 0.5, bar: 1, lengthBars: 1, section: "intro" },
        { startSec: 2.5, bar: 2, lengthBars: 1, section: "outro" },
      ],
    });
    expect(loaded.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns bad-response, listing every problem, when meta.json breaks the contract", async () => {
    const source = createOriginalsSource({
      fetch: server({ meta: json({ success: true, data: { id: "007" } }) }).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await onlyTrack(source));

    expect(loaded).toMatchObject({ ok: false, error: { kind: "bad-response" } });
    expect(!loaded.ok && loaded.error.kind === "bad-response" && loaded.error.problems.length).toBeGreaterThan(1);
  });

  it("passes on the server's error message when the meta route fails", async () => {
    const source = createOriginalsSource({
      fetch: server({ meta: json({ success: false, error: "meta.json is broken. Regenerate the track.", code: "internal" }, 500) }).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await onlyTrack(source));

    expect(loaded).toMatchObject({ ok: false, error: { kind: "http", status: 500, message: expect.stringContaining("Regenerate") as unknown } });
  });

  it("searches by title or genre", async () => {
    const source = createOriginalsSource({ fetch: server().fetch, decode: fakeDecoder().decode });

    expect(await source.search("short")).toMatchObject({ ok: true, value: [{ id: "007" }] });
    expect(await source.search("techno")).toEqual({ ok: true, value: [] });
  });
});
