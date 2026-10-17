/**
 * `/api/originals`: serves the generator's Originals (contract in shared/originals.ts) to the app.
 *
 * - `GET /api/originals` lists index.jsonl entries (bad lines are skipped with a WARN log).
 * - `GET /api/originals/:id/audio` streams the track's track.mp3, with single byte ranges.
 * - `GET /api/originals/:id/meta` returns its meta.json, including the exact grid and phrases.
 *
 * Path safety: an id must match OriginalIdSchema and be in the index. Its folder is the last
 * segment of the index line's `path` (or the id), it must be a plain name, and its real path
 * (after symlinks) must be inside the originals directory's real path. Anything else is a 404.
 * The routes sit under `/api/*`, so the same-origin guard in app.ts applies to them.
 */
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import type { ApiFailure, ApiSuccess } from "@shared";
import { describeIssues } from "@shared/learner.ts";
import {
  OriginalIdSchema,
  OriginalIndexLineSchema,
  OriginalMetaSchema,
  OriginalSummarySchema,
  type OriginalMeta,
  type OriginalSummary,
} from "@shared/originals.ts";
import type { Logger } from "./logger.ts";

const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface IndexEntry {
  readonly summary: OriginalSummary;
  readonly folder: string;
}

function failure(context: Context, status: 400 | 404 | 500, code: ApiFailure["code"], error: string, issues?: readonly string[]) {
  const body: ApiFailure = { success: false, error, ...(code === undefined ? {} : { code }), ...(issues === undefined ? {} : { issues }) };
  return context.json(body, status);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function readIndex(root: string, logger: Logger): Promise<IndexEntry[]> {
  let text: string;
  try {
    text = await readFile(join(root, "index.jsonl"), "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return text.split("\n").flatMap((line, lineIndex): IndexEntry[] => {
    if (line.trim() === "") return [];
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      logger.warn("originals.badIndexLine", { line: lineIndex + 1, problems: ["not valid JSON"] });
      return [];
    }
    const parsed = OriginalIndexLineSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("originals.badIndexLine", { line: lineIndex + 1, problems: describeIssues(parsed.error) });
      return [];
    }
    const folder = parsed.data.path === undefined ? parsed.data.id : basename(parsed.data.path);
    return [{ summary: OriginalSummarySchema.parse(parsed.data), folder }];
  });
}

/** The real path of `folder/file` inside `root`, or null when it is missing or escapes `root`. */
async function resolveInside(root: string, folder: string, file: string): Promise<string | null> {
  if (!SAFE_FOLDER.test(folder) || folder.includes("..")) return null;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(join(root, folder, file));
    return realFile.startsWith(realRoot + sep) ? realFile : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

type ByteRange = { readonly start: number; readonly end: number } | "unsatisfiable" | null;

/** Parses a single `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Multiple ranges get the whole file. */
function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (from === "") {
    const length = Number(to);
    return length === 0 ? "unsatisfiable" : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  // An invalid range (end before start) is ignored, per RFC 9110 §14.2: the whole file is sent.
  if (to !== "" && Number(to) < start) return null;
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return start >= size ? "unsatisfiable" : { start, end };
}

export function originalsRoutes(root: string, logger: Logger): Hono {
  const routes = new Hono();

  /** Looks the id up in the index and resolves its file, or answers the failure. */
  async function locate(context: Context, file: string): Promise<{ path: string } | { response: Response }> {
    const id = OriginalIdSchema.safeParse(context.req.param("id"));
    if (!id.success) {
      return { response: failure(context, 400, "badRequest", "Invalid Original id.", describeIssues(id.error)) };
    }
    const entry = (await readIndex(root, logger)).find((candidate) => candidate.summary.id === id.data);
    const path = entry === undefined ? null : await resolveInside(root, entry.folder, file);
    if (path === null) {
      return {
        response: failure(context, 404, "notFound", `No Original "${id.data}" with a ${file}. GET /api/originals lists the ones there are.`),
      };
    }
    return { path };
  }

  routes.get("/", async (context) =>
    context.json({ success: true, data: (await readIndex(root, logger)).map((entry) => entry.summary) } satisfies ApiSuccess<
      OriginalSummary[]
    >),
  );

  routes.get("/:id/meta", async (context) => {
    const located = await locate(context, "meta.json");
    if ("response" in located) return located.response;
    let json: unknown;
    try {
      json = JSON.parse(await readFile(located.path, "utf8"));
    } catch {
      json = undefined;
    }
    const parsed = OriginalMetaSchema.safeParse(json);
    if (!parsed.success) {
      logger.error("originals.badMeta", { id: context.req.param("id"), problems: describeIssues(parsed.error) });
      return failure(
        context,
        500,
        "internal",
        "This Original's meta.json is not valid JSON or does not match the contract in shared/originals.ts. Regenerate the track.",
        describeIssues(parsed.error),
      );
    }
    return context.json({ success: true, data: parsed.data } satisfies ApiSuccess<OriginalMeta>);
  });

  routes.get("/:id/audio", async (context) => {
    const located = await locate(context, "track.mp3");
    if ("response" in located) return located.response;
    let size: number;
    try {
      ({ size } = await stat(located.path));
    } catch (error) {
      // Deleted between the lookup and now (e.g. while the generator rewrites it).
      if (isMissing(error)) return failure(context, 404, "notFound", "This Original's track.mp3 just disappeared. Try again.");
      throw error;
    }
    const headers: Record<string, string> = {
      "content-type": "audio/mpeg",
      "accept-ranges": "bytes",
      "cache-control": "private, no-cache",
    };
    if (size === 0) return new Response(null, { status: 200, headers: { ...headers, "content-length": "0" } });
    const range = parseRange(context.req.header("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${String(size)}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(createReadStream(located.path, { start, end })) as ReadableStream<Uint8Array>;
    headers["content-length"] = String(end - start + 1);
    if (range === null) return new Response(body, { status: 200, headers });
    headers["content-range"] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
    return new Response(body, { status: 206, headers });
  });

  return routes;
}
