// The Mix Editor's Renders (ISS-190; shared/mix-render.ts): the browser uploads a Render as 16-bit
// stereo PCM, one segment at a time and in order, and the server keeps it in one file per Render
// until it is downloaded as WAV (the PCM behind a header, streamed) or MP3 (ffmpeg), or dropped.
//
// Bounded: at most MAX_RENDERS kept at once, each at most MAX_RENDER_SEC long (declared up front, so
// an upload can never grow past it), a segment at most MAX_RENDER_SEGMENT_BYTES, a Render idle for
// RENDER_IDLE_MS dropped, starts and downloads rate-limited, and the folder emptied at startup.
// Only the Render's own output is ever here: no track file is uploaded.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import type { ApiErrorCode, ApiFailure, ApiSuccess } from "@shared";
import { describeIssues } from "@shared/learner.ts";
import {
  MAX_RENDER_SEC,
  RENDER_BYTES_PER_FRAME,
  RENDER_EXPORT_MAX_BYTES,
  renderFileName,
  renderFormats,
  RenderStartSchema,
  renderTags,
  wavHeader,
  type RenderSession,
  type RenderStart,
} from "@shared/mix-render.ts";
import type { ExportFormat } from "@shared/final-project-export.ts";
import type { AudioExporter } from "./audio-export.ts";
import { SerialQueue } from "./json-file.ts";
import type { Logger } from "./logger.ts";
import { RateLimiter, type BucketRule } from "./rate-limiter.ts";

export const RENDERS_DIR = "renders";
/** Renders kept at once: two 3-hour Renders are about 3.8 GB of disk at 44.1 kHz. */
export const MAX_RENDERS = 2;
export const RENDER_IDLE_MS = 60 * 60_000;
/** Starting a Render: 4 at once, then 20 an hour. */
export const RENDER_START_RATE_RULE: BucketRule = { burst: 4, perWindow: 20, windowMs: 60 * 60_000 };
/** MP3s of one Render: 6 at once, then 30 an hour (each runs ffmpeg over the whole set). The WAV is a plain file read, and is not limited. */
export const RENDER_EXPORT_RATE_RULE: BucketRule = { burst: 6, perWindow: 30, windowMs: 60 * 60_000 };
/** ffmpeg gets this long per second of set to make the MP3 (libmp3lame runs far faster), and never under 2 minutes. */
const MP3_SEC_PER_SET_SEC = 1 / 20;
const MIN_MP3_TIMEOUT_MS = 120_000;

interface Kept {
  readonly id: string;
  readonly start: RenderStart;
  readonly path: string;
  receivedFrames: number;
  nextIndex: number;
  touchedAtMs: number;
  readonly writes: SerialQueue;
}

export type AppendFailure =
  | { readonly kind: "notFound" }
  | { readonly kind: "outOfOrder"; readonly expected: number }
  | { readonly kind: "misaligned" }
  | { readonly kind: "tooLong"; readonly frames: number };

export class RenderStore {
  private readonly renders = new Map<string, Kept>();

  private constructor(
    private readonly directory: string,
    private readonly nowMs: () => number,
  ) {}

  /** Opens the store in `dataDir`, dropping whatever an earlier run left (an unfinished upload cannot be resumed). */
  static async open(dataDir: string, nowMs: () => number = Date.now): Promise<RenderStore> {
    const directory = join(dataDir, RENDERS_DIR);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    return new RenderStore(directory, nowMs);
  }

  /** Starts a Render, dropping idle ones first; null when MAX_RENDERS are still in use. */
  async create(start: RenderStart): Promise<Kept | null> {
    const now = this.nowMs();
    for (const kept of [...this.renders.values()].filter((each) => now - each.touchedAtMs > RENDER_IDLE_MS)) await this.delete(kept.id);
    if (this.renders.size >= MAX_RENDERS) {
      // Make room by dropping the longest-idle finished one; an upload still under way is kept.
      const finished = [...this.renders.values()].filter((each) => each.receivedFrames === each.start.frames).sort((a, b) => a.touchedAtMs - b.touchedAtMs)[0];
      if (finished === undefined) return null;
      await this.delete(finished.id);
    }
    const id = randomUUID();
    const path = join(this.directory, `${id}.pcm`);
    await writeFile(path, new Uint8Array(0), { mode: 0o600 });
    const kept: Kept = { id, start, path, receivedFrames: 0, nextIndex: 0, touchedAtMs: now, writes: new SerialQueue() };
    this.renders.set(id, kept);
    return kept;
  }

  get(id: string): Kept | undefined {
    const kept = this.renders.get(id);
    if (kept !== undefined) kept.touchedAtMs = this.nowMs();
    return kept;
  }

  /** Adds segment `index` (the next one) of 16-bit stereo PCM. */
  append(id: string, index: number, bytes: Uint8Array): Promise<{ readonly ok: true; readonly kept: Kept } | { readonly ok: false; readonly failure: AppendFailure }> {
    const kept = this.get(id);
    if (kept === undefined) return Promise.resolve({ ok: false, failure: { kind: "notFound" } });
    return kept.writes.run(async () => {
      if (index !== kept.nextIndex) return { ok: false, failure: { kind: "outOfOrder", expected: kept.nextIndex } };
      if (bytes.byteLength % RENDER_BYTES_PER_FRAME !== 0) return { ok: false, failure: { kind: "misaligned" } };
      const frames = bytes.byteLength / RENDER_BYTES_PER_FRAME;
      if (kept.receivedFrames + frames > kept.start.frames) return { ok: false, failure: { kind: "tooLong", frames: kept.start.frames } };
      await appendFile(kept.path, bytes);
      kept.receivedFrames += frames;
      kept.nextIndex++;
      return { ok: true, kept };
    });
  }

  async delete(id: string): Promise<boolean> {
    const kept = this.renders.get(id);
    if (kept === undefined) return false;
    this.renders.delete(id);
    await kept.writes.run(() => rm(kept.path, { force: true }));
    return true;
  }
}

type Status = 400 | 404 | 409 | 413 | 415 | 429 | 500 | 503 | 504;

function failure(context: Context, status: Status, code: ApiErrorCode, error: string, issues?: readonly string[]) {
  const body: ApiFailure = issues === undefined ? { success: false, error, code } : { success: false, error, code, issues };
  return context.json(body, status);
}

export interface RenderRouteDeps {
  readonly store: RenderStore;
  readonly exporter?: AudioExporter;
  readonly logger: Logger;
  readonly now: () => Date;
}

const UNAVAILABLE = "The server was started without the audio export. Restart it with `npm run dev`.";
const EXPORT_FAILURE_STATUS = { unavailable: 503, timedOut: 504, tooLarge: 413, failed: 500 } as const;

function sessionOf(kept: Kept, exporter: AudioExporter | undefined): RenderSession {
  const mp3 = exporter?.status ?? { available: false as const, reason: UNAVAILABLE };
  return {
    id: kept.id,
    frames: kept.start.frames,
    sampleRate: kept.start.sampleRate,
    receivedFrames: kept.receivedFrames,
    complete: kept.receivedFrames === kept.start.frames,
    formats: renderFormats(kept.start.frames, kept.start.sampleRate, mp3),
  };
}

/**
 * The WAV: the header, then the kept PCM, streamed from disk. One byte range is served (206) so a
 * player can seek in a long set; anything else gets the whole file.
 */
async function wavResponse(context: Context, kept: Kept, headers: Record<string, string>): Promise<Response> {
  const { size } = await stat(kept.path);
  const header = wavHeader(size / RENDER_BYTES_PER_FRAME, kept.start.sampleRate);
  const total = header.byteLength + size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(context.req.header("range") ?? "");
  let from = 0;
  let to = total - 1;
  if (range !== null) {
    const [, first = "", last = ""] = range;
    if (first === "" && last !== "") from = Math.max(0, total - Number(last));
    else {
      from = Number(first);
      if (last !== "") to = Math.min(total - 1, Number(last));
    }
    if (from > to || from >= total) return context.body(null, 416, { "Content-Range": `bytes */${String(total)}` });
  }
  const path = kept.path;
  const body = Readable.from(
    (async function* () {
      if (from < header.byteLength) yield header.subarray(from, Math.min(header.byteLength, to + 1));
      if (to >= header.byteLength) yield* createReadStream(path, { start: Math.max(0, from - header.byteLength), end: to - header.byteLength });
    })(),
  );
  const common = { ...headers, "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": String(to - from + 1) };
  return range === null
    ? context.body(Readable.toWeb(body) as ReadableStream<Uint8Array>, 200, common)
    : context.body(Readable.toWeb(body) as ReadableStream<Uint8Array>, 206, { ...common, "Content-Range": `bytes ${String(from)}-${String(to)}/${String(total)}` });
}

/** The routes under RENDERS_PATH. Same-origin and body-size checks are the app's (server/app.ts). */
export function renderRoutes(deps: RenderRouteDeps): Hono {
  const { store, exporter, logger, now } = deps;
  const routes = new Hono();
  const limiter = new RateLimiter(() => now().getTime());

  routes.post("/", async (context) => {
    if (!/^application\/json\b/i.test(context.req.header("content-type") ?? "")) return failure(context, 415, "badRequest", "Send the body as JSON, with Content-Type: application/json.");
    let json: unknown;
    try {
      json = await context.req.json();
    } catch {
      return failure(context, 400, "badRequest", "The body is not valid JSON.");
    }
    const parsed = RenderStartSchema.safeParse(json);
    if (!parsed.success) {
      const issues = describeIssues(parsed.error);
      return failure(context, 400, "badRequest", `The body has ${String(issues.length)} problem(s); see issues.`, issues);
    }
    const start = parsed.data;
    if (start.frames / start.sampleRate > MAX_RENDER_SEC) {
      return failure(context, 413, "tooLarge", `The set is over ${String(MAX_RENDER_SEC / 3600)} hours, the longest Render the server keeps. Split it into two plans.`);
    }
    if (!limiter.tryTake("start", RENDER_START_RATE_RULE)) return failure(context, 429, "rateLimited", "Too many Renders started in the last hour. Wait a few minutes, then render again.");
    const kept = await store.create(start);
    if (kept === null) return failure(context, 429, "rateLimited", `${String(MAX_RENDERS)} Renders are already uploading. Let one finish, or cancel it, then render again.`);
    return context.json({ success: true, data: sessionOf(kept, exporter) } satisfies ApiSuccess<RenderSession>);
  });

  routes.get("/:id", (context) => {
    const kept = store.get(context.req.param("id"));
    if (kept === undefined) return failure(context, 404, "notFound", "No such Render on the server (it was dropped after an hour idle, or the server restarted). Render the plan again.");
    return context.json({ success: true, data: sessionOf(kept, exporter) } satisfies ApiSuccess<RenderSession>);
  });

  routes.put("/:id/segments/:index", async (context) => {
    const mimeType = (context.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (mimeType !== "application/octet-stream") return failure(context, 415, "badRequest", `Send the segment as application/octet-stream (16-bit stereo PCM); got "${mimeType}".`);
    const index = Number(context.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return failure(context, 400, "badRequest", "The segment index must be a whole number from 0.");
    const result = await store.append(context.req.param("id"), index, new Uint8Array(await context.req.arrayBuffer()));
    if (result.ok) return context.json({ success: true, data: sessionOf(result.kept, exporter) } satisfies ApiSuccess<RenderSession>);
    switch (result.failure.kind) {
      case "notFound":
        return failure(context, 404, "notFound", "No such Render on the server (it was dropped after an hour idle, or the server restarted). Render the plan again.");
      case "outOfOrder":
        return failure(context, 409, "badRequest", `Segment ${String(index)} came out of order; the server expects segment ${String(result.failure.expected)}. Render the plan again.`);
      case "misaligned":
        return failure(context, 400, "badRequest", "A segment must be whole frames of 16-bit stereo PCM (a multiple of 4 bytes).");
      case "tooLong":
        return failure(context, 413, "tooLarge", `The Render was started as ${String(result.failure.frames)} frames; this segment goes past that. Render the plan again.`);
    }
  });

  routes.delete("/:id", async (context) => {
    const dropped = await store.delete(context.req.param("id"));
    return dropped ? context.json({ success: true, data: { dropped: true } }) : failure(context, 404, "notFound", "No such Render on the server.");
  });

  const exportRoute = (format: ExportFormat) => async (context: Context) => {
    const kept = store.get(context.req.param("id") ?? "");
    if (kept === undefined) return failure(context, 404, "notFound", "No such Render on the server (it was dropped after an hour idle, or the server restarted). Render the plan again.");
    const session = sessionOf(kept, exporter);
    if (!session.complete) return failure(context, 409, "badRequest", "The Render is still uploading. Download it once it has finished.");
    const availability = session.formats[format];
    if (!availability.available) return failure(context, format === "mp3" && exporter?.status.available !== true ? 503 : 413, format === "mp3" && exporter?.status.available !== true ? "unavailable" : "tooLarge", availability.reason);
    const headers = { "Content-Disposition": `attachment; filename="${renderFileName(kept.start.name, format)}"`, "Cache-Control": "no-store" };
    if (format === "wav") return wavResponse(context, kept, headers);
    if (!limiter.tryTake(`export:${kept.id}`, RENDER_EXPORT_RATE_RULE)) return failure(context, 429, "rateLimited", "Too many MP3s of this Render in the last hour. Use the file you already downloaded, or wait a few minutes.");
    if (exporter === undefined) return failure(context, 503, "unavailable", UNAVAILABLE);
    const setSec = kept.start.frames / kept.start.sampleRate;
    const result = await exporter.transcode(kept.path, "mp3", renderTags(kept.start, now().toISOString().slice(0, 10)), {
      rawPcm: { sampleRate: kept.start.sampleRate },
      timeoutMs: Math.max(MIN_MP3_TIMEOUT_MS, setSec * MP3_SEC_PER_SET_SEC * 1000),
      maxBytes: RENDER_EXPORT_MAX_BYTES.mp3,
    });
    if (!result.ok) {
      logger.warn("render.export.failed", { id: kept.id, format, kind: result.failure.kind, message: result.failure.message });
      return failure(context, EXPORT_FAILURE_STATUS[result.failure.kind], result.failure.kind === "tooLarge" ? "tooLarge" : "unavailable", result.failure.message);
    }
    return context.body(result.body, 200, { ...headers, "Content-Type": "audio/mpeg", "Content-Length": String(result.bytes) });
  };
  routes.get("/:id/export.wav", exportRoute("wav"));
  routes.get("/:id/export.mp3", exportRoute("mp3"));

  return routes;
}
