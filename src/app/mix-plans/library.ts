// The music folder as the Mix Plans page needs it: the files, one file analysed on demand, and the
// grid each file plays on. Only the plan's own tracks are ever analysed (the large-library rule).
import { IndexedDbAnalysisCache } from "@analysis";
import type { PlanGrid, PlanTrack } from "@shared/mix-plan.ts";
import { decoderAt, type FolderFile, type MusicFolder } from "@tracks";
import { analyseFile } from "../music-folder/shared-folder.ts";
import { planTrackGainDb, planTrackGainDbOf } from "./level.ts";
import { gridForFile, hashAsTrack, type GridSources } from "./resolve.ts";

/** The rate a track is decoded at to measure its peak (the Render's). */
const MEASURE_RATE = 44_100;

export interface PlanLibrary extends GridSources {
  readonly files: () => readonly FolderFile[];
  /** A file the Learner picked by hand ("Find <file>"): whether it is the plan's track, and its grid. */
  readonly checkPicked: (file: File, track: PlanTrack) => Promise<{ readonly sameFile: boolean; readonly grid: PlanGrid | null }>;
  /** A picked track's level match (`gainDb`): the Lessons' set-up trim from its decoded peak. */
  readonly levelMatch: (file: FolderFile) => Promise<number>;
}

export function planLibrary(folder: MusicFolder): PlanLibrary {
  const cache = new IndexedDbAnalysisCache();
  const cachedGrid = async (contentHash: string): Promise<PlanGrid | null> => (await cache.get(contentHash)) ?? null;
  return {
    files: () => folder.files(),
    cachedGrid,
    async analyse(trackId) {
      await folder.ready(trackId, new AbortController().signal);
      return folder.files().find((file) => file.trackId === trackId) ?? null;
    },
    async levelMatch(file) {
      try {
        return planTrackGainDbOf(await decoderAt(MEASURE_RATE)(await (await file.read()).arrayBuffer()));
      } catch (error) {
        // Recovered: an unmeasured track gets the Lessons' default; the Render reports any clipping.
        console.warn("[mix-plans] a picked track's peak could not be measured", { file: file.name, error });
        return planTrackGainDb(null);
      }
    },
    async checkPicked(file, track) {
      const sameFile = (await hashAsTrack(file, track)) === track.contentHash;
      // Decodes and analyses this one file, caching its grid under its own hash.
      const analysed = await analyseFile(file, new AbortController().signal);
      return { sameFile, grid: analysed.ok ? await cachedGrid(analysed.contentHash) : null };
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
    gainDb: await library.levelMatch(analysed),
  };
}
