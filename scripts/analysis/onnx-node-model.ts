// Beat This! through onnxruntime-node, for dev scripts and Node tests. Same model file and checks
// as the browser (src/analysis/onnx-web.ts), but read from disk.

import { existsSync, readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { MEL_BANDS } from "../../src/analysis/mel.ts";
import { BEAT_THIS_SMALL0, checkModelBytes, MODEL_MISSING_FIX, type ModelLoad } from "../../src/analysis/model.ts";
import { CHUNK } from "../../src/analysis/postprocess.ts";

export const DEFAULT_MODEL_PATH = `public/models/${BEAT_THIS_SMALL0.file}`;

export async function loadNodeModel(modelPath = DEFAULT_MODEL_PATH, threads = 4): Promise<ModelLoad> {
  if (!existsSync(modelPath)) return { ok: false, error: { kind: "model-missing", modelUrl: modelPath, fix: MODEL_MISSING_FIX } };
  const file = readFileSync(modelPath);
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const problem = await checkModelBytes(bytes, modelPath);
  if (problem) return { ok: false, error: problem };
  const session = await ort.InferenceSession.create(file, { intraOpNumThreads: threads, graphOptimizationLevel: "all" });
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
        return { beat: beat.data as Float32Array, downbeat: downbeat.data as Float32Array };
      },
    },
  };
}
