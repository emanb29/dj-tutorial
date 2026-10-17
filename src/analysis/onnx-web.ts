// Beat This! through onnxruntime-web's WASM backend, for the worker.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { BEAT_THIS_SMALL0, checkModelBytes, MODEL_MISSING_FIX, type ModelLoad } from "./model.ts";
import { MEL_BANDS } from "./mel.ts";
import { CHUNK } from "./postprocess.ts";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadWebModel(modelUrl: string, threads: number): Promise<ModelLoad> {
  let response: Response;
  try {
    response = await fetch(modelUrl);
  } catch (error) {
    return { ok: false, error: { kind: "model-failed", message: `Could not fetch ${modelUrl}: ${describe(error)}` } };
  }
  if (response.status === 404) {
    return { ok: false, error: { kind: "model-missing", modelUrl, fix: MODEL_MISSING_FIX } };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { kind: "model-failed", message: `Fetching ${modelUrl} returned HTTP ${String(response.status)}.` },
    };
  }
  const bytes = await response.arrayBuffer();
  const problem = await checkModelBytes(bytes, modelUrl);
  if (problem) return { ok: false, error: problem };

  ort.env.wasm.wasmPaths = { wasm: wasmUrl };
  ort.env.wasm.numThreads = threads;
  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(bytes), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    return { ok: false, error: { kind: "model-failed", message: `onnxruntime-web could not load the model: ${describe(error)}` } };
  }
  return {
    ok: true,
    threads,
    model: {
      version: BEAT_THIS_SMALL0.version,
      async run(spect) {
        const output = await session.run({ spect: new ort.Tensor("float32", spect, [1, CHUNK, MEL_BANDS]) });
        const beat = output["beat"];
        const downbeat = output["downbeat"];
        if (!beat || !downbeat) throw new Error("The model did not return beat and downbeat outputs; re-export it.");
        return { beat: (await beat.getData()) as Float32Array, downbeat: (await downbeat.getData()) as Float32Array };
      },
    },
  };
}
