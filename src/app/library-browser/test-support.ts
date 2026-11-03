// A large invented music folder for the library browser's tests: 10,000 files, the even-numbered half
// known to a rekordbox collection in the folder (tags, album, key in either notation, BPM, a one-tempo
// grid), the rest bare file names. It counts every file opened and every decode. Nothing is real music.
import { memoryHandleStore } from "../../tracks/local-files.ts";
import { memoryEntryCache } from "../../tracks/music-folder/entry-cache.ts";
import { createMusicFolder, type AnalyseFileResult, type MusicFolder } from "../../tracks/music-folder/music-folder.ts";
import { scanFolder } from "../../tracks/music-folder/scan.ts";
import { fakeFolder, type FakeFolder } from "../../tracks/music-folder/test-support.ts";
import { parseRekordboxFileHere } from "../../tracks/rekordbox/parser.ts";
import { createRekordboxLink } from "../../tracks/rekordbox/rekordbox-link.ts";
import { CAMELOT_KEYS, musicalKey } from "./browse.ts";

export const LARGE_LIBRARY_SIZE = 10_000;
const GENRES = ["House", "Techno", "Disco", "Garage", "Breaks"];

/** "Artist 7 - Track 00042.mp3": 50 artists over the folder. */
export const fileName = (index: number) => `Artist ${String(index % 50)} - Track ${String(index).padStart(5, "0")}.mp3`;

/** Every key on the wheel in turn, written as rekordbox may: Camelot ("8A") or musical ("Am"), alternately. */
const tonality = (half: number) => {
  const camelot = CAMELOT_KEYS[half % 24] ?? "";
  return half % 2 === 0 ? camelot : (musicalKey(camelot) ?? "");
};

/** A rekordbox collection that knows the even-numbered files. */
function largeCollection(size: number): string {
  const tracks = Array.from({ length: size / 2 }, (_, half) => {
    const index = half * 2;
    const bpm = (118 + (index % 15)).toFixed(2);
    const location = `file://localhost/Users/dj/Music/${encodeURIComponent(fileName(index))}`;
    return `<TRACK Name="Track ${String(index)}" Artist="Artist ${String(index % 50)}" Album="Album ${String(index % 200)}" Genre="${GENRES[index % GENRES.length] ?? ""}" AverageBpm="${bpm}" Tonality="${tonality(half)}" TotalTime="${String(180 + (index % 240))}" Rating="${String((index % 6) * 51)}" PlayCount="${String(index % 30)}" Location="${location}"><TEMPO Inizio="0.050" Bpm="${bpm}" Metro="4/4" Battito="1"/></TRACK>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${String(tracks.length)}">${tracks.join("")}</COLLECTION></DJ_PLAYLISTS>`;
}

export interface LargeLibrary {
  readonly music: MusicFolder;
  readonly folder: FakeFolder;
  /** Files handed to the analyser (decoded): none, unless something asked. */
  readonly decoded: readonly string[];
  /** Files the scan itself opened (the rekordbox.xml): what browsing must not add to. */
  readonly openedByScan: number;
}

/** The folder, picked and scanned, with background analysis paused (the app's default). */
export async function largeLibrary(size = LARGE_LIBRARY_SIZE): Promise<LargeLibrary> {
  const folder = fakeFolder("Music");
  for (let index = 0; index < size; index += 1) folder.write(fileName(index), "not music");
  folder.write("rekordbox.xml", largeCollection(size));
  const decoded: string[] = [];
  const analyse = (file: File): Promise<AnalyseFileResult> => {
    decoded.push(file.name);
    return Promise.resolve({ ok: false, kind: "failed", reason: "The test analyser decodes nothing." });
  };
  const music = createMusicFolder({
    analyse,
    entryCache: memoryEntryCache(),
    handleStore: memoryHandleStore(),
    showDirectoryPicker: () => Promise.resolve(folder),
    scan: scanFolder,
    watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
    rekordbox: createRekordboxLink({ parse: parseRekordboxFileHere, showOpenFilePicker: null, handleStore: memoryHandleStore() }),
  });
  await music.pick();
  await music.settled();
  return { music, folder, decoded, openedByScan: folder.opened };
}
