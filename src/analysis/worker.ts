// The analysis Web Worker: one analysis per worker. The client terminates it afterwards, which is
// the only way to give back the ~0.7 GB the WASM heap grows to (spike/beat-this RESULTS.md).

import { chooseThreadCount } from "./model.ts";
import { loadWebModel } from "./onnx-web.ts";
import { analysePcm } from "./pipeline.ts";
import type { AnalyseRequest, WorkerMessage } from "./protocol.ts";

/** The parts of DedicatedWorkerGlobalScope used here (the app's lib is DOM, not WebWorker). */
interface WorkerScope {
  readonly crossOriginIsolated: boolean;
  readonly navigator: { readonly hardwareConcurrency: number };
  onmessage: ((event: MessageEvent<AnalyseRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

async function handle(request: AnalyseRequest): Promise<void> {
  const { threads, warning } = chooseThreadCount({
    crossOriginIsolated: scope.crossOriginIsolated,
    hardwareConcurrency: scope.navigator.hardwareConcurrency,
  });
  if (warning && request.method !== "dj-core") console.warn(`[analysis] ${warning.message}`);
  const outcome = await analysePcm(
    { channels: request.channels, sampleRate: request.sampleRate },
    {
      method: request.method,
      loadModel: () => loadWebModel(request.modelUrl, threads),
      onProgress: (progress) => {
        scope.postMessage({ type: "progress", progress });
      },
      environmentWarnings: warning ? [warning] : [],
    },
  );
  const transfer = outcome.ok
    ? Object.values(outcome.analysis.waveformOverview)
        .filter((value): value is Float32Array => value instanceof Float32Array)
        .map((array) => array.buffer)
    : [];
  const unique = [...new Set(transfer)];
  scope.postMessage({ type: "done", outcome }, unique);
}

scope.onmessage = (event) => {
  handle(event.data).catch((error: unknown) => {
    // A bug, not an expected failure: report it with its stack so it can be debugged.
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    console.error("[analysis] worker failed", error);
    scope.postMessage({ type: "done", outcome: { ok: false, error: { kind: "worker-crashed", message } } });
  });
};
