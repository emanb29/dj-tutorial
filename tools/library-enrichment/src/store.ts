/**
 * The sidecar store: what enrichment found for each track, keyed by content hash, in a data folder
 * of its own. It is the source of truth for enriched fields; nothing here writes to an audio file,
 * a tag or the original collection.
 *
 * - `base` is what the collection says now (re-read every run).
 * - `steps` holds each step's proposals with the step's version and an input key, so a step re-runs
 *   only when its version or its input changed.
 * - `applied` holds the proposals an apply run accepted: only fields `base` has empty.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfidenceBand } from "./name-parse.ts";

export const STORE_VERSION = 1;

/** The fields enrichment can fill, and the collection attribute each one is projected onto. */
export const ENRICHED_FIELDS = ["artist", "originalArtist", "title", "remixer", "mix", "genre", "genreRaw", "year"] as const;
export type EnrichedField = (typeof ENRICHED_FIELDS)[number];

export type StepName = "names" | "soundcloud";

export interface Proposal {
  readonly field: EnrichedField;
  readonly value: string;
  readonly band: ConfidenceBand;
  readonly step: StepName;
  readonly stepVersion: number;
  /** Where the value came from within the step: "name", "file-name", "soundcloud". */
  readonly source: string;
  readonly rule: string;
  /** What a reviewer needs to judge it, one line each. */
  readonly evidence: readonly string[];
}

export interface StepResult {
  readonly version: number;
  readonly inputKey: string;
  readonly ranAt: string;
  readonly proposals: readonly Proposal[];
  /** Step 1: the SoundCloud track ID the name carries, for step 2. */
  readonly sourceId?: string | null;
  /** Step 2: what the lookup found. */
  readonly lookup?: "ok" | "not-found" | "error";
}

export interface AppliedField extends Proposal {
  readonly run: string;
}

/** What the collection says about a track: the attributes enrichment reads and fills. */
export interface TrackBase {
  readonly trackId: string;
  readonly name: string;
  readonly fileName: string;
  readonly artist: string;
  readonly genre: string;
  readonly year: string;
  readonly comments: string;
  readonly remixer: string;
  readonly mix: string;
}

export interface StoreItem {
  readonly hash: string;
  paths: string[];
  base: TrackBase;
  steps: Partial<Record<StepName, StepResult>>;
  applied: Partial<Record<EnrichedField, AppliedField>>;
}

export interface FileHashEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string;
}

export interface Store {
  readonly version: number;
  readonly items: Record<string, StoreItem>;
  /** path → hash, reused while the file's size and modified time stay the same. */
  readonly files: Record<string, FileHashEntry>;
}

export const storePath = (dataDir: string) => join(dataDir, "store.json");

export function emptyStore(): Store {
  return { version: STORE_VERSION, items: {}, files: {} };
}

export function loadStore(dataDir: string): Store {
  let text: string;
  try {
    text = readFileSync(storePath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  const store = JSON.parse(text) as Store;
  if (store.version !== STORE_VERSION) throw new Error(`${storePath(dataDir)} is store version ${String(store.version)}; this tool reads ${String(STORE_VERSION)}. Use a new --data folder.`);
  return store;
}

/** Writes the whole store, atomically: a crash leaves the old file or the new one, never half. */
export function saveStore(dataDir: string, store: Store): void {
  writeAtomically(storePath(dataDir), `${JSON.stringify(store)}\n`);
}

export function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** Whether the collection already has a value for the attribute a field is projected onto. */
export function baseHas(base: TrackBase, field: EnrichedField): boolean {
  switch (field) {
    case "artist":
      return base.artist.trim() !== "";
    case "originalArtist":
      return base.comments.trim() !== "";
    case "title":
      // A title is never empty; cleaning it is a replacement, applied only when asked for.
      return false;
    case "remixer":
      return base.remixer.trim() !== "";
    case "mix":
      return base.mix.trim() !== "";
    case "genre":
      return base.genre.trim() !== "";
    case "genreRaw":
      return false;
    case "year":
      return /^[1-9]\d{3}$/.test(base.year.trim());
  }
}
