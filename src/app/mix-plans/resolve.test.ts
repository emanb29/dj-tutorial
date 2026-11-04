import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanTrack } from "@shared/mix-plan.ts";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import { CONTENT_HASH_PREFIX_BYTES, hashTrackBytes } from "@shared/track-hash.ts";
import { MUSIC_LIBRARY_PATH, type MusicLibraryIndex } from "@shared/music-library.ts";
import { blobPrefix, createMusicFolder, probeServerLibrary, scanServerLibrary, type FolderFile } from "@tracks";
import { gridForFile, hashAsTrack, resolvePlanTracks } from "./resolve.ts";

/** A library file whose bytes are `text`; counts how often it is opened whole, and how often its start is read. */
function libraryFile(name: string, text: string, known: Partial<Pick<FolderFile, "durationSec" | "contentHash" | "rekordboxGrid">> = {}) {
  const read = vi.fn(() => Promise.resolve(new File([text], name)));
  const readPrefix = vi.fn((length: number) => blobPrefix(new File([text], name))(length));
  const file: FolderFile = { trackId: `Music/${name}|1|1`, name, album: null, durationSec: null, contentHash: null, rekordboxGrid: null, read, readPrefix, ...known };
  return { file, read, readPrefix };
}

/** A fake API holding one library file, `bytes`, that honours single byte ranges as server/byte-range.ts does. Counts the bytes it sends. */
function rangeServer(path: string, bytes: Uint8Array) {
  const index: MusicLibraryIndex = { configured: true, name: "Music", files: [{ path, size: bytes.length, lastModified: 1 }], xml: [], rekordboxXml: null, skipped: 0, truncated: false };
  const sent = { bytes: 0, ranges: [] as (string | null)[] };
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === MUSIC_LIBRARY_PATH) return Promise.resolve(Response.json({ success: true, data: index }));
    const range = new Headers(init?.headers).get("range");
    sent.ranges.push(range);
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = Number(match?.[1] ?? 0);
    const end = Math.min(Number(match?.[2] ?? bytes.length - 1), bytes.length - 1);
    const body = bytes.slice(start, end + 1);
    sent.bytes += body.length;
    const headers: Record<string, string> = match === null ? {} : { "content-range": `bytes ${String(start)}-${String(end)}/${String(bytes.length)}` };
    return Promise.resolve(new Response(body, { status: match === null ? 200 : 206, headers }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
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
    expect(renamed.readPrefix).not.toHaveBeenCalled();
  });

  it("hashes same-named files it has not analysed, without decoding them", async () => {
    const track = await planTrack("Kay Grove - Brothers.mp3", "BROTHERS");
    const other = libraryFile("kay grove - brothers.MP3", "SOMETHING ELSE");
    const same = libraryFile("Kay Grove - Brothers.mp3", "BROTHERS");

    expect(await resolvePlanTracks([track], [other.file, same.file])).toEqual([{ kind: "found", matchedBy: "hash", file: same.file }]);
    expect(other.readPrefix).toHaveBeenCalledExactlyOnceWith(CONTENT_HASH_PREFIX_BYTES);
    expect(same.readPrefix).toHaveBeenCalledExactlyOnceWith(CONTENT_HASH_PREFIX_BYTES);
    expect([other.read, same.read].every((read) => read.mock.calls.length === 0)).toBe(true);
  });

  it("falls back to a file with the same name and length but other bytes, saying so", async () => {
    const track = await planTrack("a.mp3", "ORIGINAL");
    const reencoded = libraryFile("a.mp3", "RE-ENCODED", { contentHash: "f".repeat(64), durationSec: 300.4 });
    const tooLong = libraryFile("a.mp3", "EXTENDED MIX", { contentHash: "e".repeat(64), durationSec: 420 });

    expect(await resolvePlanTracks([track], [tooLong.file, reencoded.file])).toEqual([{ kind: "found", matchedBy: "name", file: reencoded.file }]);
    expect(reencoded.readPrefix).not.toHaveBeenCalled();
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
    expect(library.every((each) => each.read.mock.calls.length + each.readPrefix.mock.calls.length === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("reads only the hashed prefix of a long file", async () => {
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)]);
    const sliced = vi.spyOn(big, "slice");
    await hashAsTrack(blobPrefix(big), { durationMs: 1000 });
    expect(sliced).toHaveBeenCalledWith(0, 4 * 1024 * 1024);
  });

  it("finds a file in the server's library with one Range request for its first 4 MB, hashing it as the local file", async () => {
    const bytes = Uint8Array.from({ length: CONTENT_HASH_PREFIX_BYTES + 1024 * 1024 }, (_, index) => (index * 31) % 251);
    const local = new File([bytes], "Kay Grove - Brothers.mp3");
    const track: PlanTrack = { ...(await planTrack("Kay Grove - Brothers.mp3", "")), contentHash: await hashAsTrack(blobPrefix(local), { durationMs: 300_000 }) };
    const server = rangeServer("House/Kay Grove - Brothers.mp3", bytes);
    const music = createMusicFolder({
      analyse: () => Promise.reject(new Error("resolving never decodes")),
      scan: (root, options) => scanServerLibrary({ fetch: server.fetch })(root, options),
      watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
      server: () => probeServerLibrary({ fetch: server.fetch }),
      notifyEveryMs: 0,
    });
    await music.start();
    await music.settled();

    const [resolved] = await resolvePlanTracks([track], music.files());

    expect(resolved).toMatchObject({ kind: "found", matchedBy: "hash", file: { name: "Kay Grove - Brothers.mp3" } });
    expect(server.sent).toEqual({ bytes: CONTENT_HASH_PREFIX_BYTES, ranges: [`bytes=0-${String(CONTENT_HASH_PREFIX_BYTES - 1)}`] });
    music.dispose();
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
});
