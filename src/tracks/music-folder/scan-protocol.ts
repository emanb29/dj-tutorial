// Messages between scanner.ts and scan.worker.ts. Folder and file handles are structured-cloneable,
// so they cross as they are.
import type { DirectoryHandleLike } from "../local-files.ts";
import type { ScannedFile, ScanSummary } from "./scan.ts";

export interface ScanRequest {
  readonly type: "scan";
  readonly root: DirectoryHandleLike;
  readonly batchSize?: number;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

export type ScanReply =
  | { readonly type: "batch"; readonly files: readonly ScannedFile[] }
  | { readonly type: "done"; readonly summary: ScanSummary }
  /** `name` is the DOMException's (NotAllowedError, NotFoundError, …), or "Error". */
  | { readonly type: "failed"; readonly name: string; readonly message: string };
