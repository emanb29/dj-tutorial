// The cheap first pass over a music folder: walk it, open only files with an audio extension, and
// note each one's path, size and lastModified. Nothing is decoded here. It runs in a worker
// (scan.worker.ts) for real folders, or inline (fake folders in tests, the e2e's in-memory one).
import { hasAudioExtension, type DirectoryHandleLike, type FileHandleLike } from "../local-files.ts";

/** A folder this big is still walked, but only this far; the rest waits for a smaller folder. */
export const MAX_FOLDER_FILES = 20_000;
/** Subfolders deeper than this are passed over (a picked home folder cannot walk forever). */
export const MAX_FOLDER_DEPTH = 12;
const BATCH_SIZE = 50;

/** What a file looks like on disk: enough to tell whether it changed since the last scan. */
export interface FileStamp {
  readonly size: number;
  readonly lastModified: number;
}

export interface ScannedFile extends FileStamp {
  /** From the picked folder's name down, "/" between parts: "Music/House/a.mp3". */
  readonly path: string;
  readonly name: string;
  readonly handle: FileHandleLike;
}

export interface ScanSummary {
  /** Audio files found. */
  readonly files: number;
  /** Files or subfolders that could not be read (moved, locked); each was logged at WARN. */
  readonly skipped: number;
  /** Whether the walk stopped at the file limit. */
  readonly truncated: boolean;
}

export interface ScanOptions {
  /** Called with each batch of files as the walk finds them. */
  readonly onBatch: (batch: readonly ScannedFile[]) => void;
  readonly batchSize?: number;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

const hidden = (name: string) => name.startsWith(".");

/**
 * Walks `root`. Reading the root itself failing (permission gone, folder moved) throws the browser's
 * DOMException for the caller to turn into a TrackError; anything deeper is skipped and counted.
 */
export async function scanFolder(root: DirectoryHandleLike, options: ScanOptions): Promise<ScanSummary> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxFiles = options.maxFiles ?? MAX_FOLDER_FILES;
  const maxDepth = options.maxDepth ?? MAX_FOLDER_DEPTH;
  const { signal } = options;
  let batch: ScannedFile[] = [];
  let files = 0;
  let skipped = 0;
  const flush = () => {
    if (batch.length === 0) return;
    options.onBatch(batch);
    batch = [];
  };
  const full = () => files >= maxFiles || signal?.aborted === true;

  const visit = async (folder: DirectoryHandleLike, prefix: string, depth: number): Promise<void> => {
    for await (const entry of folder.values()) {
      if (full()) return;
      if (hidden(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "directory") {
        if (depth + 1 > maxDepth) continue;
        try {
          await visit(entry, `${path}/`, depth + 1);
        } catch (error) {
          skipped += 1;
          console.warn("tracks.folder.unreadable", { path, reason: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      if (!hasAudioExtension(entry.name)) continue;
      let file: File;
      try {
        file = await entry.getFile();
      } catch (error) {
        skipped += 1;
        console.warn("tracks.folder.unreadable", { path, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      files += 1;
      batch.push({ path, name: entry.name, size: file.size, lastModified: file.lastModified, handle: entry });
      if (batch.length >= batchSize) flush();
    }
  };

  if (signal?.aborted !== true) await visit(root, `${root.name}/`, 0);
  flush();
  const truncated = files >= maxFiles;
  if (truncated) console.warn("tracks.folder.truncated", { folder: root.name, maxFiles });
  return { files, skipped, truncated };
}

export interface ScanDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

const sameStamp = (a: FileStamp, b: FileStamp) => a.size === b.size && a.lastModified === b.lastModified;

/** What a scan changed: paths new since `before`, changed (size or date), gone, and the same. */
export function diffScan(before: ReadonlyMap<string, FileStamp>, after: ReadonlyMap<string, FileStamp>): ScanDiff {
  const afterPaths = [...after.keys()];
  return {
    added: afterPaths.filter((path) => !before.has(path)),
    changed: afterPaths.filter((path) => {
      const old = before.get(path);
      const now = after.get(path);
      return old !== undefined && now !== undefined && !sameStamp(old, now);
    }),
    removed: [...before.keys()].filter((path) => !after.has(path)),
    unchanged: afterPaths.filter((path) => {
      const old = before.get(path);
      const now = after.get(path);
      return old !== undefined && now !== undefined && sameStamp(old, now);
    }),
  };
}
