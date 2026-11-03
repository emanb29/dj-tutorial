// The one music folder for the app (the setting on /controller, the library in Freestyle), made on
// first use and kept for the page's life, so a scan goes on while the Learner moves between pages.
// When the API server has a music library (MUSIC_DIR), that is the folder, on every device; the
// server sends its files, and they are analysed here as a picked folder's are.
// Its analyser is the Lessons' own: decode at 44.1 kHz, hash the file, analyse with the shared
// analysis cache, so loading the track onto a deck later finds its grid there. A linked rekordbox
// collection's grid, where it matches a file, is used in place of that one (src/tracks/rekordbox).
import { analyseTrack, IndexedDbAnalysisCache } from "@analysis";
import { hashTrackBytes } from "@shared/track-hash.ts";
import {
  createMusicFolder,
  createRekordboxLink,
  decodeOffline,
  indexedDbEntryCache,
  indexedDbHandleStore,
  indexedDbRekordboxCache,
  isServerRoot,
  parseRekordboxFile,
  pollFolder,
  probeServerLibrary,
  scanAnywhere,
  scanServerLibrary,
  watchFolder,
  type AnalyseFileResult,
  type MusicFolder,
  type RekordboxFileHandle,
} from "@tracks";

const HANDLE_KEY = "music-folder";
const REKORDBOX_HANDLE_KEY = "rekordbox-xml";

/** Reads `aborted` afresh; TypeScript would otherwise keep an earlier check's narrowing across awaits. */
const wasAborted = (signal: AbortSignal) => signal.aborted;

export async function analyseFile(file: File, signal: AbortSignal): Promise<AnalyseFileResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (wasAborted(signal)) return { ok: false, kind: "aborted" };
  let audio: AudioBuffer;
  try {
    // decodeAudioData detaches what it is given; the hash still needs the bytes.
    audio = await decodeOffline(bytes.slice().buffer);
  } catch (error) {
    return { ok: false, kind: "failed", reason: `The browser could not decode it: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (wasAborted(signal)) return { ok: false, kind: "aborted" };
  const contentHash = await hashTrackBytes(bytes, audio.duration);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  const outcome = await analyseTrack({ channels, sampleRate: audio.sampleRate }, { cache: new IndexedDbAnalysisCache(), contentHash, signal });
  if (outcome.ok) return { ok: true, contentHash, bpm: outcome.analysis.bpm, durationSec: audio.duration };
  if (outcome.error.kind === "aborted") return { ok: false, kind: "aborted" };
  return { ok: false, kind: "failed", reason: `No beat grid: ${outcome.error.kind}` };
}

let shared: MusicFolder | null = null;

/** The app's music folder; the first call re-opens the remembered folder if the browser allows it. */
export function musicFolder(): MusicFolder {
  if (shared === null) {
    shared = createMusicFolder({
      analyse: analyseFile,
      entryCache: indexedDbEntryCache(),
      handleStore: indexedDbHandleStore(HANDLE_KEY),
      scan: (root, options) => (isServerRoot(root) ? scanServerLibrary()(root, options) : scanAnywhere(root, options)),
      // No browser observer can watch the server's disk: it is asked again every 30 s.
      watch: (root, onChange) => (isServerRoot(root) ? Promise.resolve(pollFolder(onChange)) : watchFolder(root, onChange)),
      server: () => probeServerLibrary(),
      // The Learner's rekordbox collection: parsed in a worker, kept in IndexedDB, never sent anywhere.
      rekordbox: createRekordboxLink({
        parse: parseRekordboxFile,
        cache: indexedDbRekordboxCache(),
        handleStore: indexedDbHandleStore<RekordboxFileHandle>(REKORDBOX_HANDLE_KEY),
      }),
    });
    shared.start().catch((error: unknown) => {
      console.warn("[music-folder] the remembered folder could not be re-opened; pick it again", error);
    });
  }
  return shared;
}
