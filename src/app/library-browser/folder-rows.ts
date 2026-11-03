// The music folder's tracks as library-browser rows, from what the folder already knows: the file name,
// rekordbox's tags (title, artist, album, genre, key, BPM, length, rating, plays) and the analysis cache's
// BPM. Nothing here opens, reads or decodes a file (large-library.test.ts proves it on 10,000 tracks).
import { camelotFromTonality, type FolderFile, type MusicFolder, type Track } from "@tracks";
import type { LibraryRow } from "./browse.ts";

/** What local-files.ts calls a file whose name has no "Artist - Title": not an artist to browse by. */
const NO_ARTIST = "Unknown artist";

const known = (text: string | undefined) => (text === undefined || text.trim() === "" ? null : text.trim());

/** One track as a row: its own tags, with the file's album and whether its grid is ready. */
export function trackRow(track: Pick<Track, "id" | "title" | "artist" | "genre" | "bpmHint" | "keyHint" | "durationSec" | "rating" | "playCount">, extra: { readonly album: string | null; readonly gridReady: boolean }): LibraryRow {
  const artist = known(track.artist);
  return {
    key: track.id,
    title: track.title,
    artist: artist === NO_ARTIST ? null : artist,
    album: extra.album,
    genre: known(track.genre),
    bpm: track.bpmHint ?? null,
    camelot: track.keyHint === undefined ? null : camelotFromTonality(track.keyHint),
    lengthSec: track.durationSec ?? null,
    rating: track.rating ?? null,
    playCount: track.playCount ?? null,
    gridReady: extra.gridReady,
  };
}

/** Every track in the folder, in the order it found them. */
export function folderRows(folder: Pick<MusicFolder, "tracks" | "files" | "gridReady">): readonly LibraryRow[] {
  const files = new Map<string, FolderFile>(folder.files().map((file) => [file.trackId, file]));
  return folder.tracks().map((track) => trackRow(track, { album: files.get(track.id)?.album ?? null, gridReady: folder.gridReady(track.id) }));
}
