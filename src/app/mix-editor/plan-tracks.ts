// The Mix Editor's view of a plan's tracks on this device: each one found in the music folder (or not),
// its beat grid, and its analysis (waveform, confidence) from the analysis cache. Only the plan's own
// tracks are looked at, and only the two of a previewed Transition are ever decoded (the large-library
// rule). Found tracks are kept by content hash, so inserting a track resolves only the newcomer.
import { useEffect, useRef, useState } from "react";
import { IndexedDbAnalysisCache, type TrackAnalysis } from "@analysis";
import type { MixPlan, PlanGrid, PlanTrack } from "@shared/mix-plan.ts";
import { decodeOffline, type FolderFile, type MusicFolderSnapshot } from "@tracks";
import type { PlanLibrary } from "../mix-plans/library.ts";
import { gridForFile, resolvePlanTracks, type TrackResolution } from "../mix-plans/resolve.ts";

export interface PlanTrackData {
  readonly resolution: TrackResolution;
  readonly grid: PlanGrid | null;
  /** The cached analysis of the file found: its waveform overview and grid confidence. */
  readonly analysis: TrackAnalysis | null;
  /** Whether the grid is rekordbox's (then its confidence is rekordbox's business, not ours). */
  readonly fromRekordbox: boolean;
}

/** Below this the editor says the grid may be off. dj-core's fallback grids are capped at 0.5. */
export const LOW_GRID_CONFIDENCE = 0.5;

const cache = new IndexedDbAnalysisCache();

/** Reads `aborted` afresh; TypeScript would otherwise keep an earlier check's narrowing across awaits. */
const wasAborted = (signal: AbortSignal) => signal.aborted;

async function dataFor(track: PlanTrack, resolution: TrackResolution, library: PlanLibrary): Promise<PlanTrackData> {
  if (resolution.kind === "missing") return { resolution, grid: null, analysis: null, fromRekordbox: false };
  const grid = await gridForFile(resolution.file, track, library);
  const hash = resolution.matchedBy === "hash" ? track.contentHash : (library.files().find((file) => file.trackId === resolution.file.trackId)?.contentHash ?? null);
  const analysis = hash === null ? null : ((await cache.get(hash)) ?? null);
  return { resolution, grid, analysis, fromRekordbox: resolution.file.rekordboxGrid !== null };
}

/**
 * Each of the plan's tracks as this device has it, by content hash; tracks still being looked for are
 * absent. Looks again as the folder's scan finds files, for tracks not found yet.
 */
export function usePlanTracks(plan: MixPlan | null, library: PlanLibrary, snapshot: MusicFolderSnapshot): ReadonlyMap<string, PlanTrackData> {
  const [found, setFound] = useState<ReadonlyMap<string, PlanTrackData>>(new Map());
  const foundRef = useRef(found);
  useEffect(() => {
    foundRef.current = found;
  }, [found]);
  const hashes = plan?.tracks.map((track) => track.contentHash).join(",") ?? "";

  useEffect(() => {
    if (plan === null) return;
    const stale = new AbortController();
    const wanted = plan.tracks.filter((track, index, all) => all.findIndex((each) => each.contentHash === track.contentHash) === index);
    const todo = wanted.filter((track) => foundRef.current.get(track.contentHash)?.resolution.kind !== "found");
    if (todo.length === 0) return;
    void (async () => {
      const resolutions = await resolvePlanTracks(todo, library.files());
      // One at a time: a track not analysed yet is analysed now, and only one analysis runs at once.
      for (const [index, track] of todo.entries()) {
        const resolution = resolutions[index];
        if (resolution === undefined || wasAborted(stale.signal)) return;
        const data = await dataFor(track, resolution, library);
        if (wasAborted(stale.signal)) return;
        setFound((now) => new Map([...now, [track.contentHash, data]]));
      }
    })();
    return () => {
      stale.abort();
    };
    // `hashes` stands for the plan's tracks; the scan's counts say when to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashes, library, snapshot.found, snapshot.scanning]);

  return found;
}

/** Decoded audio for previews, a few tracks at most (a Transition's two, and the neighbours). */
export class PreviewAudioCache {
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();

  constructor(private readonly limit = 4) {}

  get(contentHash: string, file: FolderFile): Promise<AudioBuffer> {
    const known = this.buffers.get(contentHash);
    if (known !== undefined) {
      // Most recently used last.
      this.buffers.delete(contentHash);
      this.buffers.set(contentHash, known);
      return known;
    }
    const decoding = file
      .read()
      .then((blob) => blob.arrayBuffer())
      .then((bytes) => decodeOffline(bytes));
    decoding.catch(() => {
      this.buffers.delete(contentHash);
    });
    this.buffers.set(contentHash, decoding);
    while (this.buffers.size > this.limit) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
    }
    return decoding;
  }
}
