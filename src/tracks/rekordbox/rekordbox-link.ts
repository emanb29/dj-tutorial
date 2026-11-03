/**
 * The Learner's rekordbox collection, linked to the music folder: rekordbox's own BPM, grid, key,
 * cues and tags for the files it knows. Two ways in:
 * - picked once ("Use rekordbox.xml"): the file's handle is remembered (File System Access, where
 *   the browser has showOpenFilePicker) and the file read again whenever its size or date changes;
 *   without the picker, a file input gives the file once and what was read from it is kept;
 * - found in the music folder: any .xml there whose root is DJ_PLAYLISTS (rekordbox.xml first), read
 *   again when a rescan sees it change. A picked file wins over one in the folder.
 * On the server's library (`useServerExport`), the folder's file is the only one: the server's
 * REKORDBOX_XML, or a rekordbox.xml in MUSIC_DIR, the same on every device. This device's picked
 * file is neither read nor used there, but kept for a server without a library.
 * What was read is kept in IndexedDB (cache.ts), so the next visit does not parse it again. Reading
 * is in a worker (parser.ts). Personal library data: it never leaves the browser.
 */
import type { FileHandleLike, HandleStore } from "../local-files.ts";
import { memoryHandleStore } from "../local-files.ts";
import type { FileStamp } from "../music-folder/scan.ts";
import type { TrackError } from "../types.ts";
import { memoryRekordboxCache, type CachedRekordbox, type RekordboxCache, type RekordboxSlot } from "./cache.ts";
import { createRekordboxMatcher, type RekordboxMatcher } from "./match.ts";
import type { RekordboxLibrary, RekordboxParse, RekordboxParseError } from "./xml.ts";

export interface RekordboxFileHandle extends FileHandleLike {
  queryPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
}

/** An .xml file the music folder's scan found. */
export interface XmlCandidate {
  readonly path: string;
  readonly stamp: FileStamp;
  readonly read: () => Promise<File>;
}

export interface RekordboxLinkOptions {
  readonly parse: (file: File, signal?: AbortSignal) => Promise<RekordboxParse>;
  readonly cache?: RekordboxCache;
  readonly handleStore?: HandleStore<RekordboxFileHandle>;
  /** `window.showOpenFilePicker` for one XML file by default, where it exists; null = this browser cannot. */
  readonly showOpenFilePicker?: (() => Promise<RekordboxFileHandle>) | null;
}

export interface RekordboxStatus {
  readonly version: number;
  /** Where the collection in use came from; null when there is none. */
  readonly from: RekordboxSlot | null;
  /** The file's name, or its path in the music folder. */
  readonly name: string | null;
  readonly reading: boolean;
  /** TRACK entries read. */
  readonly tracks: number;
  /** TRACK entries that did not validate. */
  readonly skipped: number;
  /** The picked file is remembered, but the browser wants a click to read it again. */
  readonly needsPermission: boolean;
  readonly canPickFile: boolean;
  /** The collection is the server library's own (useServerExport): nothing is picked on this device. */
  readonly serverExport: boolean;
  readonly problem: { readonly message: string; readonly fix: string } | null;
}

export interface LinkedRekordbox {
  readonly from: RekordboxSlot;
  readonly library: RekordboxLibrary;
  readonly matcher: RekordboxMatcher;
}

export type RekordboxOutcome = { readonly ok: true } | { readonly ok: false; readonly error: TrackError };

export interface RekordboxLink {
  readonly subscribe: (listener: () => void) => () => void;
  readonly status: () => RekordboxStatus;
  /** The collection in use, with its matcher; null when there is none. */
  library(): LinkedRekordbox | null;
  /** Restores what was kept and re-reads the remembered file if the browser allows and it changed. Asks nothing. */
  start(): Promise<void>;
  /** Shows the file picker (or, for a remembered file, asks the browser to read it again). Call from a click. */
  pickFile(): Promise<RekordboxOutcome>;
  /** A file from a file input, where there is no picker to remember it. */
  useFile(file: File): Promise<RekordboxOutcome>;
  /** The .xml files the music folder holds now (each scan). */
  offerFolderFiles(files: readonly XmlCandidate[]): Promise<void>;
  forgetFile(): Promise<void>;
  /** The music folder was forgotten: its collection goes too. */
  forgetFolder(): Promise<void>;
  /** The music folder is the server's library: from now on only its .xml files count. Call before start(). */
  useServerExport(): void;
}

function defaultFilePicker(): (() => Promise<RekordboxFileHandle>) | null {
  const candidate = (globalThis as { showOpenFilePicker?: (options: object) => Promise<RekordboxFileHandle[]> }).showOpenFilePicker;
  if (candidate === undefined) return null;
  return async () => {
    const [handle] = await candidate.call(globalThis, {
      id: "learn-to-dj-rekordbox-xml",
      multiple: false,
      types: [{ description: "rekordbox collection (XML)", accept: { "text/xml": [".xml"], "application/xml": [".xml"] } }],
    });
    if (handle === undefined) throw new DOMException("No file was picked.", "AbortError");
    return handle;
  };
}

const isDomError = (error: unknown, ...names: readonly string[]) => error instanceof DOMException && names.includes(error.name);

const asTrackError = (error: RekordboxParseError): TrackError => ({ kind: "bad-response", message: error.message, fix: error.fix, problems: [] });

const UNSUPPORTED: TrackError = {
  kind: "unsupported",
  message: "This browser cannot keep a file to read again.",
  fix: "Choose rekordbox.xml with the file button, or put it in your music folder.",
};

const ON_SERVER: TrackError = {
  kind: "unsupported",
  message: "This library's rekordbox.xml comes from the server, the same on every device.",
  fix: "To change it, set REKORDBOX_XML in the server's .env, or save rekordbox.xml in MUSIC_DIR, then Rescan now.",
};

const stampOf = (name: string, stamp: FileStamp) => `${name}|${String(stamp.size)}|${String(stamp.lastModified)}`;

/** rekordbox.xml first, then the other .xml files by path. */
const preferred = (files: readonly XmlCandidate[]) =>
  files.toSorted((a, b) => {
    const named = (file: XmlCandidate) => (file.path.split("/").at(-1)?.toLowerCase() === "rekordbox.xml" ? 0 : 1);
    return named(a) - named(b) || a.path.localeCompare(b.path);
  });

export function createRekordboxLink(options: RekordboxLinkOptions): RekordboxLink {
  const cache = options.cache ?? memoryRekordboxCache();
  const handleStore = options.handleStore ?? memoryHandleStore<RekordboxFileHandle>();
  const picker = options.showOpenFilePicker === undefined ? defaultFilePicker() : options.showOpenFilePicker;

  const kept: Record<RekordboxSlot, CachedRekordbox | null> = { file: null, folder: null };
  const matchers = new WeakMap<RekordboxLibrary, RekordboxMatcher>();
  /** Folder files already found not to be rekordbox's, by path, size and date: not read again. */
  const notRekordbox = new Set<string>();
  const listeners = new Set<() => void>();
  let fileHandle: RekordboxFileHandle | null = null;
  let serverExport = false;
  let needsPermission = false;
  let problem: RekordboxStatus["problem"] = null;
  let reading = 0;
  let version = 0;
  let cached: RekordboxStatus | null = null;
  /** One read at a time, in the order asked. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const changed = () => {
    version += 1;
    cached = null;
    for (const listener of listeners) listener();
  };

  const active = (): { slot: RekordboxSlot; value: CachedRekordbox } | null => {
    if (kept.file !== null && !serverExport) return { slot: "file", value: kept.file };
    if (kept.folder !== null) return { slot: "folder", value: kept.folder };
    return null;
  };

  /** Reads a file into `slot`. Null when it worked, else what was wrong (the old collection stays). */
  const read = async (slot: RekordboxSlot, name: string, stamp: string, getFile: () => Promise<File>): Promise<RekordboxParseError | null> => {
    reading += 1;
    changed();
    let result: RekordboxParse;
    try {
      result = await options.parse(await getFile());
    } catch (error) {
      console.warn("tracks.rekordbox.readFailed", { name, error });
      return { kind: "malformed", message: `Reading "${name}" failed.`, fix: "Export it again from rekordbox, then pick it again." };
    } finally {
      reading -= 1;
    }
    if (!result.ok) {
      changed();
      return result.error;
    }
    const value: CachedRekordbox = { stamp, name, library: result.library };
    kept[slot] = value;
    if (result.library.skippedTracks > 0 || result.library.skippedMarks > 0) {
      console.warn("tracks.rekordbox.skipped", { name, tracks: result.library.skippedTracks, marks: result.library.skippedMarks });
    }
    changed();
    await cache.put(slot, value);
    return null;
  };

  /** Re-reads the picked file through its handle if it changed. */
  const refreshFile = async (handle: RekordboxFileHandle): Promise<RekordboxOutcome> => {
    let file: File;
    try {
      file = await handle.getFile();
    } catch (error) {
      if (isDomError(error, "NotAllowedError", "SecurityError")) {
        needsPermission = true;
        changed();
        return { ok: false, error: { kind: "permission-denied", message: `The browser did not allow reading "${handle.name}".`, fix: "Press Use rekordbox.xml and say yes." } };
      }
      problem = { message: `"${handle.name}" is gone or was moved.`, fix: "Export it again from rekordbox, then pick it again." };
      changed();
      return { ok: false, error: { kind: "not-found", ...problem } };
    }
    const stamp = stampOf(handle.name, file);
    if (kept.file?.stamp === stamp) return { ok: true };
    const error = await read("file", handle.name, stamp, () => Promise.resolve(file));
    problem = error === null ? null : { message: error.message, fix: error.fix };
    changed();
    return error === null ? { ok: true } : { ok: false, error: asTrackError(error) };
  };

  const remember = async (handle: RekordboxFileHandle | null) => {
    fileHandle = handle;
    try {
      if (handle === null) await handleStore.clear();
      else await handleStore.put(handle);
    } catch (error) {
      console.warn("tracks.rekordbox.notRemembered", { error });
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    status: () => {
      if (cached !== null) return cached;
      const now = active();
      cached = {
        version,
        from: now?.slot ?? null,
        name: now?.value.name ?? null,
        reading: reading > 0,
        tracks: now?.value.library.tracks.length ?? 0,
        skipped: now?.value.library.skippedTracks ?? 0,
        needsPermission: needsPermission && !serverExport,
        canPickFile: picker !== null && !serverExport,
        serverExport,
        problem,
      };
      return cached;
    },

    library: () => {
      const now = active();
      if (now === null) return null;
      const { library } = now.value;
      let matcher = matchers.get(library);
      if (matcher === undefined) {
        matcher = createRekordboxMatcher(library.tracks);
        matchers.set(library, matcher);
      }
      return { from: now.slot, library, matcher };
    },

    start: () =>
      serial(async () => {
        const [file, folder] = await Promise.all([cache.get("file"), cache.get("folder")]);
        kept.file ??= file;
        kept.folder ??= folder;
        changed();
        if (serverExport) return;
        let handle: RekordboxFileHandle | null;
        try {
          handle = await handleStore.get();
        } catch (error) {
          console.warn("tracks.rekordbox.notRestored", { error });
          return;
        }
        if (handle === null) return;
        fileHandle = handle;
        const permission = (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
        if (permission !== "granted") {
          needsPermission = true;
          changed();
          return;
        }
        await refreshFile(handle);
      }),

    pickFile: () =>
      serial(async (): Promise<RekordboxOutcome> => {
        if (serverExport) return { ok: false, error: ON_SERVER };
        if (fileHandle !== null && needsPermission) {
          const handle = fileHandle;
          const permission = (await handle.requestPermission?.({ mode: "read" })) ?? "granted";
          if (permission === "granted") {
            needsPermission = false;
            changed();
            return refreshFile(handle);
          }
        }
        if (picker === null) return { ok: false, error: UNSUPPORTED };
        let handle: RekordboxFileHandle;
        try {
          handle = await picker();
        } catch (error) {
          if (isDomError(error, "AbortError")) return { ok: false, error: { kind: "aborted", message: "No file was picked.", fix: "Pick rekordbox.xml." } };
          if (isDomError(error, "SecurityError")) {
            return { ok: false, error: { kind: "permission-denied", message: "The browser opens the file picker only from a click, tap or key.", fix: "Click or tap Use rekordbox.xml." } };
          }
          throw error;
        }
        needsPermission = false;
        const outcome = await refreshFile(handle);
        if (outcome.ok) await remember(handle);
        return outcome;
      }),

    useFile: (file) =>
      serial(async (): Promise<RekordboxOutcome> => {
        if (serverExport) return { ok: false, error: ON_SERVER };
        const error = await read("file", file.name, stampOf(file.name, file), () => Promise.resolve(file));
        problem = error === null ? null : { message: error.message, fix: error.fix };
        if (error === null) {
          needsPermission = false;
          await remember(null);
        }
        changed();
        return error === null ? { ok: true } : { ok: false, error: asTrackError(error) };
      }),

    offerFolderFiles: (files) =>
      serial(async () => {
        if (kept.file !== null && !serverExport) return;
        for (const candidate of preferred(files)) {
          const stamp = stampOf(candidate.path, candidate.stamp);
          if (notRekordbox.has(stamp)) continue;
          if (kept.folder?.stamp === stamp) return;
          const error = await read("folder", candidate.path, stamp, candidate.read);
          if (error === null) return;
          if (error.kind === "not-rekordbox") {
            notRekordbox.add(stamp);
            continue;
          }
          // A rekordbox file, but broken (an export cut short): say so, keep what was read before.
          problem = { message: error.message, fix: error.fix };
          changed();
          return;
        }
        const folder = kept.folder;
        if (folder !== null && !files.some((file) => file.path === folder.name)) {
          kept.folder = null;
          changed();
          await cache.clear("folder");
        }
      }),

    forgetFile: () =>
      serial(async () => {
        kept.file = null;
        needsPermission = false;
        problem = null;
        changed();
        await remember(null);
        await cache.clear("file");
      }),

    forgetFolder: () =>
      serial(async () => {
        kept.folder = null;
        changed();
        await cache.clear("folder");
      }),

    useServerExport: () => {
      serverExport = true;
      changed();
    },
  };
}
