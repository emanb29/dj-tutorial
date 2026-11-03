// Transcodes the kept final project (a MediaRecorder WebM/Ogg/MP4 file) to WAV or 320 kbit/s MP3 with
// ffmpeg, for posting to SoundCloud (which does not take WebM), and a Mix Plan's Render (raw 16-bit
// PCM, server/renders.ts) to MP3. Safety: ffmpeg is spawned with an
// argument array (no shell), reads only the stored file's path, writes to a private temp file that is
// unlinked as soon as it is opened for streaming, is killed after a time limit, and stops at a size cap.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ExportFormat, ExportStatus, ExportTags } from "@shared/final-project-export.ts";

export const EXPORT_TIMEOUT_MS = 120_000;
/** 40 minutes (past the 48 MB recording cap) of 48 kHz stereo 16-bit PCM is ~460 MB. */
export const MAX_EXPORT_BYTES: Readonly<Record<ExportFormat, number>> = { wav: 512 * 1024 * 1024, mp3: 128 * 1024 * 1024 };
const DETECT_TIMEOUT_MS = 10_000;

export type ExportFailure =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "timedOut"; readonly message: string }
  | { readonly kind: "tooLarge"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface TranscodeOptions {
  /** The input is raw 16-bit little-endian stereo PCM at this rate (a Render), not a file ffmpeg recognises itself. */
  readonly rawPcm?: { readonly sampleRate: number };
  /** Defaults to the exporter's timeout. */
  readonly timeoutMs?: number;
  /** Defaults to MAX_EXPORT_BYTES for the format. */
  readonly maxBytes?: number;
}

export type ExportResult = { readonly ok: true; readonly bytes: number; readonly body: ReadableStream<Uint8Array> } | { readonly ok: false; readonly failure: ExportFailure };

const CODEC_ARGS: Readonly<Record<ExportFormat, readonly string[]>> = {
  // libmp3lame with -b:a is constant bit rate; ID3v2.3 is what most tag readers (and SoundCloud) read.
  mp3: ["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3", "-write_id3v1", "1", "-f", "mp3"],
  wav: ["-c:a", "pcm_s16le", "-f", "wav"],
};

interface RunOutcome {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly spawnError: Error | null;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let spawnError: Error | null = null;
    // Keep only the tail: ffmpeg's last lines say why it failed.
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-200_000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => (spawnError = error));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, spawnError, stderr: stderr + stdout });
    });
  });
}

export class AudioExporter {
  private constructor(
    private readonly ffmpeg: string,
    readonly status: ExportStatus,
    private readonly timeoutMs: number,
  ) {}

  /** Checks once, at startup, that `ffmpeg` runs and has the MP3 encoder. */
  static async detect(ffmpeg = "ffmpeg", timeoutMs = EXPORT_TIMEOUT_MS): Promise<AudioExporter> {
    const outcome = await run(ffmpeg, ["-hide_banner", "-encoders"], DETECT_TIMEOUT_MS);
    let status: ExportStatus;
    if (outcome.spawnError !== null || outcome.code !== 0) {
      status = { available: false, reason: "ffmpeg is not installed on the server, so the set cannot be turned into WAV or MP3. Install ffmpeg (e.g. `sudo apt install ffmpeg`) and restart the API." };
    } else if (!outcome.stderr.includes("libmp3lame")) {
      status = { available: false, reason: "The server's ffmpeg has no MP3 encoder (libmp3lame). Install a full ffmpeg build and restart the API." };
    } else {
      status = { available: true };
    }
    return new AudioExporter(ffmpeg, status, timeoutMs);
  }

  /** Transcodes `inputPath` (a file the server wrote; never a path from a request) to `format` with `tags`. */
  async transcode(inputPath: string, format: ExportFormat, tags: ExportTags, options: TranscodeOptions = {}): Promise<ExportResult> {
    if (!this.status.available) return { ok: false, failure: { kind: "unavailable", message: this.status.reason } };
    // A Render gets its own prefix, so a final project export and a Render export never share one.
    const directory = await mkdtemp(join(tmpdir(), options.rawPcm === undefined ? "ltd-export-" : "ltd-render-export-"));
    const output = join(directory, `set.${format}`);
    try {
      const maxBytes = options.maxBytes ?? MAX_EXPORT_BYTES[format];
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const input = options.rawPcm === undefined ? [] : ["-f", "s16le", "-ar", String(options.rawPcm.sampleRate), "-ac", "2"];
      const metadata = (["title", "artist", "comment", "date"] as const).flatMap((key) => (tags[key] === "" ? [] : ["-metadata", `${key}=${tags[key]}`]));
      const args = ["-hide_banner", "-nostdin", "-loglevel", "error", ...input, "-i", inputPath, "-vn", "-map_metadata", "-1", ...metadata, ...CODEC_ARGS[format], "-fs", String(maxBytes), "-y", output];
      const outcome = await run(this.ffmpeg, args, timeoutMs);
      if (outcome.timedOut) {
        return { ok: false, failure: { kind: "timedOut", message: `Converting the set took over ${String(Math.round(timeoutMs / 1000))} s and was stopped. Try again; if it keeps happening, record a shorter set.` } };
      }
      if (outcome.spawnError !== null || outcome.code !== 0) {
        return { ok: false, failure: { kind: "failed", message: `ffmpeg could not convert the set (${outcome.stderr.trim().split("\n").at(-1) ?? "no message"}). Keep the set again, then retry; the server log has details.` } };
      }
      const { size } = await stat(output);
      if (size >= maxBytes) {
        return { ok: false, failure: { kind: "tooLarge", message: `The ${format.toUpperCase()} would be over ${String(maxBytes / 1024 / 1024)} MB. Record a shorter set, or try the MP3.` } };
      }
      // Open, then unlink: the stream keeps the data until it closes, and nothing is left behind.
      const handle = await open(output, "r");
      await rm(directory, { recursive: true, force: true });
      const stream = createReadStream("", { fd: handle, autoClose: true });
      return { ok: true, bytes: size, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
