// Sending a file from disk with single byte ranges: the Originals' audio and the music library's files.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

type ByteRange = { readonly start: number; readonly end: number } | "unsatisfiable" | null;

/** Parses a single `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Multiple ranges get the whole file. */
export function parseRange(header: string | undefined, size: number): ByteRange {
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

/** The file at `path` (`size` bytes), whole (200) or the one range asked for (206, or 416). */
export function fileResponse(path: string, size: number, rangeHeader: string | undefined, extraHeaders: Readonly<Record<string, string>>): Response {
  const headers: Record<string, string> = { ...extraHeaders, "accept-ranges": "bytes" };
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, "content-length": "0" } });
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${String(size)}` } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
  headers["content-length"] = String(end - start + 1);
  if (range === null) return new Response(body, { status: 200, headers });
  headers["content-range"] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
  return new Response(body, { status: 206, headers });
}
