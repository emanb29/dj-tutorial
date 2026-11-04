/**
 * The Learner's music folder as a library: pick a folder once (File System Access, Chromium), and its
 * audio files become tracks, found in the background and kept up to date.
 *
 * - Scanning is the cheap pass (scan.ts): names, sizes and dates, in a worker for real folders.
 *   Tracks appear batch by batch while it walks; the library is usable at once.
 * - Analysis (decode, beat grid) is the heavy pass: one file at a time, pulled by a worker
 *   (pull-worker.ts) from what is waiting, a track the Learner is about to use (`want`, `ready`)
 *   first. Background analysis waits while `setBackgroundPaused(true)` (the default: a page with
 *   decks un-pauses it while no deck plays), so it never competes with the music.
 * - What was analysed is kept (entry-cache.ts) by path, size and date, so a rescan, or the next
 *   visit, analyses only new and changed files. Files that will not decode are counted, not retried.
 * - Refresh (watch.ts): FileSystemObserver where the browser has it, else a metadata rescan every
 *   30 s while the page is visible; `rescan()` for the button. Removed files drop out.
 * - Without a folder picker (Android Chrome), `importFiles` takes a `webkitdirectory` input's files
 *   once; there is nothing to watch, so a new track needs another import.
 *
 * rekordbox (../rekordbox): with `rekordbox`, a collection picked once, or a rekordbox.xml the scan
 * finds in the folder, gives the files it knows rekordbox's tags, BPM, key and cues; loading one
 * returns rekordbox's grid (where it is one tempo in 4/4) in place of the analysis's guess.
 *
 * The folder's handle is remembered (HandleStore). On a later visit `start()` reads it again only
 * if the browser still allows it; otherwise `access` is "needs-permission" and `allowAccess()`,
 * from a click, asks. Local tracks are not shareable: their licence is unknown.
 *
 * The server's library (`server`, server-library.ts): when the API server has a MUSIC_DIR, `start()`
 * opens that instead, for every browser, and nothing is picked, imported or forgotten here; the
 * folder belongs to the server's .env, and so does its rekordbox.xml (REKORDBOX_XML, or one in the
 * folder), which wins over one this device picked. Without one (or with the API out of reach), as above.
 */
import { abortedError, decodeAndHash, matchesQuery, type AudioDecoder } from "../load-audio.ts";
import { blobPrefix, handlePrefix, hasWords, isAudioFile, memoryHandleStore, trackForFile, type DirectoryHandleLike, type HandleStore, type ReadPrefix } from "../local-files.ts";
import { camelotFromTonality, knownGridFromRekordbox, rekordboxGrid } from "../rekordbox/grid.ts";
import type { RekordboxLink, RekordboxStatus, XmlCandidate } from "../rekordbox/rekordbox-link.ts";
import type { RekordboxTrack } from "../rekordbox/xml.ts";
import type { LoadedTrack, Result, Track, TrackError, TrackSource } from "../types.ts";
import { entryKey, memoryEntryCache, type EntryCache, type EntryRecord } from "./entry-cache.ts";
import { createPullWorker } from "./pull-worker.ts";
import { diffScan, MAX_FOLDER_FILES, type FileStamp, type ScannedFile, type ScanOptions, type ScanSummary } from "./scan.ts";
import type { ServerLibraryProbe } from "./server-library.ts";
import type { FolderWatch, WatchFolder } from "./watch.ts";

/** What analysing one file found. `failed` is kept (not tried again until the file changes); `aborted` is not. */
export type AnalyseFileResult =
  | { readonly ok: true; readonly contentHash: string; readonly bpm: number | null; readonly durationSec: number }
  | { readonly ok: false; readonly kind: "failed"; readonly reason: string }
  | { readonly ok: false; readonly kind: "aborted" };

export type AnalyseFile = (file: File, signal: AbortSignal) => Promise<AnalyseFileResult>;

export interface MusicFolderOptions {
  /** Decodes and analyses a file, caching the grid under its content hash (the app's is src/app/music-folder). */
  readonly analyse: AnalyseFile;
  readonly entryCache?: EntryCache;
  readonly handleStore?: HandleStore;
  /** `window.showDirectoryPicker` by default when it exists; null = this browser cannot pick a folder. */
  readonly showDirectoryPicker?: (() => Promise<DirectoryHandleLike>) | null;
  /** Walks a folder (scanner.ts: a worker where it can). */
  readonly scan: (root: DirectoryHandleLike, options: ScanOptions) => Promise<ScanSummary>;
  /** Starts watching a folder for changes (watch.ts). */
  readonly watch: WatchFolder;
  /** Listeners hear about changes at most this often (default 250 ms), so a big scan does not re-render per file. */
  readonly notifyEveryMs?: number;
  /** The Learner's rekordbox collection; the scan offers it the folder's .xml files. */
  readonly rekordbox?: RekordboxLink;
  /** Asks the API server for its music library (server-library.ts); unset = this browser's folder only. */
  readonly server?: () => Promise<ServerLibraryProbe>;
}

/** rekordbox's part of the snapshot: the collection's status, and how many folder tracks it knows. */
export type MusicFolderRekordbox = RekordboxStatus & { readonly matched: number };

export type FolderAccess = "none" | "needs-permission" | "granted" | "imported";

/** Whose library this is: the API server's (MUSIC_DIR, the same on every device) or a folder this browser picked. */
export type FolderSource = "server" | "device";

export interface MusicFolderSnapshot {
  /** Changes whenever anything below does. */
  readonly version: number;
  readonly source: FolderSource;
  /** Whether this browser can pick (and watch) a folder; false on Android Chrome. */
  readonly canPick: boolean;
  readonly folder: string | null;
  readonly access: FolderAccess;
  readonly scanning: boolean;
  /** How new files are noticed: the browser tells us, or a rescan every 30 s; null when nothing watches. */
  readonly refresh: FolderWatch["how"] | null;
  /** Audio files in the library now. */
  readonly found: number;
  /** Of those, how many have a BPM. */
  readonly analysed: number;
  /** Of those, how many would not decode or had no beat to find. */
  readonly failed: number;
  /** Files the last scan could not read. */
  readonly skipped: number;
  /** Whether the last scan stopped at the file limit. */
  readonly truncated: boolean;
  readonly problem: TrackError | null;
  /** Null when the folder has no rekordbox link. */
  readonly rekordbox: MusicFolderRekordbox | null;
}

export type FolderOutcome = { readonly ok: true } | { readonly ok: false; readonly error: TrackError };

export interface MusicFolder {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => MusicFolderSnapshot;
  /** The rekordbox collection linked to this folder (pick a file, forget it); null without one. */
  readonly rekordbox: RekordboxLink | null;
  /** The library's tracks, in the order they were found. */
  tracks(): readonly Track[];
  /** The library's files with what is already known about each, read from nothing: for finding a file again (src/app/mix-plans). */
  files(): readonly FolderFile[];
  /** Re-opens the remembered folder if the browser still allows it. Asks nothing. */
  start(): Promise<void>;
  /** Shows the folder picker. Call from a click: the browser opens it only for a user gesture. */
  pick(): Promise<FolderOutcome>;
  /** Asks the browser to read the remembered folder again. Call from a click. */
  allowAccess(): Promise<FolderOutcome>;
  /** The files of a `webkitdirectory` input, where there is no picker. Replaces the library. */
  importFiles(files: Iterable<File>): void;
  /** Walks the folder again now (metadata only); new and changed files are then analysed. */
  rescan(): Promise<void>;
  /** Drops the folder: no tracks, nothing remembered. */
  forget(): Promise<void>;
  /** The Learner is about to use this track (the ring is on it): analyse it next. */
  want(trackId: string): void;
  /** Resolves once the track is analysed (or failed, or gone), analysing it first. */
  ready(trackId: string, signal: AbortSignal): Promise<void>;
  /**
   * Whether loading the track now gives a beat grid without waiting: rekordbox has a one-tempo 4/4 grid
   * for it, or the analysis is done. Cheap: picking from a large library starts here, not with decoding.
   */
  gridReady(trackId: string): boolean;
  /** True: background analysis waits (wanted tracks still run). The default is paused. */
  setBackgroundPaused(paused: boolean): void;
  /** The tracks as a TrackSource whose `load` decodes with `decode` (the engine's rate). */
  source(decode: AudioDecoder): TrackSource;
  /** Resolves once no scan or analysis is running or waiting to run (tests). */
  settled(): Promise<void>;
  dispose(): void;
}

type EntryState = "pending" | "analysing" | "analysed" | "failed";

interface Entry {
  readonly path: string;
  readonly key: string;
  readonly stamp: FileStamp;
  readonly read: () => Promise<File>;
  readonly readPrefix: ReadPrefix;
  /** What the file name and the analysis say. */
  base: Track;
  /** The rekordbox entry for this file, when the collection has one. */
  linked: RekordboxTrack | null;
  /** `base` with rekordbox's tags over it: what the library shows. */
  track: Track;
  state: EntryState;
  /** The analysis cache's key, once the file is analysed (now or on an earlier visit). */
  contentHash: string | null;
}

/** One file of the library, as far as it is known without reading it. */
export interface FolderFile {
  readonly trackId: string;
  /** The file's own name (no folder). */
  readonly name: string;
  /** rekordbox's Album for the file; null when it has none. */
  readonly album: string | null;
  /** Known once analysed, or from rekordbox. */
  readonly durationSec: number | null;
  /** The analysis cache's key (shared/track-hash.ts), once analysed; null before. */
  readonly contentHash: string | null;
  /** rekordbox's grid for the file, where it is one tempo in 4/4; it wins over the analysis's. */
  readonly rekordboxGrid: { readonly bpm: number; readonly firstBeatSec: number; readonly downbeatPhase: number } | null;
  /** Opens the file (nothing is read until something reads it). */
  readonly read: () => Promise<File>;
  /** Reads only the file's first bytes: a file in the server's library sends just those, not all of it. */
  readonly readPrefix: ReadPrefix;
}

/** A wanted track goes ahead of these many others at most; older wishes are dropped (the background gets them). */
const MAX_WANTED = 16;
const ANALYSIS_CONCURRENCY = 1;

function defaultPicker(): (() => Promise<DirectoryHandleLike>) | null {
  const candidate = (globalThis as { showDirectoryPicker?: (options: object) => Promise<DirectoryHandleLike> }).showDirectoryPicker;
  return candidate === undefined ? null : () => candidate.call(globalThis, { mode: "read", id: "learn-to-dj-music-folder" });
}

function permissionDenied(name: string): TrackError {
  return {
    kind: "permission-denied",
    message: `The browser did not allow reading "${name}".`,
    fix: "Press Allow access and say yes, or pick the folder again.",
  };
}

const NEEDS_GESTURE: TrackError = {
  kind: "permission-denied",
  message: "The browser opens the folder picker only from a click, tap or key.",
  fix: "Click or tap Pick a folder.",
};

const ON_SERVER: TrackError = {
  kind: "unsupported",
  message: "This app's music library is the server's folder (MUSIC_DIR), the same on every device.",
  fix: "To change it, set MUSIC_DIR in the server's .env and restart the API.",
};

const isDomError = (error: unknown, ...names: readonly string[]) => error instanceof DOMException && names.includes(error.name);

const filled = (text: string) => text.trim() !== "";

/** A file's track with what rekordbox knows over it: the Learner's own tags, BPM and key there win. */
function withRekordbox(base: Track, linked: RekordboxTrack | null): Track {
  if (linked === null) return base;
  const camelot = camelotFromTonality(linked.tonality);
  const bpm = linked.averageBpm ?? linked.tempos[0]?.bpm ?? null;
  const key = camelot ?? (filled(linked.tonality) ? linked.tonality.trim() : null);
  return {
    ...base,
    // A title of only punctuation ("-") is as good as none: the file name's stays.
    ...(hasWords(linked.name) ? { title: linked.name.trim() } : {}),
    ...(filled(linked.artist) ? { artist: linked.artist.trim() } : {}),
    ...(filled(linked.genre) ? { genre: linked.genre.trim() } : {}),
    ...(bpm === null ? {} : { bpmHint: bpm }),
    ...(key === null ? {} : { keyHint: key }),
    ...(linked.rating > 0 ? { rating: linked.rating } : {}),
    ...(linked.playCount > 0 ? { playCount: linked.playCount } : {}),
    ...(base.durationSec === undefined && linked.totalTimeSec !== null ? { durationSec: linked.totalTimeSec } : {}),
  };
}

/** What a scan or an import found that is a candidate rekordbox.xml. */
const xmlCandidates = (files: readonly ScannedFile[]): XmlCandidate[] =>
  files.map((file) => ({ path: file.path, stamp: { size: file.size, lastModified: file.lastModified }, read: () => file.handle.getFile() }));

export function createMusicFolder(options: MusicFolderOptions): MusicFolder {
  const entryCache = options.entryCache ?? memoryEntryCache();
  const handleStore = options.handleStore ?? memoryHandleStore();
  const picker = options.showDirectoryPicker === undefined ? defaultPicker() : options.showDirectoryPicker;
  const notifyEveryMs = options.notifyEveryMs ?? 250;

  const rekordbox = options.rekordbox ?? null;
  const entries = new Map<string, Entry>();
  const pathByKey = new Map<string, string>();
  /** Paths waiting for analysis, in the order found. */
  const pending = new Set<string>();
  /** Paths the Learner wants soon, newest first. */
  let wanted: string[] = [];
  const waiters = new Map<string, (() => void)[]>();
  const listeners = new Set<() => void>();

  let handle: DirectoryHandleLike | null = null;
  let librarySource: FolderSource = "device";
  let access: FolderAccess = "none";
  let folderName: string | null = null;
  let problem: TrackError | null = null;
  let skipped = 0;
  let truncated = false;
  let watch: FolderWatch | null = null;
  let backgroundPaused = true;
  let current: { path: string; wanted: boolean; abort: AbortController } | null = null;
  let scanning: Promise<void> | null = null;
  let scanAgain = false;
  let scanAbort = new AbortController();
  let disposed = false;
  // Read afresh after an await: TypeScript keeps an earlier check's narrowing, but another call
  // (rescan, pick, forget) may have changed these meanwhile.
  const currentHandle = () => handle;
  const currentAccess = () => access;
  const wantsAnotherScan = () => scanAgain;

  let version = 0;
  let cached: MusicFolderSnapshot | null = null;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    version += 1;
    cached = null;
    if (notifyTimer !== null || disposed) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const listener of listeners) listener();
    }, notifyEveryMs);
  };

  const finishWaiters = (path: string) => {
    const waiting = waiters.get(path);
    waiters.delete(path);
    for (const resolve of waiting ?? []) resolve();
  };

  const drop = (path: string) => {
    const entry = entries.get(path);
    if (entry === undefined) return;
    entries.delete(path);
    pathByKey.delete(entry.key);
    pending.delete(path);
    wanted = wanted.filter((each) => each !== path);
    if (current?.path === path) current.abort.abort();
    finishWaiters(path);
  };

  const clearAll = () => {
    for (const path of [...entries.keys()]) drop(path);
    skipped = 0;
    truncated = false;
  };

  // rekordbox: a new or re-read collection relinks every file; the link's own status changes too.
  let linkedLibrary = rekordbox?.library()?.library ?? null;
  let rekordboxWork: Promise<unknown> = Promise.resolve();
  const unlink =
    rekordbox?.subscribe(() => {
      const now = rekordbox.library()?.library ?? null;
      if (now !== linkedLibrary) {
        linkedLibrary = now;
        for (const entry of entries.values()) relink(entry);
      }
      changed();
    }) ?? (() => undefined);
  const offerXml = (files: readonly XmlCandidate[]) => {
    if (rekordbox === null) return;
    rekordboxWork = rekordbox.offerFolderFiles(files).catch((error: unknown) => {
      console.warn("tracks.folder.rekordboxFailed", { error });
    });
  };

  /** Finds the file's rekordbox entry (again: the collection, or the file's known length, changed) and redraws its track. */
  const relink = (entry: Entry) => {
    const { durationSec } = entry.base;
    const facts = { path: entry.path, size: entry.stamp.size, ...(durationSec === undefined ? {} : { durationSec }) };
    entry.linked = rekordbox?.library()?.matcher.match(facts) ?? null;
    entry.track = withRekordbox(entry.base, entry.linked);
  };

  const withBpm = (entry: Entry, record: EntryRecord) => {
    if (record.outcome === "analysed") {
      entry.state = "analysed";
      entry.contentHash = record.contentHash;
      entry.base = { ...entry.base, ...(record.bpm === null ? {} : { bpmHint: record.bpm }), durationSec: record.durationSec };
    } else {
      entry.state = "failed";
    }
    relink(entry);
  };

  const worker = createPullWorker<{ path: string; wanted: boolean }>({
    concurrency: ANALYSIS_CONCURRENCY,
    next: () => {
      const wish = wanted.find((path) => pending.has(path));
      if (wish !== undefined) {
        wanted = wanted.filter((path) => path !== wish);
        pending.delete(wish);
        return { path: wish, wanted: true };
      }
      if (backgroundPaused) return null;
      const first = pending.values().next();
      if (first.done === true) return null;
      pending.delete(first.value);
      return { path: first.value, wanted: false };
    },
    run: async (job) => {
      const entry = entries.get(job.path);
      if (entry?.state !== "pending") return;
      const abort = new AbortController();
      current = { ...job, abort };
      entry.state = "analysing";
      try {
        let result: AnalyseFileResult;
        try {
          result = await options.analyse(await entry.read(), abort.signal);
        } catch (error) {
          result = { ok: false, kind: "failed", reason: `It could not be read: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (entries.get(job.path) !== entry) return;
        if (!result.ok && result.kind === "aborted") {
          entry.state = "pending";
          pending.add(job.path);
          // Someone is waiting for it (ready): it goes ahead again, not to the back of the background.
          if (waiters.has(job.path)) wanted = [job.path, ...wanted.filter((path) => path !== job.path)].slice(0, MAX_WANTED);
          return;
        }
        const record: EntryRecord = result.ok
          ? { key: entry.key, outcome: "analysed", contentHash: result.contentHash, bpm: result.bpm, durationSec: result.durationSec }
          : { key: entry.key, outcome: "failed", reason: result.reason };
        if (record.outcome === "failed") console.warn("tracks.folder.notAnalysed", { path: entry.path, reason: record.reason });
        withBpm(entry, record);
        finishWaiters(job.path);
        changed();
        try {
          await entryCache.put(record);
        } catch (error) {
          console.warn("tracks.folder.cacheWriteFailed", { path: entry.path, error });
        }
      } finally {
        current = null;
      }
    },
  });

  /** Adds a batch of found files: unchanged ones stay, new and changed ones take their cached result or wait for analysis. */
  const absorb = async (found: readonly { path: string; name: string; stamp: FileStamp; read: () => Promise<File>; readPrefix: ReadPrefix }[], signal: AbortSignal) => {
    const fresh = found.filter(({ path, stamp }) => {
      const known = entries.get(path);
      return known?.stamp.size !== stamp.size || known.stamp.lastModified !== stamp.lastModified;
    });
    if (fresh.length === 0) return;
    const records = await entryCache.getMany(fresh.map(({ path, stamp }) => entryKey(path, stamp.size, stamp.lastModified)));
    // A batch from a walk that was stopped (another folder picked, forgotten) must not come back.
    if (signal.aborted) return;
    for (const { path, name, stamp, read, readPrefix } of fresh) {
      drop(path);
      const track = trackForFile({ name, ...stamp }, path);
      const entry: Entry = { path, key: track.id, stamp, read, readPrefix, base: track, linked: null, track, state: "pending", contentHash: null };
      entries.set(path, entry);
      pathByKey.set(entry.key, path);
      const record = records.get(entry.key);
      if (record === undefined) {
        pending.add(path);
        relink(entry);
      } else withBpm(entry, record);
    }
    changed();
    worker.wake();
  };

  const walk = async (root: DirectoryHandleLike): Promise<void> => {
    const before = new Map([...entries].map(([path, entry]) => [path, entry.stamp] as const));
    const seen = new Map<string, FileStamp>();
    const signal = scanAbort.signal;
    let absorbing = Promise.resolve();
    const onBatch = (batch: readonly ScannedFile[]) => {
      const found = batch.map((file) => {
        const stamp = { size: file.size, lastModified: file.lastModified };
        seen.set(file.path, stamp);
        return { path: file.path, name: file.name, stamp, read: () => file.handle.getFile(), readPrefix: handlePrefix(file.handle) };
      });
      absorbing = absorbing.then(() => absorb(found, signal));
    };
    try {
      const summary = await options.scan(root, { onBatch, signal, maxFiles: MAX_FOLDER_FILES });
      await absorbing;
      if (signal.aborted || handle !== root) return;
      skipped = summary.skipped;
      truncated = summary.truncated;
      problem = null;
      // A walk cut short may not have reached the XML: it says nothing about one being gone.
      if (!summary.truncated || summary.xml.length > 0) offerXml(xmlCandidates(summary.xml));
      // A walk cut short says nothing about the files it did not reach: keep them.
      if (!summary.truncated) for (const path of diffScan(before, seen).removed) drop(path);
    } catch (error) {
      await absorbing;
      if (signal.aborted || currentHandle() !== root) return;
      if (isDomError(error, "NotAllowedError", "SecurityError")) {
        access = "needs-permission";
        problem = permissionDenied(root.name);
      } else if (isDomError(error, "NotFoundError")) {
        problem = { kind: "not-found", message: `The folder "${root.name}" is gone or was moved.`, fix: "Pick the folder again." };
      } else {
        throw error;
      }
    }
  };

  /** One walk at a time; asking during one walks again after it, the folder held then (it may be a new one). */
  const scan = (): Promise<void> => {
    if (handle === null || access !== "granted" || disposed) return Promise.resolve();
    if (scanning !== null) {
      scanAgain = true;
      return scanning;
    }
    scanning = (async () => {
      changed();
      try {
        do {
          scanAgain = false;
          const root = currentHandle();
          if (root === null || currentAccess() !== "granted") break;
          await walk(root);
        } while (wantsAnotherScan());
      } finally {
        scanning = null;
        changed();
      }
    })();
    return scanning;
  };

  /** A walk that failed for a reason the browser does not document: logged, and the library keeps what it has. */
  const scanFailed = (error: unknown) => {
    console.warn("tracks.folder.scanFailed", { folder: folderName, error });
    problem = { kind: "not-found", message: `Reading "${folderName ?? "the folder"}" failed.`, fix: "Press Rescan now; if it keeps failing, pick the folder again." };
    changed();
  };

  const stopWatching = () => {
    watch?.stop();
    watch = null;
  };

  /** Starts on a folder the browser lets us read: watch it, then walk it. */
  const open = async (root: DirectoryHandleLike) => {
    stopWatching();
    handle = root;
    folderName = root.name;
    access = "granted";
    problem = null;
    changed();
    const started = await options.watch(root, () => void scan().catch(scanFailed));
    if (handle === root && !disposed) watch = started;
    else started.stop();
    changed();
    void scan().catch(scanFailed);
  };

  const remember = async (root: DirectoryHandleLike) => {
    try {
      await handleStore.put(root);
    } catch (error) {
      // The folder still works this visit; it just has to be picked again next time.
      console.warn("tracks.folder.notRemembered", { folder: root.name, error });
    }
  };

  const snapshot = (): MusicFolderSnapshot => {
    if (cached !== null) return cached;
    const states = [...entries.values()].map((entry) => entry.state);
    cached = {
      version,
      source: librarySource,
      canPick: librarySource === "device" && picker !== null,
      folder: folderName,
      access,
      scanning: scanning !== null,
      refresh: watch?.how ?? null,
      found: entries.size,
      analysed: states.filter((state) => state === "analysed").length,
      failed: states.filter((state) => state === "failed").length,
      skipped,
      truncated,
      problem,
      rekordbox: rekordbox === null ? null : { ...rekordbox.status(), matched: [...entries.values()].filter((entry) => entry.linked !== null).length },
    };
    return cached;
  };

  const want = (trackId: string) => {
    const path = pathByKey.get(trackId);
    if (path === undefined || !pending.has(path)) return;
    wanted = [path, ...wanted.filter((each) => each !== path)].slice(0, MAX_WANTED);
    // A background job gives way; it goes back to waiting and runs again later.
    if (current !== null && !current.wanted) current.abort.abort();
    worker.wake();
  };

  const tracks = () => [...entries.values()].map((entry) => entry.track);
  const files = (): FolderFile[] =>
    [...entries.values()].map((entry) => {
      const grid = entry.linked === null ? null : rekordboxGrid(entry.linked.tempos);
      return {
        trackId: entry.key,
        name: entry.path.split("/").pop() ?? entry.path,
        album: entry.linked !== null && filled(entry.linked.album) ? entry.linked.album.trim() : null,
        durationSec: entry.track.durationSec ?? null,
        contentHash: entry.contentHash,
        rekordboxGrid: grid?.kind === "constant" ? { bpm: grid.bpm, firstBeatSec: grid.firstBeatSec, downbeatPhase: grid.downbeatPhase } : null,
        read: entry.read,
        readPrefix: entry.readPrefix,
      };
    });

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    rekordbox,
    tracks,
    files,

    async start() {
      // Asked first: on the server's library, its rekordbox.xml is the collection, and this device's picked one is not restored.
      const probe: ServerLibraryProbe = (await options.server?.()) ?? { kind: "none" };
      if (rekordbox !== null) {
        if (probe.kind !== "none") rekordbox.useServerExport();
        rekordboxWork = rekordbox.start().catch((error: unknown) => {
          console.warn("tracks.folder.rekordboxNotRestored", { error });
        });
      }
      if (handle !== null || disposed) return;
      if (probe.kind !== "none") {
        librarySource = "server";
        if (probe.kind === "library") {
          await open(probe.root);
        } else {
          problem = probe.error;
          changed();
        }
        return;
      }
      let remembered: DirectoryHandleLike | null;
      try {
        remembered = await handleStore.get();
      } catch (error) {
        console.warn("tracks.folder.notRestored", { error });
        return;
      }
      if (remembered === null || currentHandle() !== null) return;
      const permission = (await remembered.queryPermission?.({ mode: "read" })) ?? "granted";
      if (currentHandle() !== null) return;
      if (permission === "granted") {
        await open(remembered);
        return;
      }
      handle = remembered;
      folderName = remembered.name;
      access = "needs-permission";
      changed();
    },

    async pick() {
      if (librarySource === "server") return { ok: false, error: ON_SERVER };
      if (picker === null) {
        return {
          ok: false,
          error: { kind: "unsupported", message: "This browser cannot open a folder to watch.", fix: "Import a folder instead, or use Chrome on a computer." },
        };
      }
      let root: DirectoryHandleLike;
      try {
        root = await picker();
      } catch (error) {
        if (isDomError(error, "AbortError")) return { ok: false, error: abortedError() };
        if (isDomError(error, "SecurityError")) return { ok: false, error: NEEDS_GESTURE };
        if (isDomError(error, "NotAllowedError")) return { ok: false, error: permissionDenied("the chosen folder") };
        throw error;
      }
      scanAbort.abort();
      scanAbort = new AbortController();
      clearAll();
      await remember(root);
      await open(root);
      return { ok: true };
    },

    async allowAccess() {
      if (librarySource === "server") return { ok: false, error: ON_SERVER };
      const root = handle;
      if (root === null) return { ok: false, error: { kind: "not-found", message: "No music folder was picked yet.", fix: "Pick a folder." } };
      const permission = (await root.requestPermission?.({ mode: "read" })) ?? "granted";
      if (permission !== "granted") {
        problem = permissionDenied(root.name);
        changed();
        return { ok: false, error: problem };
      }
      await open(root);
      return { ok: true };
    },

    importFiles(files) {
      if (librarySource === "server") {
        console.warn("tracks.folder.importRefused", { reason: ON_SERVER.message });
        return;
      }
      stopWatching();
      scanAbort.abort();
      scanAbort = new AbortController();
      const all = [...files];
      const audio = all.filter((file) => isAudioFile(file) && !file.name.startsWith("."));
      offerXml(
        all
          .filter((file) => file.name.toLowerCase().endsWith(".xml") && !file.name.startsWith("."))
          .map((file) => ({ path: file.webkitRelativePath || file.name, stamp: { size: file.size, lastModified: file.lastModified }, read: () => Promise.resolve(file) })),
      );
      const name = (all[0]?.webkitRelativePath ?? "").split("/")[0] ?? "";
      if (handle !== null || folderName !== (name || "Imported files")) clearAll();
      handle = null;
      access = "imported";
      folderName = name || "Imported files";
      problem = null;
      const found = audio.map((file) => ({
        path: file.webkitRelativePath || file.name,
        name: file.name,
        stamp: { size: file.size, lastModified: file.lastModified },
        read: () => Promise.resolve(file),
        readPrefix: blobPrefix(file),
      }));
      const now = new Set(found.map((file) => file.path));
      for (const path of [...entries.keys()]) if (!now.has(path)) drop(path);
      absorb(found, scanAbort.signal).catch(scanFailed);
      changed();
    },

    rescan: scan,

    async forget() {
      if (librarySource === "server") return;
      stopWatching();
      scanAbort.abort();
      scanAbort = new AbortController();
      clearAll();
      handle = null;
      folderName = null;
      access = "none";
      problem = null;
      changed();
      try {
        await handleStore.clear();
      } catch (error) {
        console.warn("tracks.folder.notForgotten", { error });
      }
      await rekordbox?.forgetFolder();
    },

    want,

    gridReady(trackId) {
      const path = pathByKey.get(trackId);
      const entry = path === undefined ? undefined : entries.get(path);
      if (entry === undefined) return false;
      return (entry.linked !== null && rekordboxGrid(entry.linked.tempos).kind === "constant") || (entry.state === "analysed" && entry.base.bpmHint !== undefined);
    },

    ready(trackId, signal) {
      const path = pathByKey.get(trackId);
      const entry = path === undefined ? undefined : entries.get(path);
      if (signal.aborted || path === undefined || entry === undefined || entry.state === "analysed" || entry.state === "failed") return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          const left = (waiters.get(path) ?? []).filter((each) => each !== done);
          if (left.length === 0) waiters.delete(path);
          else waiters.set(path, left);
          resolve();
        };
        waiters.set(path, [...(waiters.get(path) ?? []), done]);
        signal.addEventListener("abort", done);
        want(trackId);
      });
    },

    setBackgroundPaused(paused) {
      backgroundPaused = paused;
      if (!paused) worker.wake();
    },

    source(decode) {
      return {
        kind: "local-file",
        list: () => Promise.resolve({ ok: true, value: tracks() }),
        search: (query) => Promise.resolve({ ok: true, value: tracks().filter((track) => matchesQuery(track, query)) }),
        async load(track, loadOptions = {}): Promise<Result<LoadedTrack>> {
          const path = pathByKey.get(track.id);
          const entry = path === undefined ? undefined : entries.get(path);
          const gone: TrackError = {
            kind: "not-found",
            message: `"${track.title}" is no longer in your music folder; it may have been moved, deleted or changed.`,
            fix: "Rescan the folder, then load it again.",
          };
          if (entry === undefined) return { ok: false, error: gone };
          if (loadOptions.signal?.aborted === true) return { ok: false, error: abortedError() };
          let bytes: Uint8Array;
          try {
            const file = await entry.read();
            loadOptions.onProgress?.({ stage: "fetching", loadedBytes: 0, totalBytes: file.size, fraction: 0 });
            bytes = new Uint8Array(await file.arrayBuffer());
          } catch {
            return { ok: false, error: gone };
          }
          loadOptions.onProgress?.({ stage: "fetching", loadedBytes: bytes.length, totalBytes: bytes.length, fraction: 0.8 });
          const { linked } = entry;
          const loaded = await decodeAndHash(entry.track, bytes, decode, loadOptions);
          if (!loaded.ok || linked === null) return loaded;
          // The grid the Learner set in rekordbox replaces the analysis's guess, where the decks can
          // play it (one tempo, 4/4); a variable grid is left to the analysis.
          const grid = rekordboxGrid(linked.tempos);
          return {
            ok: true,
            value: {
              ...loaded.value,
              ...(grid.kind === "constant" ? { knownGrid: knownGridFromRekordbox(grid, loaded.value.audio.duration) } : {}),
              ...(linked.cues.length === 0 ? {} : { cues: linked.cues }),
            },
          };
        },
      };
    },

    async settled() {
      for (;;) {
        if (scanning !== null) await scanning;
        await rekordboxWork;
        await worker.idle();
        const runnable = wanted.some((path) => pending.has(path)) || (!backgroundPaused && pending.size > 0);
        if (scanning === null && worker.running === 0 && !runnable) return;
        worker.wake();
      }
    },

    dispose() {
      disposed = true;
      unlink();
      stopWatching();
      worker.stop();
      scanAbort.abort();
      current?.abort.abort();
      for (const path of [...waiters.keys()]) finishWaiters(path);
      if (notifyTimer !== null) clearTimeout(notifyTimer);
      listeners.clear();
    },
  };
}

