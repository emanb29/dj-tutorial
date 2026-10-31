// Runs scan.ts in a worker for a real folder handle, so walking a big library never holds up the
// page; anything else (the tests' fake folders, a stand-in object) is walked here, which yields at
// every file read anyway.
import type { DirectoryHandleLike } from "../local-files.ts";
import type { ScanReply, ScanRequest } from "./scan-protocol.ts";
import { scanFolder, type ScanOptions, type ScanSummary } from "./scan.ts";

function isRealHandle(root: DirectoryHandleLike): boolean {
  const Real = (globalThis as { FileSystemDirectoryHandle?: abstract new () => object }).FileSystemDirectoryHandle;
  return Real !== undefined && root instanceof Real;
}

/** A DOMException again, so the caller tells permission from a missing folder as on the main thread. */
function rebuilt(reply: Extract<ScanReply, { type: "failed" }>): Error {
  return reply.name === "Error" ? new Error(reply.message) : new DOMException(reply.message, reply.name);
}

export function scanInWorker(root: DirectoryHandleLike, options: ScanOptions): Promise<ScanSummary> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module", name: "music-folder-scan" });
    const finish = () => {
      worker.terminate();
      options.signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      finish();
      resolve({ files: 0, skipped: 0, truncated: false, xml: [] });
    };
    options.signal?.addEventListener("abort", aborted);
    worker.onmessage = (event: MessageEvent<ScanReply>) => {
      const reply = event.data;
      if (reply.type === "batch") options.onBatch(reply.files);
      else if (reply.type === "done") {
        finish();
        resolve(reply.summary);
      } else {
        finish();
        reject(rebuilt(reply));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(`The folder scan worker crashed: ${event.message}`));
    };
    const request: ScanRequest = {
      type: "scan",
      root,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    };
    worker.postMessage(request);
  });
}

/** Walks `root` in a worker when it is a real folder handle and workers exist; here otherwise. */
export function scanAnywhere(root: DirectoryHandleLike, options: ScanOptions): Promise<ScanSummary> {
  if (typeof Worker !== "undefined" && isRealHandle(root)) return scanInWorker(root, options);
  return scanFolder(root, options);
}
