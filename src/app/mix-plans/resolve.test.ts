import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanTrack } from "@shared/mix-plan.ts";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import { hashTrackBytes } from "@shared/track-hash.ts";
import type { FolderFile } from "@tracks";
import { gridForFile, hashAsTrack, resolvePlanTracks } from "./resolve.ts";

/** A library file whose bytes are `text`; counts how often it is opened. */
function libraryFile(name: string, text: string, known: Partial<Pick<FolderFile, "durationSec" | "contentHash" | "rekordboxGrid">> = {}) {
  const read = vi.fn(() => Promise.resolve(new File([text], name)));
  const file: FolderFile = { trackId: `Music/${name}|1|1`, name, album: null, durationSec: null, contentHash: null, rekordboxGrid: null, read, ...known };
  return { file, read };
}

/** A plan track whose file holds `text` and lasts `durationMs`. */
async function planTrack(fileName: string, text: string, durationMs = 300_000): Promise<PlanTrack> {
  const [track] = testPlan(2).plan.tracks;
  if (track === undefined) throw new Error("testPlan made no tracks");
  return { ...track, fileName, durationMs, contentHash: await hashTrackBytes(new TextEncoder().encode(text), durationMs / 1000) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePlanTracks", () => {
  it("finds a track the library already analysed by its hash, opening nothing", async () => {
    const track = await planTrack("a.mp3", "AAA");
    const renamed = libraryFile("renamed.mp3", "AAA", { contentHash: track.contentHash, durationSec: 300 });

    expect(await resolvePlanTracks([track], [renamed.file])).toEqual([{ kind: "found", matchedBy: "hash", file: renamed.file }]);
    expect(renamed.read).not.toHaveBeenCalled();
  });

  it("hashes same-named files it has not analysed, without decoding them", async () => {
    const track = await planTrack("Kay Grove - Brothers.mp3", "BROTHERS");
    const other = libraryFile("kay grove - brothers.MP3", "SOMETHING ELSE");
    const same = libraryFile("Kay Grove - Brothers.mp3", "BROTHERS");

    expect(await resolvePlanTracks([track], [other.file, same.file])).toEqual([{ kind: "found", matchedBy: "hash", file: same.file }]);
    expect(other.read).toHaveBeenCalledTimes(1);
    expect(same.read).toHaveBeenCalledTimes(1);
  });

  it("falls back to a file with the same name and length but other bytes, saying so", async () => {
    const track = await planTrack("a.mp3", "ORIGINAL");
    const reencoded = libraryFile("a.mp3", "RE-ENCODED", { contentHash: "f".repeat(64), durationSec: 300.4 });
    const tooLong = libraryFile("a.mp3", "EXTENDED MIX", { contentHash: "e".repeat(64), durationSec: 420 });

    expect(await resolvePlanTracks([track], [tooLong.file, reencoded.file])).toEqual([{ kind: "found", matchedBy: "name", file: reencoded.file }]);
    expect(reencoded.read).not.toHaveBeenCalled();
  });

  it("says Find <file> for a track that is not in the library", async () => {
    const track = await planTrack("Gone - Track.mp3", "GONE");
    expect(await resolvePlanTracks([track], [libraryFile("b.mp3", "B").file])).toEqual([
      { kind: "missing", fileName: "Gone - Track.mp3", caption: "Find Gone - Track.mp3" },
    ]);
  });

  it("costs no reads and no decodes in a large library with nothing matching, and sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const library = Array.from({ length: 2000 }, (_, index) => libraryFile(`track ${String(index)}.mp3`, `T${String(index)}`, index % 2 === 0 ? { contentHash: index.toString(16).padStart(64, "a"), durationSec: 200 } : {}));
    const tracks = await Promise.all([planTrack("x.mp3", "X"), planTrack("y.mp3", "Y")]);

    const started = performance.now();
    const resolved = await resolvePlanTracks(tracks, library.map((each) => each.file));

    expect(resolved.map((each) => each.kind)).toEqual(["missing", "missing"]);
    expect(library.every((each) => each.read.mock.calls.length === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("reads only the hashed prefix of a long file", async () => {
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)]);
    const sliced = vi.spyOn(big, "slice");
    await hashAsTrack(big, { durationMs: 1000 });
    expect(sliced).toHaveBeenCalledWith(0, 4 * 1024 * 1024);
  });
});

describe("gridForFile", () => {
  const cachedGrid = vi.fn((hash: string) => Promise.resolve(hash === "h".repeat(64) ? testGrid({ bpm: 126 }) : null));

  it("prefers rekordbox's grid, analysing nothing", async () => {
    const analyse = vi.fn(() => Promise.resolve(null));
    const { file } = libraryFile("a.mp3", "A", { rekordboxGrid: { bpm: 124, firstBeatSec: 0.05, downbeatPhase: 1 }, durationSec: 250 });

    expect(await gridForFile(file, { durationMs: 250_000 }, { cachedGrid, analyse })).toEqual({ bpm: 124, firstBeatSec: 0.05, downbeatPhase: 1, durationSec: 250 });
    expect(analyse).not.toHaveBeenCalled();
  });

  it("uses the analysis cache, analysing only this file when it has not been yet", async () => {
    const { file } = libraryFile("a.mp3", "A");
    const analyse = vi.fn((trackId: string) => Promise.resolve(trackId === file.trackId ? { ...file, contentHash: "h".repeat(64) } : null));

    expect(await gridForFile(file, { durationMs: 300_000 }, { cachedGrid, analyse })).toEqual(testGrid({ bpm: 126 }));
    expect(analyse).toHaveBeenCalledExactlyOnceWith(file.trackId);
    expect(await gridForFile({ ...file, trackId: "gone" }, { durationMs: 300_000 }, { cachedGrid, analyse })).toBeNull();
  });

  it("falls back to a dj-core grid of this one file when no analysis was cached (no model installed)", async () => {
    const hash = "e".repeat(64);
    const { file } = libraryFile("local.mp3", "Local", { contentHash: hash, durationSec: 200 });
    const analyse = vi.fn(() => Promise.resolve(null));
    const fallbackGrid = vi.fn(() => Promise.resolve(testGrid({ bpm: 128, durationSec: 200 })));

    expect(await gridForFile(file, { durationMs: 200_000 }, { cachedGrid, analyse, fallbackGrid })).toEqual(testGrid({ bpm: 128, durationSec: 200 }));
    expect(fallbackGrid).toHaveBeenCalledExactlyOnceWith(file, hash);
    // A cached analysis wins: no fallback.
    fallbackGrid.mockClear();
    await gridForFile({ ...file, contentHash: "h".repeat(64) }, { durationMs: 200_000 }, { cachedGrid, analyse, fallbackGrid });
    expect(fallbackGrid).not.toHaveBeenCalled();
  });
});
