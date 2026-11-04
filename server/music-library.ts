/**
 * `/api/music-library`: the music folder on this server's disk (`MUSIC_DIR`), for every browser
 * that opens the app (contract in shared/music-library.ts).
 *
 * - `GET /` walks the folder (names, sizes and dates only; nothing is read or decoded) and lists its
 *   audio and .xml files. A walk is reused for INDEX_TTL_MS, one walk at a time, so several open
 *   pages polling every 30 s walk a big folder (on a slow disk, seconds) once between them.
 * - `GET /file?path=` sends one file, with single byte ranges and an ETag (a phone that loads the
 *   same track again gets a 304, not the whole file over the tunnel).
 * - `GET /rekordbox.xml` sends `REKORDBOX_XML`, when it is set.
 *
 * Path safety: a requested path must pass `isLibraryPath` (relative, no "..", no hidden part) and
 * name an audio or .xml file, and its real path (after symlinks) must be inside the folder's real
 * path; the walk follows a symlink only on the same terms. Anything else is a 404. The routes sit
 * under `/api/*`, so the same-origin guard in app.ts applies to them. Whoever can open the app can
 * read these files: put the tunnel's own login in front of it (AGENTS.md, "Dev server and remote access").
 */
import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Hono, type Context } from "hono";
import type { ApiFailure, ApiSuccess } from "@shared";
import {
  MAX_LIBRARY_DEPTH,
  MAX_LIBRARY_FILES,
  MAX_LIBRARY_XML_FILES,
  hasAudioExtension,
  isLibraryPath,
  isXmlName,
  type LibraryFile,
  type MusicLibraryIndex,
} from "@shared/music-library.ts";
import { fileResponse } from "./byte-range.ts";
import type { Logger } from "./logger.ts";

/** How long one walk answers every page's poll (the pages poll every 30 s); Rescan now waits this long at most for a new file. */
export const INDEX_TTL_MS = 5_000;
/** Files stat'ed at once per folder: a folder on a slow disk (a network or Windows drive) is walked in parallel, but boundedly. */
const STAT_CONCURRENCY = 32;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  webm: "audio/webm",
  xml: "application/xml",
};

export interface MusicLibraryOptions {
  /** `MUSIC_DIR`; null = the server has no music library. */
  readonly root: string | null;
  /** `REKORDBOX_XML`; null = none outside the folder. */
  readonly rekordboxXml: string | null;
  readonly logger: Logger;
  readonly now?: () => number;
}

type Walked = Omit<Extract<MusicLibraryIndex, { configured: true }>, "configured" | "rekordboxXml">;

function failure(context: Context, status: 400 | 404 | 503, code: ApiFailure["code"], error: string) {
  return context.json({ success: false, error, ...(code === undefined ? {} : { code }) } satisfies ApiFailure, status);
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "");

const inside = (realRoot: string, realPath: string) => realPath.startsWith(realRoot + sep);

const stampOf = (path: string, stats: Stats): LibraryFile => ({ path, size: stats.size, lastModified: Math.trunc(stats.mtimeMs) });

/** Walks the folder as the browser's own walk does (shared limits, hidden names skipped, names in order). */
async function walkLibrary(root: string, logger: Logger): Promise<Walked> {
  // The root itself failing (gone, not a folder, not readable) throws, for the route to report.
  const realRoot = await realpath(root);
  const files: LibraryFile[] = [];
  const xml: LibraryFile[] = [];
  let skipped = 0;
  let truncated = false;
  // Read afresh after an await: TypeScript keeps an earlier check's narrowing, but the nested walk sets it.
  const stopped = () => truncated;
  const skip = (path: string, error: unknown) => {
    skipped += 1;
    logger.warn("musicLibrary.unreadable", { path, reason: errorCode(error) ?? (error instanceof Error ? error.message : String(error)) });
  };

  /** What a folder entry is, following a symlink only to somewhere inside the folder. */
  const kindOf = async (full: string, entry: Dirent): Promise<{ kind: "directory" | "file"; stats: Stats | null } | null> => {
    if (entry.isDirectory()) return { kind: "directory", stats: null };
    if (entry.isFile()) return { kind: "file", stats: await stat(full) };
    if (!entry.isSymbolicLink()) return null;
    const target = await realpath(full);
    if (!inside(realRoot, target)) return null;
    const stats = await stat(target);
    return stats.isDirectory() ? { kind: "directory", stats } : stats.isFile() ? { kind: "file", stats } : null;
  };

  const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (let first = 0; first < entries.length; first += STAT_CONCURRENCY) {
      const chunk = entries
        .slice(first, first + STAT_CONCURRENCY)
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || hasAudioExtension(entry.name) || isXmlName(entry.name));
      const kinds = await Promise.all(
        chunk.map(async (entry) => {
          const path = `${prefix}${entry.name}`;
          try {
            return { entry, path, kind: await kindOf(join(folder, entry.name), entry) };
          } catch (error) {
            skip(path, error);
            return { entry, path, kind: null };
          }
        }),
      );
      for (const { entry, path, kind } of kinds) {
        if (files.length >= MAX_LIBRARY_FILES) {
          truncated = true;
          return;
        }
        if (kind === null) continue;
        if (kind.kind === "directory") {
          if (depth + 1 > MAX_LIBRARY_DEPTH) continue;
          try {
            await visit(join(folder, entry.name), `${path}/`, depth + 1);
          } catch (error) {
            skip(path, error);
          }
          if (stopped()) return;
          continue;
        }
        if (kind.stats === null) continue;
        if (hasAudioExtension(entry.name)) files.push(stampOf(path, kind.stats));
        else if (isXmlName(entry.name) && xml.length < MAX_LIBRARY_XML_FILES) xml.push(stampOf(path, kind.stats));
      }
    }
  };

  await visit(realRoot, "", 0);
  if (stopped()) logger.warn("musicLibrary.truncated", { maxFiles: MAX_LIBRARY_FILES });
  return { name: basename(realRoot) || "Music", files, xml, skipped, truncated: stopped() };
}

/** The real path of `path` inside the folder, when it is an audio or .xml file there; null otherwise. */
async function resolveLibraryFile(root: string, path: string): Promise<{ real: string; stats: Stats } | null> {
  const name = path.split("/").pop() ?? "";
  if (!isLibraryPath(path) || !(hasAudioExtension(name) || isXmlName(name))) return null;
  try {
    const realRoot = await realpath(root);
    const real = await realpath(join(realRoot, ...path.split("/")));
    if (!inside(realRoot, real)) return null;
    const stats = await stat(real);
    return stats.isFile() ? { real, stats } : null;
  } catch (error) {
    if (isMissing(error) || errorCode(error) === "EACCES") return null;
    throw error;
  }
}

const etagOf = (stats: Stats) => `"${stats.size.toString(36)}-${Math.trunc(stats.mtimeMs).toString(36)}"`;

/** One file, or a 304 when the browser already has this version of it. */
function sendFile(context: Context, real: string, stats: Stats, contentType: string): Response {
  const etag = etagOf(stats);
  const headers = { "content-type": contentType, "cache-control": "private, no-cache", etag, "last-modified": stats.mtime.toUTCString() };
  if (context.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return fileResponse(real, stats.size, context.req.header("range"), headers);
}

export function musicLibraryRoutes(options: MusicLibraryOptions): Hono {
  const { root, rekordboxXml, logger } = options;
  const now = options.now ?? Date.now;
  const routes = new Hono();
  let kept: { at: number; walked: Walked } | null = null;
  let walking: Promise<Walked> | null = null;

  const walk = (): Promise<Walked> => {
    if (root === null) throw new Error("walk() needs MUSIC_DIR.");
    if (walking !== null) return walking;
    if (kept !== null && now() - kept.at < INDEX_TTL_MS) return Promise.resolve(kept.walked);
    walking = walkLibrary(root, logger)
      .then((walked) => {
        kept = { at: now(), walked };
        return walked;
      })
      .finally(() => {
        walking = null;
      });
    return walking;
  };

  const rekordboxStamp = async (): Promise<{ size: number; lastModified: number } | null> => {
    if (rekordboxXml === null) return null;
    try {
      const stats = await stat(rekordboxXml);
      return stats.isFile() ? { size: stats.size, lastModified: Math.trunc(stats.mtimeMs) } : null;
    } catch (error) {
      logger.warn("musicLibrary.rekordboxUnreadable", { reason: errorCode(error) ?? String(error) });
      return null;
    }
  };

  routes.get("/", async (context) => {
    context.header("cache-control", "no-store");
    if (root === null) return context.json({ success: true, data: { configured: false } } satisfies ApiSuccess<MusicLibraryIndex>);
    let walked: Walked;
    try {
      walked = await walk();
    } catch (error) {
      const code = errorCode(error);
      if (code === null) throw error;
      logger.error("musicLibrary.unavailable", { root, code });
      return failure(
        context,
        503,
        "unavailable",
        `The server's music folder (MUSIC_DIR) cannot be read (${code}). Fix MUSIC_DIR in the server's .env, or make the folder readable, then restart the API.`,
      );
    }
    const index: MusicLibraryIndex = { configured: true, ...walked, rekordboxXml: await rekordboxStamp() };
    return context.json({ success: true, data: index } satisfies ApiSuccess<MusicLibraryIndex>);
  });

  routes.get("/file", async (context) => {
    const path = context.req.query("path") ?? "";
    if (root === null) return failure(context, 404, "notFound", "This server has no music library. Set MUSIC_DIR in its .env and restart it.");
    const found = await resolveLibraryFile(root, path);
    if (found === null) {
      return failure(context, 404, "notFound", "No such audio or .xml file in the server's music library. Rescan the library: it may have been moved or deleted.");
    }
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    return sendFile(context, found.real, found.stats, CONTENT_TYPES[extension] ?? "application/octet-stream");
  });

  routes.get("/rekordbox.xml", async (context) => {
    if (rekordboxXml === null) return failure(context, 404, "notFound", "This server has no REKORDBOX_XML. Set it in its .env, or save rekordbox.xml in the music folder.");
    let stats: Stats;
    try {
      stats = await stat(rekordboxXml);
    } catch (error) {
      if (!isMissing(error) && errorCode(error) !== "EACCES") throw error;
      return failure(context, 404, "notFound", "The server's REKORDBOX_XML cannot be read. Export the collection there again, or fix REKORDBOX_XML.");
    }
    if (!stats.isFile()) return failure(context, 404, "notFound", "The server's REKORDBOX_XML is not a file. Point it at rekordbox's exported .xml.");
    return sendFile(context, rekordboxXml, stats, "application/xml");
  });

  return routes;
}
