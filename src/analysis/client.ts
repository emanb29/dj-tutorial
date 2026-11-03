// analyseTrack: the main-thread entry point. Checks the cache, runs one worker per analysis, relays
// progress, stores the result, and always terminates the worker.

import { analysisCacheKey, hashDecodedAudio, type AnalysisCache } from "./cache.ts";
import { DEFAULT_MODEL_URL } from "./model.ts";
import type { AnalyseRequest, WorkerMessage } from "./protocol.ts";
import type { AnalysisOutcome, AnalysisProgress, DecodedAudio, MethodPreference, TrackAnalysis } from "./types.ts";

export interface AnalyseOptions {
  /** Default "auto": Beat This!, falling back to the dj-core port only when the model cannot run. */
  readonly method?: MethodPreference;
  readonly modelUrl?: string;
  readonly onProgress?: (progress: AnalysisProgress) => void;
  /** Aborting terminates the worker and resolves with { kind: "aborted" }. */
  readonly signal?: AbortSignal;
  readonly cache?: AnalysisCache;
  /** Cache key; prefer hashTrackBytes(file bytes, duration). Defaults to hashDecodedAudio(audio). */
  readonly contentHash?: string;
}

const ABORTED: AnalysisOutcome = { ok: false, error: { kind: "aborted" } };

/** A fallback caused by a missing or broken model is not cached, so installing the model fixes it. */
const worthCaching = (analysis: TrackAnalysis) =>
  !analysis.warnings.some((w) => w.kind === "model-missing" || w.kind === "model-failed");

/** The cache is an optimisation: when it fails (private mode, quota), analyse anyway. */
async function cached(cache: AnalysisCache, key: string): Promise<TrackAnalysis | null> {
  try {
    return await cache.get(key);
  } catch (error) {
    console.warn("[analysis] cache read failed; analysing again", error);
    return null;
  }
}

async function store(cache: AnalysisCache, key: string, analysis: TrackAnalysis): Promise<void> {
  try {
    await cache.put(key, analysis);
  } catch (error) {
    console.warn("[analysis] cache write failed; the result is not cached", error);
  }
}

export async function analyseTrack(audio: DecodedAudio, options: AnalyseOptions = {}): Promise<AnalysisOutcome> {
  const { cache, signal } = options;
  const method = options.method ?? "auto";
  if (signal?.aborted) return ABORTED;
  // The method is part of the key: a dj-core result must not answer a request for Beat This!.
  const key = cache ? analysisCacheKey(options.contentHash ?? (await hashDecodedAudio(audio)), method) : null;
  if (cache && key !== null) {
    const hit = await cached(cache, key);
    if (signal?.aborted) return ABORTED;
    if (hit) return { ok: true, analysis: hit, fromCache: true };
  }
  const outcome = await runWorker(audio, method, options);
  if (outcome.ok && cache && key !== null && worthCaching(outcome.analysis)) await store(cache, key, outcome.analysis);
  return outcome;
}

function runWorker(audio: DecodedAudio, method: MethodPreference, options: AnalyseOptions): Promise<AnalysisOutcome> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(ABORTED);
  // Copy, so the caller's buffers (which a deck may still be playing from) are not detached.
  const channels = audio.channels.map((channel) => channel.slice());
  const request: AnalyseRequest = {
    type: "analyse",
    channels,
    sampleRate: audio.sampleRate,
    method,
    modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
  };
  return new Promise<AnalysisOutcome>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "track-analysis" });
    } catch (error) {
      resolve({ ok: false, error: { kind: "worker-crashed", message: `Could not start the analysis worker: ${String(error)}` } });
      return;
    }
    const finish = (outcome: AnalysisOutcome) => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const abort = () => {
      finish(ABORTED);
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") options.onProgress?.(message.progress);
      else finish(message.outcome.ok ? { ...message.outcome, fromCache: false } : message.outcome);
    };
    worker.onmessageerror = () => {
      finish({ ok: false, error: { kind: "worker-crashed", message: "A message from the analysis worker could not be read." } });
    };
    worker.onerror = (event) => {
      finish({ ok: false, error: { kind: "worker-crashed", message: event.message || "The analysis worker failed to start." } });
    };
    worker.postMessage(
      request,
      channels.map((channel) => channel.buffer),
    );
  });
}
