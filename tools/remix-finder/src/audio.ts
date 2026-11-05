/**
 * BPM and key of a search result, from a clip of its audio.
 *
 * The clip streams through ffmpeg straight into memory and is gone once measured: nothing is saved
 * but the numbers. A full track is measured from 60 s in, for 60 s (past the intro, into the body);
 * a Spotify preview is its whole 30 s. A DRM-protected track (most label uploads on SoundCloud) is
 * "unavailable", never worked around: the same variant on another platform may still be measured.
 *
 * BPM comes from the app's own analysis pipeline (Beat This! when the model is on disk, `npm run
 * fetch-models` at the repo root; the dj-core fallback, four-on-the-floor only, otherwise). Key from
 * key.ts.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analysePcm } from "../../../src/analysis/pipeline.ts";
import { BEAT_THIS_SMALL0, type ModelLoad } from "../../../src/analysis/model.ts";
import { loadNodeModel } from "../../../scripts/analysis/onnx-node-model.ts";
import { estimateKey, type KeyEstimate } from "./key.ts";
import { previewUrl } from "./spotify.ts";
import { runYtDlp, type SearchResult, type YtDlp } from "./search.ts";

export const ANALYSIS_VERSION = 1;

export type Analysis =
  | {
      readonly status: "ok";
      readonly version: number;
      readonly bpm: number;
      /** 0–1, from the pipeline. */
      readonly bpmConfidence: number;
      readonly bpmMethod: string;
      readonly key: KeyEstimate | null;
      readonly clip: { readonly startSec: number; readonly seconds: number; readonly source: "preview" | "stream" };
    }
  | { readonly status: "unavailable"; readonly version: number; readonly reason: string }
  | { readonly status: "error"; readonly version: number; readonly message: string };

const RATE = 22_050;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Stream = { readonly url: string; readonly source: "preview" | "stream" } | { readonly unavailable: string };

async function streamOf(result: SearchResult, ytDlp: YtDlp): Promise<Stream> {
  if (result.platform === "spotify") {
    const url = await previewUrl(result.id.slice("spotify:".length));
    return url === null ? { unavailable: "Spotify has no preview for this track" } : { url, source: "preview" };
  }
  const { stdout, stderr } = await runYtDlp(ytDlp, ["-f", "bestaudio/best", "--get-url", "--no-playlist", result.url]);
  const url = stdout.split("\n").find((line) => line.startsWith("http"));
  if (url !== undefined) return { url, source: "stream" };
  const error = stderr.trim().split("\n").at(-1) ?? "no stream URL";
  if (/DRM/i.test(error)) return { unavailable: "DRM-protected: no clip can be measured" };
  if (/private|unavailable|removed|not available|Sign in|age/i.test(error)) return { unavailable: error.replace(/^ERROR:\s*/, "") };
  throw new Error(error);
}

function decodeClip(url: string, startSec: number, seconds: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", ...(startSec > 0 ? ["-ss", String(startSec)] : []), "-t", String(seconds), "-i", url, "-vn", "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"];
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let errors = "";
    const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), 90_000);
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ffmpeg (${error.message}). Install it (sudo apt install ffmpeg).`));
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${String(code)}: ${errors.trim().slice(0, 300)}`));
        return;
      }
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4)).slice());
    });
  });
}

/** Where in the track to listen: 60 s from 60 s in, or the start of anything short. */
export function clipWindow(durationSec: number | null, source: "preview" | "stream"): { startSec: number; seconds: number } {
  if (source === "preview") return { startSec: 0, seconds: 30 };
  if (durationSec === null || durationSec >= 150) return { startSec: 60, seconds: 60 };
  if (durationSec >= 60) return { startSec: Math.round(durationSec / 4), seconds: Math.min(60, Math.round(durationSec / 2)) };
  return { startSec: 0, seconds: Math.max(10, Math.round(durationSec)) };
}

export function analyser(ytDlp: YtDlp) {
  let model: Promise<ModelLoad> | null = null;
  const loadModel = () => (model ??= loadNodeModel(join(REPO_ROOT, "public/models", BEAT_THIS_SMALL0.file), 2));

  return async function analyse(result: SearchResult): Promise<Analysis> {
    try {
      const stream = await streamOf(result, ytDlp);
      if ("unavailable" in stream) return { status: "unavailable", version: ANALYSIS_VERSION, reason: stream.unavailable };
      const window = clipWindow(result.durationSec, stream.source);
      const mono = await decodeClip(stream.url, window.startSec, window.seconds);
      if (mono.length < RATE * 8) return { status: "unavailable", version: ANALYSIS_VERSION, reason: `the clip was only ${(mono.length / RATE).toFixed(1)} s long` };
      const outcome = await analysePcm({ channels: [mono], sampleRate: RATE }, { method: "auto", loadModel });
      if (!outcome.ok) return { status: "error", version: ANALYSIS_VERSION, message: `no BPM: ${outcome.error.kind}` };
      return {
        status: "ok",
        version: ANALYSIS_VERSION,
        bpm: Math.round(outcome.analysis.bpm * 10) / 10,
        bpmConfidence: Math.round(outcome.analysis.confidence * 100) / 100,
        bpmMethod: outcome.analysis.method,
        key: estimateKey(mono, RATE),
        clip: { ...window, seconds: Math.round(mono.length / RATE), source: stream.source },
      };
    } catch (error) {
      return { status: "error", version: ANALYSIS_VERSION, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
export type Analyse = ReturnType<typeof analyser>;
