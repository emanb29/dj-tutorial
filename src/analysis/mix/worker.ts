// The mix-grading Web Worker: one mix per worker. The client terminates it afterwards, which gives
// back the model's WASM heap (as for track analysis, ../worker.ts).

import { chooseThreadCount } from "../model.ts";
import { loadWebModel } from "../onnx-web.ts";
import { gradeMixPcm } from "./grade.ts";
import type { GradeMixRequest, MixWorkerMessage } from "./protocol.ts";

/** The parts of DedicatedWorkerGlobalScope used here (the app's lib is DOM, not WebWorker). */
interface WorkerScope {
  readonly crossOriginIsolated: boolean;
  readonly navigator: { readonly hardwareConcurrency: number };
  onmessage: ((event: MessageEvent<GradeMixRequest>) => void) | null;
  postMessage(message: MixWorkerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

async function handle(request: GradeMixRequest): Promise<void> {
  const { threads, warning } = chooseThreadCount({
    crossOriginIsolated: scope.crossOriginIsolated,
    hardwareConcurrency: scope.navigator.hardwareConcurrency,
  });
  if (warning && request.method !== "dj-core") console.warn(`[mix] ${warning.message}`);
  const outcome = await gradeMixPcm(
    { channels: request.channels, sampleRate: request.sampleRate },
    {
      method: request.method,
      loadModel: () => loadWebModel(request.modelUrl, threads),
      onProgress: (progress) => {
        scope.postMessage({ type: "progress", progress });
      },
    },
  );
  scope.postMessage({ type: "done", outcome });
}

scope.onmessage = (event) => {
  handle(event.data).catch((error: unknown) => {
    // A bug, not an expected failure: report it with its stack so it can be debugged.
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    console.error("[mix] worker failed", error);
    scope.postMessage({ type: "done", outcome: { ok: false, error: { kind: "worker-crashed", message } } });
  });
};
