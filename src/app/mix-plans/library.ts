// The music folder as the Mix Plans page needs it: the files, one file analysed on demand, and the
// grid each file plays on. Only the plan's own tracks are ever analysed (the large-library rule).
//
// Without the analysis model (public/models, `npm run fetch-models`) the folder's analysis falls back
// to dj-core and, by design, caches nothing, so a track without a rekordbox grid would have no grid to
// plan on. Local music comes first: such a track is analysed again here, with dj-core asked for by
// name, which is cached (under its own key) and found on the next visit.
import { analyseTrack, analysisCacheKey, IndexedDbAnalysisCache, type AnalysisCache, type TrackAnalysis } from "@analysis";
import type { PlanGrid, PlanTrack } from "@shared/mix-plan.ts";
import { decodeOffline, type FolderFile, type MusicFolder } from "@tracks";
import { analyseFile } from "../music-folder/shared-folder.ts";
import { gridForFile, hashAsTrack, type GridSources } from "./resolve.ts";

export interface PlanLibrary extends GridSources {
  readonly files: () => readonly FolderFile[];
  /** A file the Learner picked by hand ("Find <file>"): whether it is the plan's track, and its grid. */
  readonly checkPicked: (file: File, track: PlanTrack) => Promise<{ readonly sameFile: boolean; readonly grid: PlanGrid | null }>;
}

/**
 * A track's cached analysis: the folder's own (the model's, method "auto"), else a dj-core one made
 * for planning. analyseTrack keeps each under the hash and the method (analysisCacheKey), never the bare hash.
 */
export async function cachedAnalysis(cache: AnalysisCache, contentHash: string): Promise<TrackAnalysis | null> {
  return (await cache.get(analysisCacheKey(contentHash))) ?? (await cache.get(analysisCacheKey(contentHash, "dj-core")));
}

/** The dj-core grid of one file, analysed now and cached; null when it will not decode or has no steady beat. */
export async function djCoreGrid(cache: AnalysisCache, file: Blob, contentHash: string): Promise<PlanGrid | null> {
  let audio: AudioBuffer;
  try {
    audio = await decodeOffline(await file.arrayBuffer());
  } catch (error) {
    console.warn("[mix-plans] a track would not decode for its fallback grid", error);
    return null;
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  const outcome = await analyseTrack({ channels, sampleRate: audio.sampleRate }, { cache, contentHash, method: "dj-core" });
  return outcome.ok ? outcome.analysis : null;
}

export function planLibrary(folder: MusicFolder): PlanLibrary {
  const cache = new IndexedDbAnalysisCache();
  const cachedGrid = async (contentHash: string): Promise<PlanGrid | null> => cachedAnalysis(cache, contentHash);
  return {
    files: () => folder.files(),
    cachedGrid,
    fallbackGrid: async (file, contentHash) => djCoreGrid(cache, await file.read(), contentHash),
    async analyse(trackId) {
      await folder.ready(trackId, new AbortController().signal);
      return folder.files().find((file) => file.trackId === trackId) ?? null;
    },
    async checkPicked(file, track) {
      const sameFile = (await hashAsTrack(file, track)) === track.contentHash;
      // Decodes and analyses this one file, caching its grid under its own hash.
      const analysed = await analyseFile(file, new AbortController().signal);
      if (!analysed.ok) return { sameFile, grid: null };
      return { sameFile, grid: (await cachedGrid(analysed.contentHash)) ?? (await djCoreGrid(cache, file, analysed.contentHash)) };
    },
  };
}

/** What a picked library file contributes to a new plan, analysing it first if the library has not yet; null when it has no grid. */
export async function pickedTrack(library: PlanLibrary, file: FolderFile, display: { readonly title: string; readonly artist: string }) {
  const analysed = file.contentHash === null || file.durationSec === null ? await library.analyse(file.trackId) : file;
  if (analysed === null) return null;
  const { contentHash, durationSec } = analysed;
  if (contentHash === null || durationSec === null) return null;
  const durationMs = Math.round(durationSec * 1000);
  const grid = await gridForFile(analysed, { durationMs }, library);
  if (grid === null) return null;
  return {
    track: { contentHash, fileName: analysed.name, durationMs, title: display.title, artist: display.artist },
    grid,
  };
}
