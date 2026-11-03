// The Learner's Mix Plans, on this device only (IndexedDB; there is no server copy in v1). A plan is
// kilobytes: tracks by content hash, name and length, never audio or a path. The store holds at most
// MAX_MIX_PLANS and refuses more with a message. Plans are read through readMixPlan, so one saved by
// an older version is migrated, and one that cannot be read is listed as such (it can still be deleted).
import { readMixPlan, type MixPlanReadProblem } from "@shared/mix-plan-file.ts";
import type { MixPlan } from "@shared/mix-plan.ts";

export const MIX_PLANS_DATABASE = "dj-tutorial-mix-plans";
export const MAX_MIX_PLANS = 200;
const STORE = "plans";

export type StoredPlan =
  | { readonly ok: true; readonly plan: MixPlan; readonly migratedFrom: number | null }
  | { readonly ok: false; readonly id: string; readonly problems: readonly MixPlanReadProblem[] };

export interface StoreFull {
  readonly kind: "store-full";
  readonly message: string;
  readonly fix: string;
}

export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: StoreFull };

export interface MixPlanStore {
  /** Every plan, the most recently changed first. */
  list(): Promise<readonly StoredPlan[]>;
  get(id: string): Promise<StoredPlan | null>;
  /** Adds a plan, or replaces the one with its id. A new plan is refused once the store is full. */
  save(plan: MixPlan): Promise<SaveOutcome>;
  delete(id: string): Promise<void>;
  /** Closes the connection (tests delete the database afterwards). */
  close(): Promise<void>;
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

function stored(record: unknown): StoredPlan {
  const read = readMixPlan(record);
  if (read.ok) return read;
  const id = typeof record === "object" && record !== null && "id" in record ? String(record.id) : "";
  return { ok: false, id, problems: read.problems };
}

const updatedAt = (entry: StoredPlan) => (entry.ok ? entry.plan.updatedAt : "");

export function createMixPlanStore(options: { readonly databaseName?: string; readonly maxPlans?: number } = {}): MixPlanStore {
  const databaseName = options.databaseName ?? MIX_PLANS_DATABASE;
  const maxPlans = options.maxPlans ?? MAX_MIX_PLANS;
  let database: Promise<IDBDatabase> | null = null;

  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`Could not open IndexedDB database ${databaseName}`));
      };
      request.onblocked = () => {
        reject(new Error(`IndexedDB "${databaseName}" is blocked by another tab. Close the app's other tabs, then try again.`));
      };
    });
    return database;
  };
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);

  return {
    async list() {
      const records = await promised((await store("readonly")).getAll());
      // ISO 8601 times in UTC sort as text; an unreadable plan goes last.
      return records.map(stored).toSorted((a, b) => updatedAt(b).localeCompare(updatedAt(a)));
    },

    async get(id) {
      const record = (await promised((await store("readonly")).get(id))) as unknown;
      return record === undefined ? null : stored(record);
    },

    async save(plan) {
      const transaction = (await open()).transaction(STORE, "readwrite");
      const plans = transaction.objectStore(STORE);
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onabort = () => {
          reject(transaction.error ?? new Error("The IndexedDB transaction was aborted"));
        };
      });
      // One transaction: the count and the write cannot be split by a save in another tab.
      const exists = (await promised(plans.getKey(plan.id))) !== undefined;
      if (!exists && (await promised(plans.count())) >= maxPlans) {
        await done;
        return {
          ok: false,
          error: {
            kind: "store-full",
            message: `This device already keeps ${String(maxPlans)} Mix Plans, the most it holds.`,
            fix: "Delete a plan you no longer need (download it first to keep a copy), then save again.",
          },
        };
      }
      await promised(plans.put(plan));
      await done;
      return { ok: true };
    },

    async delete(id) {
      await promised((await store("readwrite")).delete(id));
    },

    async close() {
      if (database !== null) (await database).close();
      database = null;
    },
  };
}
