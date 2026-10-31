import { afterEach, describe, expect, it, vi } from "vitest";
import { diffScan, scanFolder, type ScannedFile } from "./scan.ts";
import { fakeFolder } from "./test-support.ts";

async function scanAll(folder: Parameters<typeof scanFolder>[0], options: Partial<Parameters<typeof scanFolder>[1]> = {}) {
  const batches: (readonly ScannedFile[])[] = [];
  const summary = await scanFolder(folder, { onBatch: (batch) => batches.push(batch), ...options });
  return { batches, files: batches.flat(), summary };
}

describe("scanFolder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds audio files in the folder and its subfolders, with paths, sizes and dates", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "aaaa", "House/b.flac": "bb", "House/Deep/c.wav": "c", "notes.txt": "x", "cover.jpg": "x" });

    const { files, summary } = await scanAll(folder);

    expect(files.map((file) => file.path).toSorted()).toEqual(["Music/House/Deep/c.wav", "Music/House/b.flac", "Music/a.mp3"]);
    expect(files.find((file) => file.name === "a.mp3")).toMatchObject({ size: 4, lastModified: 1_700_000_000_000 });
    expect(summary).toEqual({ files: 3, skipped: 0, truncated: false, xml: [] });
  });

  it("notes .xml files (a rekordbox collection may be one) without counting them as tracks", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "rekordbox.xml": "<DJ_PLAYLISTS/>", "DJ/Export.XML": "x", ".hidden.xml": "x" });

    const { files, summary } = await scanAll(folder);

    expect(files.map((file) => file.name)).toEqual(["a.mp3"]);
    expect(summary.files).toBe(1);
    expect(summary.xml.map((file) => file.path).toSorted()).toEqual(["Music/DJ/Export.XML", "Music/rekordbox.xml"]);
    expect(summary.xml.find((file) => file.name === "rekordbox.xml")).toMatchObject({ size: 15 });
  });

  it("opens only audio files, and skips hidden ones such as macOS's ._ copies", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "._a.mp3": "x", ".DS_Store": "x", "readme.md": "x" });

    const { files } = await scanAll(folder);

    expect(files.map((file) => file.name)).toEqual(["a.mp3"]);
    expect(folder.opened).toBe(1);
  });

  it("hands the files over in batches as it goes, so the library fills in while it walks", async () => {
    const folder = fakeFolder("Music", Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`t${String(index)}.mp3`, "x"])));

    const { batches } = await scanAll(folder, { batchSize: 3 });

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
  });

  it("skips a file it cannot read with a warning, and counts it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    folder.breakFile("b.mp3");

    const { files, summary } = await scanAll(folder);

    expect(files.map((file) => file.name)).toEqual(["a.mp3"]);
    expect(summary.skipped).toBe(1);
    expect(warn).toHaveBeenCalledWith("tracks.folder.unreadable", expect.objectContaining({ path: "Music/b.mp3" }));
  });

  it("stops at the file limit and says it was cut short", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = fakeFolder("Music", Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`t${String(index)}.mp3`, "x"])));

    const { files, summary } = await scanAll(folder, { maxFiles: 3 });

    expect(files).toHaveLength(3);
    expect(summary).toMatchObject({ files: 3, truncated: true });
  });

  it("does not go deeper than the depth limit", async () => {
    const folder = fakeFolder("Music", { "a/b/c/deep.mp3": "x", "a/top.mp3": "x" });

    const { files } = await scanAll(folder, { maxDepth: 2 });

    expect(files.map((file) => file.name)).toEqual(["top.mp3"]);
  });

  it("stops when aborted", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    const abort = new AbortController();
    abort.abort();

    const { files } = await scanAll(folder, { signal: abort.signal });

    expect(files).toEqual([]);
  });
});

describe("diffScan", () => {
  const stamp = (size: number, lastModified = 1) => ({ size, lastModified });

  it("says which paths are new, changed, gone and the same", () => {
    const before = new Map([
      ["Music/same.mp3", stamp(1)],
      ["Music/changed.mp3", stamp(2)],
      ["Music/gone.mp3", stamp(3)],
    ]);
    const after = new Map([
      ["Music/same.mp3", stamp(1)],
      ["Music/changed.mp3", stamp(2, 99)],
      ["Music/new.mp3", stamp(4)],
    ]);

    expect(diffScan(before, after)).toEqual({
      added: ["Music/new.mp3"],
      changed: ["Music/changed.mp3"],
      removed: ["Music/gone.mp3"],
      unchanged: ["Music/same.mp3"],
    });
  });
});
