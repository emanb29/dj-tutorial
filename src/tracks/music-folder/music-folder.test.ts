import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryHandleStore, type DirectoryHandleLike } from "../local-files.ts";
import { fakeDecoder } from "../test-support.ts";
import { memoryEntryCache } from "./entry-cache.ts";
import { createMusicFolder, type AnalyseFileResult, type MusicFolderOptions } from "./music-folder.ts";
import { scanFolder, type ScanOptions } from "./scan.ts";
import { fakeFolder, type FakeFolder } from "./test-support.ts";

/** An analyser that answers from the file's text: "BAD…" fails, anything else is 120 BPM. Records each call. */
function fakeAnalyser() {
  const calls: string[] = [];
  const analyse = async (file: File, signal: AbortSignal): Promise<AnalyseFileResult> => {
    calls.push(file.name);
    const text = await file.text();
    if (signal.aborted) return { ok: false, kind: "aborted" };
    if (text.startsWith("BAD")) return { ok: false, kind: "failed", reason: "The browser could not decode it." };
    return { ok: true, contentHash: `hash-${file.name}`, bpm: 120, durationSec: 200 };
  };
  return { analyse, calls };
}

function setUp(folder: FakeFolder | null, overrides: Partial<MusicFolderOptions> = {}) {
  const analyser = fakeAnalyser();
  const handleStore = memoryHandleStore();
  const entryCache = memoryEntryCache();
  const options: MusicFolderOptions = {
    analyse: analyser.analyse,
    entryCache,
    handleStore,
    showDirectoryPicker: folder === null ? null : () => Promise.resolve(folder),
    scan: scanFolder,
    watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
    ...overrides,
  };
  const music = createMusicFolder(options);
  return { music, analyser, handleStore, entryCache, options };
}

const titles = (music: ReturnType<typeof createMusicFolder>) => music.tracks().map((track) => track.title).toSorted();

describe("music folder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists its files with what is known of each, reading none of them", async () => {
    const folder = fakeFolder("Music", { "House/a.mp3": "a", "b.mp3": "b" });
    const { music, analyser } = setUp(folder);
    await music.pick();
    await music.settled();

    const known = () => music.files().map(({ name, contentHash, durationSec, rekordboxGrid }) => ({ name, contentHash, durationSec, rekordboxGrid }));
    expect(known().toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "a.mp3", contentHash: null, durationSec: null, rekordboxGrid: null },
      { name: "b.mp3", contentHash: null, durationSec: null, rekordboxGrid: null },
    ]);
    expect(analyser.calls).toEqual([]);

    music.setBackgroundPaused(false);
    await music.settled();
    const a = music.files().find((file) => file.name === "a.mp3");
    expect(a).toMatchObject({ contentHash: "hash-a.mp3", durationSec: 200 });
    expect(await (await a?.read())?.text()).toBe("a");
  });

  it("lists the picked folder's audio as tracks and remembers the folder", async () => {
    const folder = fakeFolder("Music", { "Kay Grove - Brothers.mp3": "a", "House/loop.wav": "b", "cover.jpg": "x" });
    const { music, handleStore } = setUp(folder);

    expect(await music.pick()).toEqual({ ok: true });
    await music.settled();

    expect(titles(music)).toEqual(["Brothers", "loop"]);
    expect(music.tracks().find((track) => track.title === "Brothers")).toMatchObject({ artist: "Kay Grove", source: "local-file", shareable: false });
    expect(music.snapshot()).toMatchObject({ folder: "Music", access: "granted", found: 2, scanning: false, refresh: "polling" });
    expect(await handleStore.get()).toBe(folder);
  });

  it("shows tracks while the walk is still going", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    let finish: () => void = () => undefined;
    const slowScan = async (root: DirectoryHandleLike, options: ScanOptions) => {
      const summary = await scanFolder(root, options);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return summary;
    };
    const { music } = setUp(folder, { scan: slowScan });

    await music.pick();
    await vi.waitFor(() => {
      expect(music.tracks()).toHaveLength(2);
    });
    expect(music.snapshot().scanning).toBe(true);

    finish();
    await music.settled();
    expect(music.snapshot().scanning).toBe(false);
  });

  it("switches to a folder picked while the last one is still being walked, keeping nothing of the old one", async () => {
    const first = fakeFolder("Old", { "old.mp3": "o" });
    const second = fakeFolder("New", { "new.mp3": "n" });
    let release: () => void = () => undefined;
    const slowFirst = async (root: DirectoryHandleLike, options: ScanOptions) => {
      if (root === first) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return scanFolder(root, options);
    };
    const folders = [first, second];
    const { music } = setUp(null, { scan: slowFirst, showDirectoryPicker: () => Promise.resolve(folders.shift() ?? second) });

    await music.pick();
    await music.pick();
    release();
    await music.settled();

    expect(titles(music)).toEqual(["new"]);
    expect(music.snapshot()).toMatchObject({ folder: "New", found: 1 });
  });

  it("finds each track's BPM in the background, one at a time, once allowed to", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    const { music, analyser } = setUp(folder);

    await music.pick();
    await music.settled();
    expect(analyser.calls).toEqual([]);

    music.setBackgroundPaused(false);
    await music.settled();

    expect(analyser.calls.toSorted()).toEqual(["a.mp3", "b.mp3"]);
    expect(music.snapshot()).toMatchObject({ found: 2, analysed: 2, failed: 0 });
    expect(music.tracks().map((track) => track.bpmHint)).toEqual([120, 120]);
  });

  it("remembers what it analysed, so a rescan, or the next visit, analyses nothing again", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    const first = setUp(folder);
    first.music.setBackgroundPaused(false);
    await first.music.pick();
    await first.music.settled();

    await first.music.rescan();
    await first.music.settled();
    expect(first.analyser.calls).toHaveLength(2);

    const later = setUp(folder, { entryCache: first.entryCache, handleStore: first.handleStore });
    later.music.setBackgroundPaused(false);
    await later.music.start();
    await later.music.settled();
    expect(later.analyser.calls).toEqual([]);
    expect(later.music.snapshot()).toMatchObject({ found: 2, analysed: 2 });
  });

  it("picks up new files, drops removed ones and analyses changed ones again on a rescan", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b", "c.mp3": "c" });
    const { music, analyser } = setUp(folder);
    music.setBackgroundPaused(false);
    await music.pick();
    await music.settled();

    folder.write("new.mp3", "n");
    folder.remove("b.mp3");
    folder.write("c.mp3", "c, re-exported", 1_800_000_000_000);
    await music.rescan();
    await music.settled();

    expect(titles(music)).toEqual(["a", "c", "new"]);
    expect(analyser.calls.toSorted()).toEqual(["a.mp3", "b.mp3", "c.mp3", "c.mp3", "new.mp3"]);
    expect(music.snapshot()).toMatchObject({ found: 3, analysed: 3 });
  });

  it("counts files that will not decode, warns once, and does not try them again until they change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = fakeFolder("Music", { "good.mp3": "a", "broken.mp3": "BAD" });
    const { music, analyser } = setUp(folder);
    music.setBackgroundPaused(false);
    await music.pick();
    await music.settled();
    await music.rescan();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ found: 2, analysed: 1, failed: 1 });
    expect(analyser.calls.filter((name) => name === "broken.mp3")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("tracks.folder.notAnalysed", expect.objectContaining({ path: "Music/broken.mp3" }));
  });

  it("counts files it cannot read as skipped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    folder.breakFile("b.mp3");
    const { music } = setUp(folder);

    await music.pick();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ found: 1, skipped: 1 });
  });

  it("analyses a track the Learner is about to use first, even while the background waits", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b", "c.mp3": "c" });
    const { music, analyser } = setUp(folder);
    await music.pick();
    await music.settled();

    const wanted = music.tracks().find((track) => track.title === "c");
    if (wanted === undefined) throw new Error("c.mp3 was not listed");
    await music.ready(wanted.id, new AbortController().signal);

    expect(analyser.calls).toEqual(["c.mp3"]);
    expect(music.tracks().find((track) => track.id === wanted.id)?.bpmHint).toBe(120);
  });

  it("stops a background analysis for a wanted track, and comes back to it later", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    const started: string[] = [];
    let release: () => void = () => undefined;
    const analyse = async (file: File, signal: AbortSignal): Promise<AnalyseFileResult> => {
      started.push(file.name);
      if (file.name === "a.mp3" && started.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      return signal.aborted ? { ok: false, kind: "aborted" } : { ok: true, contentHash: file.name, bpm: 128, durationSec: 100 };
    };
    const { music } = setUp(folder, { analyse });
    await music.pick();
    await music.settled();
    music.setBackgroundPaused(false);
    await vi.waitFor(() => {
      expect(started).toEqual(["a.mp3"]);
    });

    const b = music.tracks().find((track) => track.title === "b");
    if (b === undefined) throw new Error("b.mp3 was not listed");
    await music.ready(b.id, new AbortController().signal);
    release();
    await music.settled();

    expect(started).toEqual(["a.mp3", "b.mp3", "a.mp3"]);
    expect(music.snapshot()).toMatchObject({ analysed: 2 });
  });

  it("still finishes a track someone waits for when its background run gives way to another wanted track", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a", "b.mp3": "b" });
    const analyse = async (file: File, signal: AbortSignal): Promise<AnalyseFileResult> => {
      if (file.name === "a.mp3") {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
          setTimeout(resolve, 50);
        });
      }
      return signal.aborted ? { ok: false, kind: "aborted" } : { ok: true, contentHash: file.name, bpm: 128, durationSec: 100 };
    };
    const { music } = setUp(folder, { analyse });
    await music.pick();
    await music.settled();
    music.setBackgroundPaused(false);
    const [a, b] = ["a", "b"].map((title) => music.tracks().find((track) => track.title === title)?.id ?? "");
    const waitingForA = music.ready(a ?? "", new AbortController().signal);
    music.setBackgroundPaused(true);
    music.want(b ?? "");

    await waitingForA;
    await music.settled();
    expect(music.snapshot()).toMatchObject({ analysed: 2 });
  });

  it("asks nothing on start when the browser needs a click to read the folder again; Allow access asks", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a" });
    const { music, handleStore } = setUp(folder);
    await handleStore.put(folder);
    folder.permission = "prompt";

    await music.start();
    expect(music.snapshot()).toMatchObject({ folder: "Music", access: "needs-permission", found: 0 });
    expect(folder.permissionRequests).toBe(0);

    folder.permission = "granted";
    expect(await music.allowAccess()).toEqual({ ok: true });
    await music.settled();
    expect(folder.permissionRequests).toBe(1);
    expect(music.snapshot()).toMatchObject({ access: "granted", found: 1 });
  });

  it("says why when the browser refuses the folder", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a" });
    const { music, handleStore } = setUp(folder);
    await handleStore.put(folder);
    folder.permission = "denied";

    await music.start();
    const allowed = await music.allowAccess();

    expect(allowed).toMatchObject({ ok: false, error: { kind: "permission-denied" } });
    expect(music.snapshot().access).toBe("needs-permission");
  });

  it("changes nothing when the Learner closes the picker", async () => {
    const { music } = setUp(null, { showDirectoryPicker: () => Promise.reject(new DOMException("The user aborted a request.", "AbortError")) });

    expect(await music.pick()).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(music.snapshot()).toMatchObject({ folder: null, access: "none" });
  });

  it("says the picker needs a click when it is pressed from the controller", async () => {
    const { music } = setUp(null, {
      showDirectoryPicker: () => Promise.reject(new DOMException("Must be handling a user gesture to show a file picker.", "SecurityError")),
    });

    const picked = await music.pick();

    expect(picked).toMatchObject({ ok: false, error: { kind: "permission-denied" } });
    if (!picked.ok) expect(picked.error.message).toMatch(/click, tap or key/);
  });

  it("still uses a folder it could not remember (a handle IndexedDB cannot store)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = fakeFolder("Music", { "a.mp3": "a" });
    const handleStore = { ...memoryHandleStore(), put: () => Promise.reject(new DOMException("could not be cloned", "DataCloneError")) };
    const { music } = setUp(folder, { handleStore });

    expect(await music.pick()).toEqual({ ok: true });
    await music.settled();
    expect(music.snapshot().found).toBe(1);
  });

  it("imports a folder from a file input where the browser cannot pick one (Android)", async () => {
    const { music } = setUp(null);
    const file = (path: string, text: string) => {
      const made = new File([text], path.split("/").pop() ?? path, { lastModified: 5 });
      Object.defineProperty(made, "webkitRelativePath", { value: path });
      return made;
    };

    expect(music.snapshot().canPick).toBe(false);
    music.importFiles([file("Phone/a.mp3", "a"), file("Phone/sub/b.mp3", "b"), file("Phone/notes.txt", "x")]);
    await music.settled();

    expect(titles(music)).toEqual(["a", "b"]);
    expect(music.snapshot()).toMatchObject({ folder: "Phone", access: "imported", found: 2, refresh: null });

    music.importFiles([file("Phone/a.mp3", "a")]);
    await music.settled();
    expect(titles(music)).toEqual(["a"]);
  });

  it("loads a listed track through the decoder it is given, and refuses one that is gone", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "ID3a" });
    const { music } = setUp(folder);
    await music.pick();
    await music.settled();
    const decoder = fakeDecoder(3);
    const source = music.source(decoder.decode);
    const [track] = music.tracks();
    if (track === undefined) throw new Error("a.mp3 was not listed");

    const loaded = await source.load(track);
    expect(loaded).toMatchObject({ ok: true, value: { track: { durationSec: 3 } } });
    expect(decoder.decoded).toHaveLength(1);

    folder.remove("a.mp3");
    await music.rescan();
    await music.settled();
    expect(await source.load(track)).toMatchObject({ ok: false, error: { kind: "not-found" } });
    expect(await source.list()).toEqual({ ok: true, value: [] });
  });

  it("forgets the folder: no tracks, nothing remembered", async () => {
    const folder = fakeFolder("Music", { "a.mp3": "a" });
    const { music, handleStore } = setUp(folder);
    await music.pick();
    await music.settled();

    await music.forget();

    expect(music.tracks()).toEqual([]);
    expect(music.snapshot()).toMatchObject({ folder: null, access: "none", found: 0 });
    expect(await handleStore.get()).toBeNull();
  });

  it("tells listeners about changes, a few at a time rather than per file", async () => {
    vi.useFakeTimers();
    try {
      const folder = fakeFolder("Music", Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`t${String(index)}.mp3`, "x"])));
      const { music } = setUp(folder);
      const listener = vi.fn();
      music.subscribe(listener);

      await music.pick();
      await vi.runAllTimersAsync();
      await music.settled();
      await vi.runAllTimersAsync();

      expect(music.snapshot().found).toBe(120);
      expect(listener.mock.calls.length).toBeGreaterThan(0);
      expect(listener.mock.calls.length).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
