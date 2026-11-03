// The server's music library (MUSIC_DIR, shared/music-library.ts) as a music folder: the API server
// walks its own disk and sends files on request, so every browser that opens the app (a phone
// through the tunnel too) has the library of the computer the music is on, with nothing to pick.
// The rest of the music folder (analysis, the entry cache, rekordbox) works on it as on a picked one.
import { MAX_LIBRARY_XML_FILES, MUSIC_LIBRARY_PATH, MUSIC_LIBRARY_REKORDBOX_PATH, MusicLibraryIndexSchema, libraryFileUrl, type LibraryFile } from "@shared/music-library.ts";
import type { DirectoryHandleLike, FileHandleLike } from "../local-files.ts";
import type { TrackError } from "../types.ts";
import type { ScannedFile, ScanOptions, ScanSummary } from "./scan.ts";

const BATCH_SIZE = 50;

/** The server's library, standing where a picked folder's handle would. It is never walked as one. */
export interface ServerLibraryRoot extends DirectoryHandleLike {
  readonly server: true;
}

export const isServerRoot = (root: DirectoryHandleLike): root is ServerLibraryRoot => (root as Partial<ServerLibraryRoot>).server === true;

/** What the server says: no library (each browser picks its own), its library, or one it cannot read. */
export type ServerLibraryProbe =
  | { readonly kind: "none" }
  | { readonly kind: "library"; readonly root: ServerLibraryRoot }
  | { readonly kind: "unavailable"; readonly error: TrackError };

export interface ServerLibraryOptions {
  readonly fetch?: typeof fetch;
  /** Prefix for the API's paths; "" (the page's own origin, through Vite's proxy) by default. */
  readonly apiBase?: string;
}

function serverRoot(name: string): ServerLibraryRoot {
  return {
    kind: "directory",
    name,
    server: true,
    // The scan asks the server for the index instead (scanServerLibrary).
    values: () => {
      throw new Error("The server's music library is listed by scanServerLibrary, not walked.");
    },
  };
}

const unavailable = (message: string): TrackError => ({
  kind: "network",
  message,
  fix: "Check that the API is running and MUSIC_DIR in its .env names a readable folder, then reload.",
});

async function readIndex(options: ServerLibraryOptions): Promise<{ ok: true; index: unknown } | { ok: false; status: number; error: string | null }> {
  const response = await (options.fetch ?? fetch)(`${options.apiBase ?? ""}${MUSIC_LIBRARY_PATH}`, { cache: "no-store" });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const envelope = body as { success?: boolean; data?: unknown; error?: unknown } | null;
  if (response.ok && envelope?.success === true) return { ok: true, index: envelope.data };
  return { ok: false, status: response.status, error: typeof envelope?.error === "string" ? envelope.error : null };
}

/**
 * Asks the server whether it has a music library. An API that cannot be reached, or one from before
 * this route, counts as none (logged at WARN): the browser's own folder is then used, as before.
 */
export async function probeServerLibrary(options: ServerLibraryOptions = {}): Promise<ServerLibraryProbe> {
  let read: Awaited<ReturnType<typeof readIndex>>;
  try {
    read = await readIndex(options);
  } catch (error) {
    console.warn("tracks.serverLibrary.unreachable", { reason: error instanceof Error ? error.message : String(error) });
    return { kind: "none" };
  }
  if (!read.ok) {
    if (read.status === 404) return { kind: "none" };
    return { kind: "unavailable", error: unavailable(read.error ?? `The server's music library answered ${String(read.status)}.`) };
  }
  const parsed = MusicLibraryIndexSchema.safeParse(read.index);
  if (!parsed.success) return { kind: "unavailable", error: unavailable("The server's music library sent an index this page cannot read. Reload the page: the app may have been updated.") };
  return parsed.data.configured ? { kind: "library", root: serverRoot(parsed.data.name) } : { kind: "none" };
}

/** Fetches one file of the library as a File, with the date the index gave it. */
function fileHandle(url: string, name: string, lastModified: number, options: ServerLibraryOptions): FileHandleLike {
  return {
    kind: "file",
    name,
    getFile: async () => {
      const response = await (options.fetch ?? fetch)(url);
      if (!response.ok) throw new DOMException(`The server could not send "${name}" (${String(response.status)}).`, "NotFoundError");
      return new File([await response.blob()], name, { lastModified, type: response.headers.get("content-type") ?? "" });
    },
  };
}

const nameOf = (path: string) => path.split("/").pop() ?? path;

/**
 * The scan for the server's library: one request for the index, then batches as a folder walk gives
 * them, paths from the folder's name down ("Music/House/a.mp3"). Nothing is downloaded until read.
 */
export function scanServerLibrary(options: ServerLibraryOptions = {}) {
  return async (root: DirectoryHandleLike, scan: ScanOptions): Promise<ScanSummary> => {
    const read = await readIndex(options);
    if (!read.ok) throw new Error(read.error ?? `The server's music library answered ${String(read.status)}.`);
    const parsed = MusicLibraryIndexSchema.parse(read.index);
    if (!parsed.configured) throw new Error("The server no longer has a music library (MUSIC_DIR). Reload the page.");
    const scanned = (file: LibraryFile, url: string, path = `${root.name}/${file.path}`): ScannedFile => ({
      path,
      name: nameOf(file.path),
      size: file.size,
      lastModified: file.lastModified,
      handle: fileHandle(url, nameOf(file.path), file.lastModified, options),
    });
    const maxFiles = scan.maxFiles ?? Number.POSITIVE_INFINITY;
    const files = parsed.files.slice(0, maxFiles).map((file) => scanned(file, libraryFileUrl(file.path, options.apiBase)));
    const batchSize = scan.batchSize ?? BATCH_SIZE;
    for (let first = 0; first < files.length && scan.signal?.aborted !== true; first += batchSize) scan.onBatch(files.slice(first, first + batchSize));
    // REKORDBOX_XML, when the server sets it, is the collection: the folder's own .xml files are not offered.
    const { rekordboxXml } = parsed;
    const xml =
      rekordboxXml === null
        ? parsed.xml.map((file) => scanned(file, libraryFileUrl(file.path, options.apiBase)))
        : [scanned({ path: "rekordbox.xml", ...rekordboxXml }, `${options.apiBase ?? ""}${MUSIC_LIBRARY_REKORDBOX_PATH}`, "rekordbox.xml")];
    return { files: files.length, skipped: parsed.skipped, truncated: parsed.truncated || parsed.files.length > maxFiles, xml: xml.slice(0, MAX_LIBRARY_XML_FILES) };
  };
}
