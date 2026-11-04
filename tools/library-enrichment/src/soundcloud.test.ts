// Synthetic pages only (the repo is public).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_TTL_MS, lookupAll, parseYtDlpOutput, soundCloudCache, soundCloudProposals, uploaderEvidence, type Fetcher, type Lookup, type SoundCloudTrack } from "./soundcloud.ts";

const PAGE: SoundCloudTrack = {
  id: "1234567890",
  title: "Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL]",
  uploader: "Tinwhistle",
  uploaderUrl: "https://soundcloud.com/tinwhistle",
  genre: "Tech House",
  tags: ["techhouse", "free download"],
  uploadDate: "20230415",
  releaseYear: null,
  description: "",
  url: "https://soundcloud.com/tinwhistle/glass-rivers-remix",
};

describe("parseYtDlpOutput", () => {
  it("reads one JSON line per found track and one ERROR line per failed ID", () => {
    const stdout = `${JSON.stringify({ id: "11", title: "A - B", uploader: "A", genre: "House", tags: ["x"], upload_date: "20200101", webpage_url: "https://soundcloud.com/a/b" })}\n`;
    const stderr = "ERROR: [soundcloud] 22: Unable to download JSON metadata: HTTP Error 404: Not Found\nERROR: [soundcloud] 33: Unable to download JSON metadata: HTTP Error 429: Too Many Requests\n";
    const results = parseYtDlpOutput(stdout, stderr, ["11", "22", "33", "44"]);
    expect(results.get("11")).toMatchObject({ status: "ok", track: { title: "A - B", uploader: "A", genre: "House", tags: ["x"], uploadDate: "20200101", releaseYear: null } });
    expect(results.get("22")).toEqual({ status: "not-found" });
    expect(results.get("33")).toMatchObject({ status: "error", message: expect.stringContaining("429") as unknown });
    expect(results.get("44")).toMatchObject({ status: "error" });
  });
});

describe("lookupAll", () => {
  const ok = (id: string): Lookup => ({ status: "ok", track: { ...PAGE, id } });

  function setUp(answer: (ids: readonly string[], call: number) => Map<string, Lookup>) {
    const cache = soundCloudCache(mkdtempSync(join(tmpdir(), "enrich-sc-")));
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const fetcher: Fetcher = {
      fetchBatch: (ids) => {
        calls.push([...ids]);
        return Promise.resolve(answer(ids, calls.length));
      },
    };
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const options = {
      cache,
      fetcher,
      batchSize: 2,
      pauseMs: 1000,
      now: () => new Date(clock),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
    return { cache, calls, sleeps, options, advance: (ms: number) => (clock += ms) };
  }

  it("asks in batches, pauses between them, and caches every answer, misses too", async () => {
    const { calls, sleeps, options, cache } = setUp((ids) => new Map(ids.map((id) => [id, id === "3" ? { status: "not-found" } : ok(id)])));
    expect(await lookupAll(["1", "2", "3", "1"], options)).toEqual({ fromCache: 0, fetched: 3, stoppedByRateLimit: false });
    expect(calls).toEqual([["1", "2"], ["3"]]);
    expect(sleeps).toEqual([1000]);
    expect(cache.get("3", options.now())?.lookup).toEqual({ status: "not-found" });
    // A second run asks nothing.
    expect(await lookupAll(["1", "2", "3"], options)).toEqual({ fromCache: 3, fetched: 0, stoppedByRateLimit: false });
    expect(calls).toHaveLength(2);
  });

  it("asks again once an answer is older than its TTL", async () => {
    const { calls, options, advance } = setUp((ids) => new Map(ids.map((id) => [id, { status: "not-found" }])));
    await lookupAll(["1"], options);
    advance(CACHE_TTL_MS["not-found"] + 1);
    await lookupAll(["1"], options);
    expect(calls).toEqual([["1"], ["1"]]);
  });

  it("backs off once when rate limited, then stops rather than retrying forever", async () => {
    const limited = (ids: readonly string[]) => new Map<string, Lookup>(ids.map((id) => [id, { status: "error", message: "HTTP Error 429: Too Many Requests" }]));
    const { calls, sleeps, options, cache } = setUp(limited);
    expect(await lookupAll(["1", "2"], options)).toEqual({ fromCache: 0, fetched: 0, stoppedByRateLimit: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([120_000]);
    expect(cache.get("1", options.now())).toBeNull();
  });
});

describe("uploaderEvidence", () => {
  const named = { artist: "Tinwhistle", originalArtist: "Moss Harbor", remixer: "Tinwhistle" };

  it("counts the uploader only when it is the remixer or the artist the title starts with", () => {
    expect(uploaderEvidence("TINWHISTLE", [named])).toBe("remixer");
    expect(uploaderEvidence("Moss Harbor", [named])).toBe("original-artist");
    expect(uploaderEvidence("Kit Lane", [{ artist: "Kit Lane", originalArtist: null, remixer: null }])).toBe("artist-prefix");
    expect(uploaderEvidence("Someone Else", [named])).toBeNull();
  });

  it("never credits a label, promo or repost channel", () => {
    expect(uploaderEvidence("Harbor Records", [{ artist: "Harbor Records", originalArtist: null, remixer: null }])).toBeNull();
    expect(uploaderEvidence("Bass Nation", [{ artist: "Bass Nation", originalArtist: null, remixer: null }])).toBeNull();
    expect(uploaderEvidence("Free DL Reposts", [named])).toBeNull();
  });
});

describe("soundCloudProposals", () => {
  const named = { artist: "Tinwhistle", originalArtist: "Moss Harbor", remixer: "Tinwhistle" };

  it("confirms the remixer as the artist, maps the genre, keeps the raw genre, and dates the track", () => {
    const proposals = soundCloudProposals(PAGE, named);
    const byField = Object.fromEntries(proposals.map((each) => [each.field, each]));
    expect(byField["artist"]).toMatchObject({ value: "Tinwhistle", band: "high", rule: "uploader-is-remixer", step: "soundcloud" });
    expect(byField["genre"]).toMatchObject({ value: "tech house", band: "high" });
    expect(byField["genreRaw"]).toMatchObject({ value: "Tech House" });
    expect(byField["year"]).toMatchObject({ value: "2023", band: "high", rule: "upload-date-by-artist" });
    expect(byField["artist"]?.evidence.join(" ")).toContain("Tinwhistle");
  });

  it("credits no one when a channel uploaded it, and its upload date is only medium", () => {
    const proposals = soundCloudProposals({ ...PAGE, uploader: "Deep Harbor Records", genre: "Dance & EDM", tags: [] }, named);
    expect(proposals.map((each) => each.field)).toEqual(["genreRaw", "year"]);
    expect(proposals.find((each) => each.field === "year")).toMatchObject({ band: "medium", rule: "upload-date" });
  });

  it("prefers a release year over the upload date", () => {
    expect(soundCloudProposals({ ...PAGE, releaseYear: 2019 }, named).find((each) => each.field === "year")).toMatchObject({ value: "2019", band: "high" });
  });
});
