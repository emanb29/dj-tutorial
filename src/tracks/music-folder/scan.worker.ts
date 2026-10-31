// The folder walk (scan.ts) off the main thread: one scan per worker, batches posted as found.
import type { ScanReply, ScanRequest } from "./scan-protocol.ts";
import { scanFolder } from "./scan.ts";

/** The parts of DedicatedWorkerGlobalScope used here (the app's lib is DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
  postMessage(message: ScanReply): void;
}

const scope = globalThis as unknown as WorkerScope;

const post = (reply: ScanReply) => {
  scope.postMessage(reply);
};

scope.onmessage = (event: MessageEvent<ScanRequest>) => {
  const { root, batchSize, maxFiles, maxDepth } = event.data;
  scanFolder(root, {
    onBatch: (files) => {
      post({ type: "batch", files });
    },
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(maxFiles === undefined ? {} : { maxFiles }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
  }).then(
    (summary) => {
      post({ type: "done", summary });
    },
    (error: unknown) => {
      post({
        type: "failed",
        name: error instanceof DOMException ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
};
