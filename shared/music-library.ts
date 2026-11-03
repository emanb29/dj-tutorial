/**
 * The contract for the server's music library: a folder on the API server's disk (`MUSIC_DIR`),
 * served to every browser that opens the app, so a phone or another laptop reaching the app
 * through a tunnel has the same library as the computer the music is on.
 *
 * - `GET /api/music-library` answers `{ configured: false }` when the server has no `MUSIC_DIR`,
 *   else the folder's index: every audio file's path (relative to the folder, "/" between parts),
 *   size and lastModified, plus the .xml files on the way (a rekordbox export may be one) and
 *   `REKORDBOX_XML`, a rekordbox export kept outside the folder. Nothing is decoded or hashed.
 * - `GET /api/music-library/file?path=<path>` sends one of those files (single byte ranges, ETag).
 * - `GET /api/music-library/rekordbox.xml` sends `REKORDBOX_XML`.
 *
 * The walk's limits and the audio extensions are the browser's own folder walk's
 * (src/tracks/music-folder/scan.ts), so a folder lists the same on the server as when picked.
 */
import { z } from "zod";

export const MUSIC_LIBRARY_PATH = "/api/music-library";
export const MUSIC_LIBRARY_FILE_PATH = `${MUSIC_LIBRARY_PATH}/file`;
export const MUSIC_LIBRARY_REKORDBOX_PATH = `${MUSIC_LIBRARY_PATH}/rekordbox.xml`;

/** A folder this big is still walked, but only this far; the rest waits for a smaller folder. */
export const MAX_LIBRARY_FILES = 20_000;
/** Subfolders deeper than this are passed over (a home folder cannot walk forever). */
export const MAX_LIBRARY_DEPTH = 12;
/** XML files noted per walk at most: a rekordbox export is one file, not hundreds. */
export const MAX_LIBRARY_XML_FILES = 20;

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "webm"]);

const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "");

/** Whether a file name ends in an audio extension (for folder walks, before the file is opened). */
export function hasAudioExtension(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

export const isXmlName = (name: string): boolean => extensionOf(name) === "xml";

/**
 * A path inside the library as the index lists it: relative, "/" between parts, no empty, "." or
 * ".." part, no hidden part (".name"), no backslash or NUL. The server checks every requested path
 * against this before touching the disk.
 */
export function isLibraryPath(path: string): boolean {
  if (path === "" || path.length > 4096 || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && !part.startsWith("."));
}

const LibraryPathSchema = z.string().refine(isLibraryPath, "a relative path inside the library, with no hidden or '..' part");

export const LibraryFileSchema = z.object({
  path: LibraryPathSchema,
  size: z.number().int().nonnegative(),
  lastModified: z.number().nonnegative(),
});
export type LibraryFile = z.infer<typeof LibraryFileSchema>;

export const MusicLibraryIndexSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    /** The folder's own name, as a picked folder's name is shown. */
    name: z.string().min(1),
    files: z.array(LibraryFileSchema).max(MAX_LIBRARY_FILES),
    xml: z.array(LibraryFileSchema).max(MAX_LIBRARY_XML_FILES),
    /** `REKORDBOX_XML`'s stamp; null when it is unset. */
    rekordboxXml: z.object({ size: z.number().int().nonnegative(), lastModified: z.number().nonnegative() }).nullable(),
    /** Files or subfolders the walk could not read (each logged at WARN on the server). */
    skipped: z.number().int().nonnegative(),
    /** Whether the walk stopped at MAX_LIBRARY_FILES. */
    truncated: z.boolean(),
  }),
]);
export type MusicLibraryIndex = z.infer<typeof MusicLibraryIndexSchema>;
export type ConfiguredMusicLibrary = Extract<MusicLibraryIndex, { configured: true }>;

/** The URL of one library file. */
export const libraryFileUrl = (path: string, apiBase = ""): string => `${apiBase}${MUSIC_LIBRARY_FILE_PATH}?path=${encodeURIComponent(path)}`;
