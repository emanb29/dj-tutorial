// A music-folder file as a preview (the mini player, preview-player.ts): its media as the folder gives
// it (a local file; a server-side library's would be a URL), and hints from what is already known
// about it: rekordbox's cues and grid, and the analysis cache's grid and phrase hints once it has been
// analysed. Building one reads nothing; the hints are read on play, and never from the audio.
import type { AnalysisCache } from "@analysis";
import type { FolderFile, PreviewHints, TrackPreview } from "@tracks";

const BEAT_SEC = (bpm: number) => 60 / bpm;

async function analysisOf(file: FolderFile, cache: Pick<AnalysisCache, "get"> | null) {
  if (cache === null || file.contentHash === null) return null;
  try {
    return await cache.get(file.contentHash);
  } catch (error) {
    // IndexedDB blocked (a private window): the preview starts from rekordbox's hints or a third in.
    console.warn("[library-preview] the analysis cache could not be read; the preview starts without it", error);
    return null;
  }
}

export function folderPreview(file: FolderFile, cache: Pick<AnalysisCache, "get"> | null): TrackPreview {
  return {
    media: file.media,
    async hints(): Promise<PreviewHints> {
      const analysis = await analysisOf(file, cache);
      const rekordbox = file.rekordboxGrid;
      const grid =
        rekordbox !== null
          ? { bpm: rekordbox.bpm, barOneSec: rekordbox.firstBeatSec + rekordbox.downbeatPhase * BEAT_SEC(rekordbox.bpm) }
          : analysis !== null && analysis.downbeatPhase !== null
            ? { bpm: analysis.bpm, barOneSec: analysis.firstBeatSec + analysis.downbeatPhase * BEAT_SEC(analysis.bpm) }
            : undefined;
      const durationSec = file.durationSec ?? analysis?.durationSec;
      return {
        ...(durationSec === undefined ? {} : { durationSec }),
        cues: file.cues,
        energyRises: (analysis?.phraseHints ?? []).filter((hint) => hint.kind === "energy-up"),
        ...(grid === undefined ? {} : { grid }),
      };
    },
  };
}
