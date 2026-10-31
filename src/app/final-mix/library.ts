// The Learner's library for a set: the composer's Originals (exact grids), the starter pack and the
// Learner's own files (analysed in the browser, cached), or with ?track=synthetic the synthetic set
// grooves. Listing is cheap; a track is prepared (grid known) when the Learner adds it to the set,
// and its audio is decoded again only when it goes onto a deck, so a long set never holds every
// track's audio at once.
import { analyseTrack, IndexedDbAnalysisCache } from "@analysis";
import {
  camelotOf,
  lessonTrackFromAnalysis,
  lessonTrackFromKnownGrid,
  synthesizeHouse,
  syntheticLessonTrack,
  SYNTHETIC_SET,
  type SetCandidate,
} from "@lessons";
import {
  createLocalFileSource,
  createOriginalsSource,
  createStarterPackSource,
  decoderAt,
  type AudioDecoder,
  type LocalFileSource,
  type MusicFolder,
  type Track,
  type TrackSource,
} from "@tracks";

export interface LibraryItem {
  readonly key: string;
  readonly source: Track["source"] | "synthetic";
  readonly title: string;
  readonly artist: string;
  readonly bpm: number | null;
  readonly camelot: string | null;
  readonly genre: string | null;
  /** Prepares the track for the set: its grid, then a way to get its audio again. */
  readonly prepare: (options: PrepareOptions) => Promise<PrepareResult>;
  /** The Learner is about to use it (the ring is on it): find its grid first. Music-folder tracks only. */
  readonly want?: () => void;
}

export interface PrepareOptions {
  readonly sampleRate: number;
  readonly signal: AbortSignal;
  readonly onStatus: (status: string) => void;
}

/** A track ready for a set: what the builder and the Check need, and its audio on demand. */
export interface PreparedTrack {
  readonly candidate: SetCandidate;
  readonly loadAudio: (signal: AbortSignal) => Promise<AudioBuffer>;
}

export type PrepareResult = { readonly ok: true; readonly prepared: PreparedTrack } | { readonly ok: false; readonly message: string };

const lower = (text: string | undefined) => (text === undefined || text.trim() === "" ? null : text.trim().toLowerCase());
const meta = (track: Track) => ({ id: `${track.source}:${track.id}`, title: track.title, attribution: track.attribution });

function syntheticItems(): LibraryItem[] {
  return SYNTHETIC_SET.map(({ layout, camelot }) => {
    const track = syntheticLessonTrack(layout);
    const audio = (sampleRate: number) => {
      const samples = synthesizeHouse(layout, sampleRate);
      const buffer = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate });
      buffer.copyToChannel(samples, 0);
      return buffer;
    };
    return {
      key: track.trackId,
      source: "synthetic",
      title: track.title,
      artist: "learn-to-dj",
      bpm: layout.bpm,
      camelot,
      genre: "house",
      prepare: ({ sampleRate }) =>
        Promise.resolve({
          ok: true,
          prepared: { candidate: { track, artist: "learn-to-dj", genre: "house", camelot, shareable: true }, loadAudio: () => Promise.resolve(audio(sampleRate)) },
        }),
    };
  });
}

/** A source track as a library item: Originals carry their grid; the others are analysed (and cached). */
function sourceItem(source: TrackSource, track: Track): LibraryItem {
  const camelot = camelotOf(track.keyHint);
  const genre = lower(track.genre);
  return {
    key: `${track.source}:${track.id}`,
    source: track.source,
    title: track.title,
    artist: track.artist,
    bpm: track.bpmHint ?? null,
    camelot,
    genre,
    // The sources decode at the engine's sample rate already (listLibrary).
    async prepare({ signal, onStatus }) {
      onStatus(`Fetching "${track.title}"…`);
      const loaded = await source.load(track, { signal });
      if (!loaded.ok) return { ok: false, message: `${loaded.error.message} ${loaded.error.fix}` };
      const { audio, contentHash, knownGrid } = loaded.value;
      let lessonTrack = knownGrid === undefined ? null : lessonTrackFromKnownGrid(meta(track), knownGrid);
      if (lessonTrack === null) {
        onStatus(`Finding the beat in "${track.title}"…`);
        const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
        const analysed = await analyseTrack({ channels, sampleRate: audio.sampleRate }, { cache: new IndexedDbAnalysisCache(), contentHash, signal });
        if (!analysed.ok) return { ok: false, message: `"${track.title}" could not be analysed. Pick another track.` };
        lessonTrack = lessonTrackFromAnalysis(meta(track), analysed.analysis);
        if (lessonTrack === null) return { ok: false, message: `"${track.title}" has no clear bar 1 to grade on. Pick another track.` };
      }
      const candidate: SetCandidate = { track: lessonTrack, artist: track.artist, genre, camelot, shareable: track.shareable };
      const loadAudio = async (again: AbortSignal) => {
        const reloaded = await source.load(track, { signal: again });
        if (!reloaded.ok) throw new Error(`${reloaded.error.message} ${reloaded.error.fix}`);
        return reloaded.value.audio;
      };
      return { ok: true, prepared: { candidate, loadAudio } };
    },
  };
}

/**
 * A music-folder track as a library item. Its grid comes from the folder's background analysis
 * (asked for first, and waited for), so preparing it then finds the grid in the analysis cache.
 */
function folderItem(folder: MusicFolder, source: TrackSource, track: Track): LibraryItem {
  const item = sourceItem(source, track);
  return {
    ...item,
    want: () => {
      folder.want(track.id);
    },
    async prepare(options) {
      options.onStatus(`Finding the beat in "${track.title}"…`);
      await folder.ready(track.id, options.signal);
      return item.prepare(options);
    },
  };
}

/** The music folder's tracks as library items; a track keeps its item until it changes (its BPM arrives). */
export interface FolderLibrary {
  readonly music: MusicFolder;
  readonly items: () => readonly LibraryItem[];
}

export function folderLibrary(music: MusicFolder, decode: AudioDecoder): FolderLibrary {
  const source = music.source(decode);
  let made = new Map<Track, LibraryItem>();
  return {
    music,
    items: () => {
      made = new Map(music.tracks().map((track) => [track, made.get(track) ?? folderItem(music, source, track)] as const));
      return [...made.values()];
    },
  };
}

export interface Library {
  readonly items: readonly LibraryItem[];
  /** The Learner's music folder (the setting on /controller); null in the synthetic library. */
  readonly folder: FolderLibrary | null;
  /** Your own files: add them from a file input. Null in the synthetic library. */
  readonly files: LocalFileSource | null;
  /** Library items for files the Learner just added. */
  readonly addFiles: (files: Iterable<File>) => readonly LibraryItem[];
}

/**
 * Lists the library: Originals and the starter pack (house first), or the synthetic set grooves.
 * With `music`, the music folder's tracks come too, through `folder` (they change as it scans).
 */
export async function listLibrary(preference: "auto" | "synthetic", sampleRate: number, signal: AbortSignal, music?: MusicFolder): Promise<Library> {
  const decode = decoderAt(sampleRate);
  // The folder is the Learner's own and needs no network, so it comes with the synthetic grooves too.
  const folder = music === undefined ? null : folderLibrary(music, decode);
  if (preference === "synthetic") return { items: syntheticItems(), folder, files: null, addFiles: () => [] };
  const originals = createOriginalsSource({ decode });
  const starter = createStarterPackSource({ decode });
  const files = createLocalFileSource({ decode });
  const [fromOriginals, fromStarter] = await Promise.all([originals.list({ signal }), starter.list({ signal })]);
  const listed = [
    ...(fromOriginals.ok ? fromOriginals.value.map((track) => sourceItem(originals, track)) : []),
    ...(fromStarter.ok ? fromStarter.value.map((track) => sourceItem(starter, track)) : []),
  ];
  const houseFirst = listed.toSorted((a, b) => Number((b.genre ?? "").includes("house")) - Number((a.genre ?? "").includes("house")));
  return { items: houseFirst, folder, files, addFiles: (added) => files.addFiles(added).map((track) => sourceItem(files, track)) };
}
