// gradeMix: the main-thread entry point. Runs one worker per mix, relays progress, and always
// terminates the worker.

import { DEFAULT_MODEL_URL } from "../model.ts";
import type { DecodedAudio } from "../types.ts";
import type { GradeMixRequest, MixWorkerMessage } from "./protocol.ts";
import type { MethodPreference, MixOutcome, MixProgress } from "./types.ts";

export interface GradeMixOptions {
  /** Default "auto": Beat This!, falling back to the dj-core port only when the model cannot run. */
  readonly method?: MethodPreference;
  readonly modelUrl?: string;
  readonly onProgress?: (progress: MixProgress) => void;
  /** Aborting terminates the worker and resolves with { kind: "aborted" }. */
  readonly signal?: AbortSignal;
}

const ABORTED: MixOutcome = { ok: false, error: { kind: "aborted" } };

/**
 * Grades a decoded mix in a worker. The channels are transferred, not copied (a mix can be hundreds
 * of MB): the caller's arrays are detached afterwards, so pass copies of anything still in use.
 */
export function gradeMix(audio: DecodedAudio, options: GradeMixOptions = {}): Promise<MixOutcome> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(ABORTED);
  const channels = [...audio.channels];
  const request: GradeMixRequest = {
    type: "grade-mix",
    channels,
    sampleRate: audio.sampleRate,
    method: options.method ?? "auto",
    modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
  };
  return new Promise<MixOutcome>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "mix-grading" });
    } catch (error) {
      resolve({ ok: false, error: { kind: "worker-crashed", message: `Could not start the mix worker: ${String(error)}` } });
      return;
    }
    const finish = (outcome: MixOutcome) => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const abort = () => {
      finish(ABORTED);
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<MixWorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") options.onProgress?.(message.progress);
      else finish(message.outcome);
    };
    worker.onmessageerror = () => {
      finish({ ok: false, error: { kind: "worker-crashed", message: "A message from the mix worker could not be read." } });
    };
    worker.onerror = (event) => {
      finish({ ok: false, error: { kind: "worker-crashed", message: event.message || "The mix worker failed to start." } });
    };
    worker.postMessage(
      request,
      [...new Set(channels.map((channel) => channel.buffer))],
    );
  });
}
