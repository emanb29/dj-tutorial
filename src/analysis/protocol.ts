// Messages between analyseTrack (client.ts) and the analysis worker (worker.ts).

import type { PipelineOutcome } from "./pipeline.ts";
import type { AnalysisProgress, MethodPreference } from "./types.ts";

export interface AnalyseRequest {
  readonly type: "analyse";
  /** Copies of the caller's channels, transferred to the worker. */
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly method: MethodPreference;
  readonly modelUrl: string;
}

export type WorkerMessage =
  | { readonly type: "progress"; readonly progress: AnalysisProgress }
  | { readonly type: "done"; readonly outcome: PipelineOutcome };
