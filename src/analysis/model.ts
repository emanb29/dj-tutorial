// The Beat This! model as the pipeline sees it: something that turns one 30 s log-mel window into
// beat and downbeat logits. The browser runs it with onnxruntime-web (onnx-web.ts); the dev scripts
// with onnxruntime-node (scripts/analysis/onnx-node-model.ts). Model files are not committed;
// scripts/fetch-models.ts puts them under public/models/ (see src/analysis/index.ts).

import type { AnalysisError, AnalysisWarning } from "./types.ts";

export const BEAT_THIS_SMALL0 = {
  file: "beat_this_small0.onnx",
  /** Checkpoint and upstream commit it was exported from (scripts/model-export/export.py). */
  version: "beat-this-small0@b95c8ab",
  sha256: "87231a9fea6cef6cc302d0eb86c203feb92f1527570bb78628d950eb6eb7f66e",
} as const;

export const DEFAULT_MODEL_URL = `/models/${BEAT_THIS_SMALL0.file}`;

export const MODEL_MISSING_FIX =
  `Run \`npm run fetch-models -- --from <dir with ${BEAT_THIS_SMALL0.file}>\` (or \`--export\` to build it ` +
  `from the upstream checkpoint), which puts it under public/models/; see src/analysis/index.ts.`;

export interface BeatLogits {
  readonly beat: Float32Array;
  readonly downbeat: Float32Array;
}

export interface BeatModel {
  readonly version: string;
  /** One window: [CHUNK][MEL_BANDS] log-mel in, [CHUNK] beat and downbeat logits out. */
  run(spect: Float32Array): Promise<BeatLogits>;
}

export type ModelUnavailable = Extract<AnalysisError, { kind: "model-missing" | "model-failed" }>;

export type ModelLoad =
  | { readonly ok: true; readonly model: BeatModel; readonly threads: number | null }
  | { readonly ok: false; readonly error: ModelUnavailable };

/** The spike measured 4 WASM threads as fastest on an 8-thread CPU (more was slower). Threads need
 * SharedArrayBuffer, so without cross-origin isolation we run on 1 and say so. */
export function chooseThreadCount(environment: {
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
}): { threads: number; warning: Extract<AnalysisWarning, { kind: "single-thread" }> | null } {
  if (!environment.crossOriginIsolated) {
    return {
      threads: 1,
      warning: {
        kind: "single-thread",
        message:
          "The page is not cross-origin isolated, so the model runs on 1 WASM thread (about 1.6x slower). " +
          "Serve it with the COOP/COEP headers in vite.config.ts.",
      },
    };
  }
  return { threads: Math.max(1, Math.min(4, Math.floor(environment.hardwareConcurrency / 2))), warning: null };
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Checks downloaded model bytes are the exported small0 model, not an HTML fallback page or a
 * different export. */
export async function checkModelBytes(bytes: ArrayBuffer, modelUrl: string): Promise<ModelUnavailable | null> {
  const hash = await sha256Hex(bytes);
  if (hash === BEAT_THIS_SMALL0.sha256) return null;
  const looksLikeHtml = new TextDecoder().decode(bytes.slice(0, 64)).trimStart().startsWith("<");
  if (looksLikeHtml) return { kind: "model-missing", modelUrl, fix: MODEL_MISSING_FIX };
  return {
    kind: "model-failed",
    message:
      `${modelUrl} has SHA-256 ${hash}, not ${BEAT_THIS_SMALL0.sha256} (${BEAT_THIS_SMALL0.version}). ` +
      `Replace it: ${MODEL_MISSING_FIX}`,
  };
}
