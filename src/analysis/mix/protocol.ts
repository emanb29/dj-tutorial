// Messages between gradeMix (client.ts) and the mix worker (worker.ts).

import type { MethodPreference, MixOutcome, MixProgress } from "./types.ts";

export interface GradeMixRequest {
  readonly type: "grade-mix";
  /** The decoded mix, one array per channel, transferred to the worker. */
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly method: MethodPreference;
  readonly modelUrl: string;
}

export type MixWorkerMessage = { readonly type: "progress"; readonly progress: MixProgress } | { readonly type: "done"; readonly outcome: MixOutcome };
