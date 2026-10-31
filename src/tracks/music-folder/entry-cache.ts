// What the library learnt about each file, kept between visits so a rescan of a big folder only
// analyses what is new or changed. Keyed by path, size and lastModified (entryKey): a file that
// changes gets a new key, so it is analysed again. The beat grid itself stays in the analysis cache
// (src/analysis), under `contentHash`; this stores only what the list shows. Never audio.

export const ENTRY_CACHE_VERSION = 1;

export type EntryRecord =
  | {
      readonly key: string;
      readonly outcome: "analysed";
      /** The analysis cache's key for this file (shared/track-hash.ts). */
      readonly contentHash: string;
      readonly bpm: number | null;
      readonly durationSec: number;
    }
  | {
      readonly key: string;
      /** The browser could not decode it, or the analysis found no beat: not tried again until the file changes. */
      readonly outcome: "failed";
      readonly reason: string;
    };

export interface EntryCache {
  /** The records found for `keys` (missing keys are left out). */
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, EntryRecord>>;
  put(record: EntryRecord): Promise<void>;
}

export const entryKey = (path: string, size: number, lastModified: number) => `${path}|${String(size)}|${String(lastModified)}`;

export function memoryEntryCache(): EntryCache & { readonly records: Map<string, EntryRecord> } {
  const records = new Map<string, EntryRecord>();
  return {
    records,
    getMany: (keys) =>
      Promise.resolve(
        new Map(
          keys.flatMap((key) => {
            const record = records.get(key);
            return record === undefined ? [] : [[key, record] as const];
          }),
        ),
      ),
    put: (record) => {
      records.set(record.key, record);
      return Promise.resolve();
    },
  };
}

const STORE = "entries";

interface StoredEntry {
  readonly version: number;
  readonly record: EntryRecord;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed without an error"));
    };
  });
}

/** The records in IndexedDB. A failing database (private mode, quota) is logged and the library analyses again. */
export function indexedDbEntryCache(databaseName = "learn-to-dj-library"): EntryCache {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`Could not open IndexedDB database ${databaseName}`));
      };
    });
    return database;
  };
  return {
    async getMany(keys) {
      const found = new Map<string, EntryRecord>();
      if (keys.length === 0) return found;
      try {
        const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
        const stored = await Promise.all(keys.map((key) => promised(store.get(key) as IDBRequest<StoredEntry | undefined>)));
        stored.forEach((entry, index) => {
          const key = keys[index];
          if (entry?.version === ENTRY_CACHE_VERSION && key !== undefined) found.set(key, entry.record);
        });
      } catch (error) {
        console.warn("tracks.folder.cacheReadFailed", { error });
      }
      return found;
    },
    async put(record) {
      try {
        const stored: StoredEntry = { version: ENTRY_CACHE_VERSION, record };
        await promised((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(stored, record.key));
      } catch (error) {
        console.warn("tracks.folder.cacheWriteFailed", { error });
      }
    },
  };
}
