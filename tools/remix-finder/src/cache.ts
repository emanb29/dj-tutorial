/**
 * A folder of JSON answers keyed by name, each with the time it was fetched, reused while younger
 * than the TTL its caller gives. Searches and analyses go here, so a stopped run resumes and a
 * second run over the same playlist costs nothing.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry<T> {
  readonly fetchedAt: string;
  readonly value: T;
}

export function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function jsonCache<T>(folder: string, ttlMs: (value: T) => number, now: () => Date = () => new Date()) {
  mkdirSync(folder, { recursive: true });
  const path = (key: string) => join(folder, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    get(key: string): T | null {
      let entry: Entry<T>;
      try {
        entry = JSON.parse(readFileSync(path(key), "utf8")) as Entry<T>;
      } catch {
        return null;
      }
      return now().getTime() - Date.parse(entry.fetchedAt) <= ttlMs(entry.value) ? entry.value : null;
    },
    put(key: string, value: T): void {
      writeAtomically(path(key), `${JSON.stringify({ fetchedAt: now().toISOString(), value } satisfies Entry<T>)}\n`);
    },
  };
}
export type JsonCache<T> = ReturnType<typeof jsonCache<T>>;
