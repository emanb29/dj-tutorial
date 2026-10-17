import { describe, expect, it } from "vitest";
import { createStarterPackSource } from "./starter-pack.ts";
import { bytesOf, chunkedResponse, fakeDecoder, fakeFetch } from "./test-support.ts";
import type { LoadProgress, Track } from "./types.ts";

// printf 'ID3fake|duration-ms=2000' | sha256sum
const FAKE_FILE_KEY = "8fc5c551daa68a9a88b68cb010dedc5bdb0f32e2b58a87744c80543fec1044b6";

async function firstTrack(source: ReturnType<typeof createStarterPackSource>, title: string): Promise<Track> {
  const listed = await source.list();
  if (!listed.ok) throw new Error("list failed");
  const track = listed.value.find((candidate) => candidate.title === title);
  if (track === undefined) throw new Error(`no ${title}`);
  return track;
}

describe("starter pack source", () => {
  it("lists all 16 tracks from tracks/starter-pack.json with credits", async () => {
    const source = createStarterPackSource({ fetch: fakeFetch(() => new Response()).fetch, decode: fakeDecoder().decode });

    const listed = await source.list();

    expect(listed.ok && listed.value).toHaveLength(16);
    const brothers = await firstTrack(source, "Brothers");
    expect(brothers).toMatchObject({
      source: "starter-pack",
      artist: "Kay Grove",
      bpmHint: 125,
      genre: "house",
      durationSec: 424,
      licence: "http://creativecommons.org/licenses/by-nc-nd/2.5/",
      analysisCacheKey: null,
      retention: "persistable",
      attribution: {
        text: '"Brothers" by Kay Grove, CC BY-NC-ND 2.5, via the Internet Archive',
        url: "https://archive.org/details/rest033-kay_grove_-_brothers_ep",
      },
    });
  });

  it("marks ND tracks as not shareable and BY-SA tracks as shareable", async () => {
    const source = createStarterPackSource({ fetch: fakeFetch(() => new Response()).fetch, decode: fakeDecoder().decode });

    expect((await firstTrack(source, "Brothers")).shareable).toBe(false);
    expect((await firstTrack(source, "Pattern A29")).shareable).toBe(true);
  });

  it("searches title, artist and genre, ignoring case", async () => {
    const source = createStarterPackSource({ fetch: fakeFetch(() => new Response()).fetch, decode: fakeDecoder().decode });

    const byArtist = await source.search("kay grove");
    const byGenre = await source.search("TECHNO");

    expect(byArtist.ok && byArtist.value.map((track) => track.title)).toEqual(["Brothers", "Expressions"]);
    expect(byGenre.ok && byGenre.value.every((track) => track.genre === "techno")).toBe(true);
    expect(byGenre.ok && byGenre.value.length).toBeGreaterThan(0);
  });

  it("fetches from archive.org in CORS mode without credentials, decodes, and keys the analysis cache", async () => {
    const { fetch, calls } = fakeFetch(() => chunkedResponse([bytesOf("ID3"), bytesOf("fake")]));
    const decoder = fakeDecoder(2);
    const source = createStarterPackSource({ fetch, decode: decoder.decode });
    const track = await firstTrack(source, "Brothers");
    const progress: LoadProgress[] = [];

    const loaded = await source.load(track, { onProgress: (update) => progress.push(update) });

    expect(calls[0]?.url).toBe(
      "https://archive.org/download/rest033-kay_grove_-_brothers_ep/rest033-01-kay_grove_-_brothers.mp3",
    );
    expect(calls[0]?.init).toMatchObject({ mode: "cors", credentials: "omit" });
    expect(decoder.decoded[0]).toEqual(bytesOf("ID3fake"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.contentHash).toBe(FAKE_FILE_KEY);
    expect(loaded.value.track.analysisCacheKey).toBe(FAKE_FILE_KEY);
    expect(loaded.value.track.durationSec).toBe(2);
    expect(loaded.value.audio.duration).toBe(2);
    const fractions = progress.map((update) => update.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
    expect(progress.some((update) => update.stage === "fetching" && update.totalBytes === 7)).toBe(true);
  });

  it("returns an http error with a fix when archive.org answers 404", async () => {
    const source = createStarterPackSource({
      fetch: fakeFetch(() => new Response("gone", { status: 404 })).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await firstTrack(source, "Brothers"));

    expect(loaded).toMatchObject({ ok: false, error: { kind: "http", status: 404 } });
    expect(!loaded.ok && loaded.error.fix).toMatch(/\w/);
  });

  it("returns a network error mentioning CORS when the fetch itself fails", async () => {
    const source = createStarterPackSource({
      fetch: fakeFetch(() => Promise.reject(new TypeError("Failed to fetch"))).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await firstTrack(source, "Brothers"));

    expect(loaded).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(!loaded.ok && loaded.error.fix).toMatch(/CORS|connection/i);
  });

  it("returns aborted when the signal is aborted", async () => {
    const source = createStarterPackSource({ fetch: fakeFetch(() => chunkedResponse([bytesOf("x")])).fetch, decode: fakeDecoder().decode });
    const controller = new AbortController();
    controller.abort();

    const loaded = await source.load(await firstTrack(source, "Brothers"), { signal: controller.signal });

    expect(loaded).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });

  it("returns aborted, not a network error, when the signal is aborted with a custom reason mid-fetch", async () => {
    const controller = new AbortController();
    const source = createStarterPackSource({
      fetch: fakeFetch(() => {
        controller.abort(new Error("Learner closed the deck"));
        return Promise.reject(controller.signal.reason as Error);
      }).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await firstTrack(source, "Brothers"), { signal: controller.signal });

    expect(loaded).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });

  it("returns decode-failed when the bytes are not audio", async () => {
    const source = createStarterPackSource({
      fetch: fakeFetch(() => chunkedResponse([bytesOf("BAD bytes")])).fetch,
      decode: fakeDecoder().decode,
    });

    const loaded = await source.load(await firstTrack(source, "Brothers"));

    expect(loaded).toMatchObject({ ok: false, error: { kind: "decode-failed" } });
  });
});
