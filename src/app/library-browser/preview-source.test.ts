import { describe, expect, it, vi } from "vitest";
import type { TrackAnalysis } from "@analysis";
import type { FolderFile } from "@tracks";
import { folderPreview } from "./preview-source.ts";

function file(known: Partial<FolderFile> = {}) {
  const read = vi.fn(() => Promise.resolve(new File(["x"], "a.mp3")));
  const folderFile: FolderFile = { trackId: "Music/a.mp3|1|1", name: "a.mp3", album: null, durationSec: 300, contentHash: null, rekordboxGrid: null, cues: [], read, readPrefix: () => Promise.resolve(new ArrayBuffer(0)), media: { kind: "file", read }, ...known };
  return { folderFile, read };
}

const analysis = { bpm: 125, firstBeatSec: 0.2, downbeatPhase: 1, durationSec: 301, phraseHints: [{ timeSec: 61.64, bar: 33, energyChangeDb: 8, kind: "energy-up" }, { timeSec: 120, bar: 63, energyChangeDb: -8, kind: "energy-down" }] } as unknown as TrackAnalysis;

describe("a music-folder file as a preview", () => {
  it("streams the folder's media, opening nothing to build it or to find its hints", async () => {
    const { folderFile, read } = file({ cues: [{ kind: "memory", slot: null, startSec: 64, name: "Drop" }], rekordboxGrid: { bpm: 120, firstBeatSec: 0.1, downbeatPhase: 2 } });
    const preview = folderPreview(folderFile, null);
    expect(preview.media).toBe(folderFile.media);
    expect(await preview.hints()).toEqual({ durationSec: 300, cues: folderFile.cues, energyRises: [], grid: { bpm: 120, barOneSec: 1.1 } });
    expect(read).not.toHaveBeenCalled();
  });

  it("takes the analysis's grid and energy rises from the cache once the file is analysed; rekordbox's grid wins", async () => {
    const cache = { get: vi.fn(() => Promise.resolve(analysis)) };
    const analysed = await folderPreview(file({ contentHash: "hash" }).folderFile, cache).hints();
    expect(cache.get).toHaveBeenCalledWith("hash");
    expect(analysed.grid?.bpm).toBe(125);
    expect(analysed.grid?.barOneSec).toBeCloseTo(0.68, 6);
    expect(analysed.energyRises).toEqual([analysis.phraseHints[0]]);

    const both = await folderPreview(file({ contentHash: "hash", rekordboxGrid: { bpm: 124, firstBeatSec: 0, downbeatPhase: 0 } }).folderFile, cache).hints();
    expect(both.grid).toEqual({ bpm: 124, barOneSec: 0 });
  });

  it("starts without the analysis when the cache cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = { get: () => Promise.reject(new Error("IndexedDB is blocked")) };
    expect(await folderPreview(file({ contentHash: "hash" }).folderFile, cache).hints()).toEqual({ durationSec: 300, cues: [], energyRises: [] });
  });
});
