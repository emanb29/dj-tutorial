import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { score } from "../../src/analysis/evaluate.ts";
import { analysePcm } from "../../src/analysis/pipeline.ts";
import { kickTrack } from "../../src/analysis/test-signals.ts";
import { DEFAULT_MODEL_PATH, loadNodeModel } from "./onnx-node-model.ts";

// Model inference: runs only when public/models/beat_this_small0.onnx is present (npm run fetch-models).
const modelPresent = existsSync(DEFAULT_MODEL_PATH);

describe.skipIf(!modelPresent)("[needs model file] Beat This! small0 through the whole pipeline", () => {
  it("puts the grid within 5 ms of the kicks of a 60 s synthetic track, with the right bar 1", async () => {
    const truth = { bpm: 128, firstBeatSec: 0.42, downbeatPhase: 1, durationSec: 60 };
    const track = kickTrack(truth.bpm, truth.firstBeatSec, truth.durationSec, 44_100, truth.downbeatPhase);
    const outcome = await analysePcm({ channels: [track], sampleRate: 44_100 }, { method: "beat-this", loadModel: () => loadNodeModel() });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.analysis.method).toBe("beat-this");
    const result = score(truth, outcome.analysis);
    expect(Math.abs(result.bpmError)).toBeLessThan(0.05);
    expect(result.gridErrorMeanMs).toBeLessThan(5);
  }, 60_000);
});

describe("Node model loader", () => {
  it("reports a missing model file as model-missing with the fix", async () => {
    const load = await loadNodeModel("public/models/does-not-exist.onnx");
    expect(load.ok ? null : load.error.kind).toBe("model-missing");
  });
});
