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
  const limited: Lookup = { status: "error", message: "HTTP Error 429: Too Many Requests" };
  const MINUTE = 60_000;

  /** A fake clock: sleeping and fetching move it, so the test sees when each lookup started. */
  function setUp(answer: (ids: readonly string[], call: number) => Map<string, Lookup>, fetchMs = 3000) {
    const cache = soundCloudCache(mkdtempSync(join(tmpdir(), "enrich-sc-")));
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const t0 = clock;
    const calls: string[][] = [];
    const starts: number[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const fetcher: Fetcher = {
      fetchBatch: (ids) => {
        calls.push([...ids]);
        starts.push(clock - t0);
        clock += fetchMs;
        return Promise.resolve(answer(ids, calls.length));
      },
    };
    const options = {
      cache,
      fetcher,
      batchSize: 1,
      msPerTrack: 20_000,
      minGapMs: 7000,
      firstBackoffMs: 5 * MINUTE,
      maxBackoffMs: 60 * MINUTE,
      maxBackoffs: 3,
      now: () => new Date(clock),
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      log: (line: string) => logs.push(line),
    };
    return { cache, calls, starts, sleeps, logs, options, advance: (ms: number) => (clock += ms) };
  }

  it("paces one track per 20 s, start to start, and caches every answer, misses too", async () => {
    const { calls, starts, options, cache } = setUp((ids) => new Map(ids.map((id) => [id, id === "3" ? { status: "not-found" } : ok(id)])));
    expect(await lookupAll(["1", "2", "3", "1"], options)).toEqual({ fromCache: 0, fetched: 3, stoppedByRateLimit: false });
    expect(calls).toEqual([["1"], ["2"], ["3"]]);
    expect(starts).toEqual([0, 20_000, 40_000]);
    expect(cache.get("3", options.now())?.lookup).toEqual({ status: "not-found" });
    // A second run asks nothing.
    expect(await lookupAll(["1", "2", "3"], options)).toEqual({ fromCache: 3, fetched: 0, stoppedByRateLimit: false });
    expect(calls).toHaveLength(3);
  });

  it("keeps a gap after a slow lookup, so requests never bunch up", async () => {
    const { starts, options } = setUp((ids) => new Map(ids.map((id) => [id, ok(id)])), 18_000);
    await lookupAll(["1", "2"], options);
    expect(starts).toEqual([0, 25_000]);
  });

  it("paces a batch by its size", async () => {
    const { starts, options } = setUp((ids) => new Map(ids.map((id) => [id, ok(id)])));
    await lookupAll(["1", "2", "3"], { ...options, batchSize: 2 });
    expect(starts).toEqual([0, 40_000]);
  });

  it("asks again once an answer is older than its TTL", async () => {
    const { calls, options, advance } = setUp((ids) => new Map(ids.map((id) => [id, { status: "not-found" }])));
    await lookupAll(["1"], options);
    advance(CACHE_TTL_MS["not-found"] + 1);
    await lookupAll(["1"], options);
    expect(calls).toEqual([["1"], ["1"]]);
  });

  it("backs off 5, 10, then 20 minutes when rate limited, then stops cleanly, caching nothing it was refused", async () => {
    const { calls, sleeps, logs, options, cache } = setUp((ids) => new Map(ids.map((id) => [id, limited])));
    expect(await lookupAll(["1", "2"], options)).toEqual({ fromCache: 0, fetched: 0, stoppedByRateLimit: true });
    expect(calls).toHaveLength(4);
    expect(sleeps.filter((ms) => ms >= MINUTE)).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE]);
    expect(cache.get("1", options.now())).toBeNull();
    expect(logs.at(-1)).toMatch(/Stopped: still rate limited after 3 back-offs/);
  });

  it("caps the back-off at an hour, and starts again from 5 minutes after a success", async () => {
    const answers = [true, true, true, false, true, false];
    const { sleeps, options } = setUp((ids, call) => new Map(ids.map((id) => [id, answers[call - 1] === true ? limited : ok(id)])));
    await lookupAll(["1", "2"], { ...options, firstBackoffMs: 25 * MINUTE });
    expect(sleeps.filter((ms) => ms >= MINUTE)).toEqual([25 * MINUTE, 50 * MINUTE, 60 * MINUTE, 25 * MINUTE]);
  });
});

describe("uploaderEvidence", () => {
  const named = { artist: "Tinwhistle", originalArtist: "Moss Harbor", remixer: "Tinwhistle" };

  it("counts the uploader only when it is the remixer or the artist the title starts with", () => {
    expect(uploaderEvidence("TINWHISTLE", [named])).toBe("remixer");
    expect(uploaderEvidence("Moss Harbor", [named])).toBe("original-artist");
    expect(uploaderEvidence("Kit Lane", [{ artist: "Kit Lane", originalArtist: null, remixer: null }])).toBe("artist-prefix");
    expect(uploaderEvidence("Someone Else", [named])).toBeNull();
    // One of several remixers uploading counts for the whole credit.
    expect(uploaderEvidence("Kit Lane", [{ artist: "Kit Lane & Arlo", originalArtist: "Moss Harbor", remixer: "Kit Lane & Arlo" }])).toBe("remixer");
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
