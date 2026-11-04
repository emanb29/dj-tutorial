// Finding a plan's tracks on this device. A plan names each track by content hash (shared/track-hash.ts),
// file name and length, never by path, so it is resolved through the Learner's music folder each time
// it opens, and a plan file shared from elsewhere finds the Learner's own copies.
//
// Cheap first, as a large library needs (the folder is never decoded to find a track):
// 1. a file the library already analysed with that hash: no read at all;
// 2. files with the same name and a length that fits: their first 4 MB are hashed (no decode), a few at most
//    (a file in the server's library sends only those 4 MB);
// 3. a file with the same name and length but other bytes (re-encoded, re-tagged): found "by name",
//    and its grid is checked against the plan's (a gridHash mismatch says which Transitions to check);
// 4. otherwise missing: the page offers "Find <file>", and the plan still opens.
// Grids come from rekordbox where it has a one-tempo grid for the file, else the analysis cache, and only
// the plan's own tracks are ever analysed. Nothing here sends anything anywhere.
import { CONTENT_HASH_PREFIX_BYTES, hashTrackBytes } from "@shared/track-hash.ts";
import type { PlanGrid, PlanTrack } from "@shared/mix-plan.ts";
import type { FolderFile, ReadPrefix } from "@tracks";

/** How far a file's known length may be from the plan's and still be the same track. */
const DURATION_TOLERANCE_SEC = 1;
/** Files hashed per track at most: same-named files are few; this bounds a library full of "track01.mp3". */
const MAX_HASHED_PER_TRACK = 4;

export type TrackResolution =
  | { readonly kind: "found"; readonly matchedBy: "hash" | "name"; readonly file: FolderFile }
  | { readonly kind: "missing"; readonly fileName: string; /** e.g. "Find Kay Grove - Brothers.mp3". */ readonly caption: string };

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const lengthFits = (file: Pick<FolderFile, "durationSec">, track: PlanTrack) =>
  file.durationSec === null || Math.abs(file.durationSec - track.durationMs / 1000) <= DURATION_TOLERANCE_SEC;

/**
 * The track's content hash for a file, reading only the part the hash covers and taking the plan's
 * length (no decode). A server library file reads that part with one Range request.
 */
export async function hashAsTrack(readPrefix: ReadPrefix, track: Pick<PlanTrack, "durationMs">): Promise<string> {
  return hashTrackBytes(await readPrefix(CONTENT_HASH_PREFIX_BYTES), track.durationMs / 1000);
}

/** Finds each of `tracks` among the library's `files`, in plan order. */
export async function resolvePlanTracks(tracks: readonly PlanTrack[], files: readonly FolderFile[]): Promise<TrackResolution[]> {
  const byHash = new Map(files.flatMap((file) => (file.contentHash === null ? [] : [[file.contentHash, file] as const])));
  return Promise.all(tracks.map((track) => resolveOne(track, files, byHash)));
}

async function resolveOne(track: PlanTrack, files: readonly FolderFile[], byHash: ReadonlyMap<string, FolderFile>): Promise<TrackResolution> {
  const known = byHash.get(track.contentHash);
  if (known !== undefined) return { kind: "found", matchedBy: "hash", file: known };
  const named = files.filter((file) => sameName(file.name, track.fileName) && lengthFits(file, track));
  // A file whose hash is known (and is not this one) has other bytes: no need to read it.
  for (const file of named.filter((each) => each.contentHash === null).slice(0, MAX_HASHED_PER_TRACK)) {
    try {
      if ((await hashAsTrack(file.readPrefix, track)) === track.contentHash) return { kind: "found", matchedBy: "hash", file };
    } catch (error) {
      // Moved or deleted since the last scan: the next candidate, or missing.
      console.warn("mixPlans.resolve.unreadable", { file: file.name, error });
    }
  }
  const [byName] = named;
  if (byName !== undefined) return { kind: "found", matchedBy: "name", file: byName };
  return { kind: "missing", fileName: track.fileName, caption: `Find ${track.fileName}` };
}

export interface GridSources {
  /** The analysis cache's grid for a content hash, or null. */
  readonly cachedGrid: (contentHash: string) => Promise<PlanGrid | null>;
  /** Analyses one library file (the folder's `ready`), then gives its entry again; null when it is gone. */
  readonly analyse: (trackId: string) => Promise<FolderFile | null>;
}

/** The grid a found file plays on: rekordbox's where it has one, else the analysis (run now for this one file if needed). */
export async function gridForFile(file: FolderFile, track: Pick<PlanTrack, "durationMs">, sources: GridSources): Promise<PlanGrid | null> {
  const durationSec = file.durationSec ?? track.durationMs / 1000;
  if (file.rekordboxGrid !== null) return { ...file.rekordboxGrid, durationSec };
  const analysed = file.contentHash === null ? await sources.analyse(file.trackId) : file;
  if (analysed === null) return null;
  const { contentHash } = analysed;
  return contentHash === null ? null : sources.cachedGrid(contentHash);
}
