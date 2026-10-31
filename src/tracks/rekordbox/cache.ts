// The parsed rekordbox collection, kept in this browser between visits, next to the music folder's
// entry cache, so a big rekordbox.xml is read again only when it changes. One record per place it
// came from ("file": picked once; "folder": found in the music folder), each stamped with the file's
// path, size and date. Personal library data: it stays in IndexedDB here, never goes to the server.
import type { RekordboxLibrary } from "./xml.ts";

export const REKORDBOX_CACHE_VERSION = 1;

export type RekordboxSlot = "file" | "folder";

export interface CachedRekordbox {
  /** The file it was read from, with its size and date: re-read when this changes. */
  readonly stamp: string;
  /** The file's name or path, to show. */
  readonly name: string;
  readonly library: RekordboxLibrary;
}

export interface RekordboxCache {
  get(slot: RekordboxSlot): Promise<CachedRekordbox | null>;
  put(slot: RekordboxSlot, value: CachedRekordbox): Promise<void>;
  clear(slot: RekordboxSlot): Promise<void>;
}

export function memoryRekordboxCache(): RekordboxCache & { readonly records: Map<RekordboxSlot, CachedRekordbox> } {
  const records = new Map<RekordboxSlot, CachedRekordbox>();
  return {
    records,
    get: (slot) => Promise.resolve(records.get(slot) ?? null),
    put: (slot, value) => {
      records.set(slot, value);
      return Promise.resolve();
    },
    clear: (slot) => {
      records.delete(slot);
      return Promise.resolve();
    },
  };
}

const STORE = "collections";

interface Stored {
  readonly version: number;
  readonly value: CachedRekordbox;
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

/** In IndexedDB. A failing database (private mode, quota) is logged; the file is then read again each visit. */
export function indexedDbRekordboxCache(databaseName = "learn-to-dj-rekordbox"): RekordboxCache {
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
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(slot) {
      try {
        const stored = (await promised((await store("readonly")).get(slot))) as Stored | undefined;
        return stored?.version === REKORDBOX_CACHE_VERSION ? stored.value : null;
      } catch (error) {
        console.warn("tracks.rekordbox.cacheReadFailed", { error });
        return null;
      }
    },
    async put(slot, value) {
      try {
        const stored: Stored = { version: REKORDBOX_CACHE_VERSION, value };
        await promised((await store("readwrite")).put(stored, slot));
      } catch (error) {
        console.warn("tracks.rekordbox.cacheWriteFailed", { error });
      }
    },
    async clear(slot) {
      try {
        await promised((await store("readwrite")).delete(slot));
      } catch (error) {
        console.warn("tracks.rekordbox.cacheClearFailed", { error });
      }
    },
  };
}
