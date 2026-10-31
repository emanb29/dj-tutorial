/**
 * Local files: the Learner's own audio, read in the browser and never uploaded anywhere (no fetch,
 * no API call; the bytes go straight from the File to the decoder).
 *
 * Two ways in:
 * - `<input {...LOCAL_FILE_INPUT}>`, then `addFiles(input.files)`. Works in every browser.
 * - `pickDirectory()` (File System Access, Chromium only; check `canPickDirectory`). It walks the
 *   folder and its subfolders for audio, and remembers the folder's handle in IndexedDB, so a later
 *   session can call `restoreDirectory()`. The browser may ask for permission again; that prompt
 *   needs a user gesture, so call `restoreDirectory()` from a click handler.
 *
 * Local tracks are not shareable: their licence is unknown.
 */
import { abortedError, decodeAndHash, decodeOffline, matchesQuery, type AudioDecoder } from "./load-audio.ts";
import type { Result, Track, TrackError, TrackSource } from "./types.ts";

export const LOCAL_FILE_INPUT = { type: "file", multiple: true, accept: "audio/*" } as const;

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "webm"]);
/** Folder walks stop here, so a picked home directory cannot hang the page. */
const MAX_FOLDER_FILES = 2000;
const MAX_FOLDER_DEPTH = 6;

/** The parts of FileSystemFileHandle / FileSystemDirectoryHandle this module uses. */
export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

export interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
  queryPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
}

/** Where the picked folder's handle is remembered between sessions. */
export interface HandleStore {
  get(): Promise<DirectoryHandleLike | null>;
  put(handle: DirectoryHandleLike): Promise<void>;
  clear(): Promise<void>;
}

export function memoryHandleStore(): HandleStore {
  let stored: DirectoryHandleLike | null = null;
  return {
    get: () => Promise.resolve(stored),
    put: (handle) => {
      stored = handle;
      return Promise.resolve();
    },
    clear: () => {
      stored = null;
      return Promise.resolve();
    },
  };
}

const DATABASE = "learn-to-dj-tracks";
const OBJECT_STORE = "handles";
const DIRECTORY_KEY = "local-directory";

function request<Value>(make: (store: IDBObjectStore) => IDBRequest<Value>, mode: IDBTransactionMode): Promise<Value> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(OBJECT_STORE);
    };
    open.onerror = () => {
      reject(open.error ?? new Error(`Could not open IndexedDB "${DATABASE}".`));
    };
    open.onblocked = () => {
      reject(new Error(`IndexedDB "${DATABASE}" is blocked by another tab. Close the app's other tabs, then try again.`));
    };
    open.onsuccess = () => {
      const database = open.result;
      const fail = (error: unknown) => {
        database.close();
        reject(error instanceof Error ? error : new Error(`IndexedDB "${DATABASE}" failed.`));
      };
      try {
        const transaction = database.transaction(OBJECT_STORE, mode);
        // Throws synchronously for, e.g., a handle that cannot be cloned (DataCloneError).
        const pending = make(transaction.objectStore(OBJECT_STORE));
        transaction.oncomplete = () => {
          database.close();
          resolve(pending.result);
        };
        transaction.onerror = () => {
          fail(transaction.error);
        };
        transaction.onabort = () => {
          fail(transaction.error);
        };
      } catch (error) {
        fail(error);
      }
    };
  });
}

/**
 * Keeps the handle in IndexedDB (handles are structured-cloneable; nothing of the files is stored).
 * `key` tells apart folders kept for different uses (the music folder setting keeps its own).
 */
export function indexedDbHandleStore(key = DIRECTORY_KEY): HandleStore {
  return {
    get: async () => (await request<unknown>((store) => store.get(key), "readonly")) as DirectoryHandleLike | null ?? null,
    put: async (handle) => {
      await request((store) => store.put(handle, key), "readwrite");
    },
    clear: async () => {
      await request((store) => store.delete(key), "readwrite");
    },
  };
}

export interface LocalFileOptions {
  readonly decode?: AudioDecoder;
  readonly handleStore?: HandleStore;
  /** `window.showDirectoryPicker` by default when it exists; null = not supported. */
  readonly showDirectoryPicker?: (() => Promise<DirectoryHandleLike>) | null;
}

export interface LocalFileSource extends TrackSource {
  /** Adds files from a file input or a drop; returns the tracks that are new. Non-audio files are skipped. */
  addFiles(files: Iterable<File>): readonly Track[];
  readonly canPickDirectory: boolean;
  pickDirectory(): Promise<Result<readonly Track[]>>;
  /** Re-opens the folder remembered from an earlier session. Call it from a user gesture. */
  restoreDirectory(): Promise<Result<readonly Track[]>>;
  forgetDirectory(): Promise<void>;
}

/** Whether a file name ends in an audio extension (for folder walks, before the file is opened). */
export function hasAudioExtension(name: string): boolean {
  return AUDIO_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? "");
}

/** Whether a file is audio, by its type or, when the browser gives none, its extension. */
export function isAudioFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("audio/")) return true;
  if (file.type !== "" && !file.type.startsWith("video/")) return false;
  return hasAudioExtension(file.name);
}

/** The track for a file at `path`: "Artist - Title" from the name; the id is path, size and lastModified. */
export function trackForFile(file: Pick<File, "name" | "size" | "lastModified">, path: string): Track {
  const stem = file.name.replace(/\.[^.]+$/, "");
  const split = /^(.+?)\s+-\s+(.+)$/.exec(stem);
  return {
    id: `${path}|${String(file.size)}|${String(file.lastModified)}`,
    source: "local-file",
    title: split?.[2] ?? stem,
    artist: split?.[1] ?? "Unknown artist",
    attribution: { text: `Your file "${file.name}"`, url: null },
    shareable: false,
    analysisCacheKey: null,
    retention: "persistable",
  };
}

function defaultPicker(): (() => Promise<DirectoryHandleLike>) | null {
  const candidate = (globalThis as { showDirectoryPicker?: (options: object) => Promise<DirectoryHandleLike> }).showDirectoryPicker;
  return candidate === undefined ? null : () => candidate.call(globalThis, { mode: "read", id: "learn-to-dj-music" });
}

function permissionDenied(name: string): TrackError {
  return {
    kind: "permission-denied",
    message: `The browser did not allow reading the folder "${name}".`,
    fix: "Click to allow access when the browser asks, or pick the folder again.",
  };
}

export function createLocalFileSource(options: LocalFileOptions = {}): LocalFileSource {
  const decode = options.decode ?? decodeOffline;
  const handleStore = options.handleStore ?? indexedDbHandleStore();
  const picker = options.showDirectoryPicker === undefined ? defaultPicker() : options.showDirectoryPicker;
  const files = new Map<string, { track: Track; file: File }>();

  function add(file: File, path: string): Track | null {
    if (!isAudioFile(file)) return null;
    const track = trackForFile(file, path);
    if (files.has(track.id)) return null;
    files.set(track.id, { track, file });
    return track;
  }

  async function walk(root: DirectoryHandleLike): Promise<Track[]> {
    const added: Track[] = [];
    let seen = 0;
    const visit = async (folder: DirectoryHandleLike, prefix: string, depth: number): Promise<void> => {
      for await (const entry of folder.values()) {
        if (seen >= MAX_FOLDER_FILES) return;
        if (entry.kind === "directory") {
          if (depth < MAX_FOLDER_DEPTH) await visit(entry, `${prefix}${entry.name}/`, depth + 1);
          continue;
        }
        seen += 1;
        const track = add(await entry.getFile(), `${prefix}${entry.name}`);
        if (track !== null) added.push(track);
      }
    };
    await visit(root, `${root.name}/`, 0);
    if (seen >= MAX_FOLDER_FILES) console.warn("tracks.local.folderTruncated", { folder: root.name, maxFiles: MAX_FOLDER_FILES });
    return added;
  }

  async function readFolder(handle: DirectoryHandleLike): Promise<Result<readonly Track[]>> {
    try {
      return { ok: true, value: await walk(handle) };
    } catch (error) {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        return { ok: false, error: permissionDenied(handle.name) };
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return {
          ok: false,
          error: { kind: "not-found", message: `The folder "${handle.name}" is gone or was moved.`, fix: "Pick the folder again." },
        };
      }
      throw error;
    }
  }

  return {
    kind: "local-file",
    canPickDirectory: picker !== null,
    addFiles: (added) => [...added].flatMap((file) => add(file, file.webkitRelativePath || file.name) ?? []),
    list: () => Promise.resolve({ ok: true, value: [...files.values()].map((entry) => entry.track) }),
    search: (query) =>
      Promise.resolve({ ok: true, value: [...files.values()].map((entry) => entry.track).filter((track) => matchesQuery(track, query)) }),

    async pickDirectory() {
      if (picker === null) {
        return {
          ok: false,
          error: {
            kind: "unsupported",
            message: "This browser cannot open a whole folder.",
            fix: "Use Chrome or Edge to pick a folder, or choose the files with the file button instead.",
          },
        };
      }
      let handle: DirectoryHandleLike;
      try {
        handle = await picker();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return { ok: false, error: abortedError() };
        if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
          return { ok: false, error: permissionDenied("the chosen folder") };
        }
        throw error;
      }
      await handleStore.put(handle);
      return readFolder(handle);
    },

    async restoreDirectory() {
      const handle = await handleStore.get();
      if (handle === null) {
        return {
          ok: false,
          error: { kind: "not-found", message: "No music folder was picked before.", fix: "Pick a folder (Chrome or Edge), or choose files." },
        };
      }
      const descriptor = { mode: "read" } as const;
      let permission = (await handle.queryPermission?.(descriptor)) ?? "granted";
      if (permission !== "granted") permission = (await handle.requestPermission?.(descriptor)) ?? "denied";
      if (permission !== "granted") return { ok: false, error: permissionDenied(handle.name) };
      return readFolder(handle);
    },

    forgetDirectory: () => handleStore.clear(),

    async load(track, loadOptions = {}) {
      const entry = files.get(track.id);
      if (track.source !== "local-file" || entry === undefined) {
        return {
          ok: false,
          error: { kind: "not-found", message: `"${track.title}" was not added in this session.`, fix: "Add the file again." },
        };
      }
      if (loadOptions.signal?.aborted === true) return { ok: false, error: abortedError() };
      const { size } = entry.file;
      loadOptions.onProgress?.({ stage: "fetching", loadedBytes: 0, totalBytes: size, fraction: 0 });
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await entry.file.arrayBuffer());
      } catch {
        return {
          ok: false,
          error: {
            kind: "not-found",
            message: `"${entry.file.name}" could not be read; it may have been moved, deleted or changed.`,
            fix: "Add the file again.",
          },
        };
      }
      loadOptions.onProgress?.({ stage: "fetching", loadedBytes: size, totalBytes: size, fraction: 0.8 });
      return decodeAndHash(track, bytes, decode, loadOptions);
    },
  };
}
