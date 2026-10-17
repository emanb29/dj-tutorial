// AnalysisCache in IndexedDB. Stores the TrackAnalysis object as is (structured clone keeps the
// Float32Arrays of the waveform overview); never audio.

import { isCurrentVersion, type AnalysisCache } from "./cache.ts";
import type { TrackAnalysis } from "./types.ts";

const STORE = "analyses";

interface StoredAnalysis {
  readonly contentHash: string;
  readonly savedAt: string;
  readonly analysis: TrackAnalysis;
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

export class IndexedDbAnalysisCache implements AnalysisCache {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly databaseName = "learn-to-dj-analysis") {}

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "contentHash" });
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`Could not open IndexedDB database ${this.databaseName}`));
      };
    });
    return this.database;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async get(contentHash: string): Promise<TrackAnalysis | null> {
    const stored = (await promised((await this.store("readonly")).get(contentHash))) as StoredAnalysis | undefined;
    return stored && isCurrentVersion(stored.analysis) ? stored.analysis : null;
  }

  async put(contentHash: string, analysis: TrackAnalysis): Promise<void> {
    const record: StoredAnalysis = { contentHash, savedAt: new Date().toISOString(), analysis };
    await promised((await this.store("readwrite")).put(record));
  }

  async delete(contentHash: string): Promise<void> {
    await promised((await this.store("readwrite")).delete(contentHash));
  }

  /** Closes the connection (tests delete the database afterwards). */
  async close(): Promise<void> {
    if (this.database) (await this.database).close();
    this.database = null;
  }
}
