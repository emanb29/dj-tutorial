import { describe, expect, it, vi } from "vitest";
import { score } from "./evaluate.ts";
import { MODEL_MISSING_FIX, type ModelLoad } from "./model.ts";
import { analysePcm } from "./pipeline.ts";
import { kickTrack, onsetModel } from "./test-signals.ts";
import type { AnalysisProgress } from "./types.ts";

const RATE = 44_100;
const truth = { bpm: 124, firstBeatSec: 0.137, downbeatPhase: 2, durationSec: 40 };
const track = kickTrack(truth.bpm, truth.firstBeatSec, truth.durationSec, RATE, truth.downbeatPhase);
const stereo = { channels: [track, track], sampleRate: RATE };

const withModel = (): Promise<ModelLoad> => Promise.resolve({ ok: true, model: onsetModel(), threads: 4 });
const missing = (): Promise<ModelLoad> =>
  Promise.resolve({ ok: false, error: { kind: "model-missing", modelUrl: "/models/x.onnx", fix: MODEL_MISSING_FIX } });

describe("analysis pipeline", () => {
  it("fits the model's beats into a grid on the kicks with the right bar 1", async () => {
    const progress: AnalysisProgress[] = [];
    const outcome = await analysePcm(stereo, { method: "auto", loadModel: withModel, onProgress: (p) => progress.push(p) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    const { analysis } = outcome;
    expect(analysis.method).toBe("beat-this");
    expect(analysis.modelVersion).toBe("fake-onset-model");
    expect(analysis.bpm).toBeCloseTo(124, 1);
    const result = score(truth, analysis);
    expect(result.gridErrorMeanMs).toBeLessThan(5);
    expect(result.downbeatCorrect).toBe(true);
    expect(analysis.beatGrid.length).toBe(Math.floor((40 - analysis.firstBeatSec) / (60 / analysis.bpm)) + 1);
    expect(analysis.residualRmsMs).not.toBeNull();
    expect(analysis.confidence).toBeGreaterThan(0.7);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.diagnostics.threads).toBe(4);
    expect(analysis.waveformOverview.min.length).toBe(4000);
    expect(progress.map((p) => p.fraction)).toEqual([...progress.map((p) => p.fraction)].sort((a, b) => a - b));
    expect(progress.at(-1)?.fraction).toBe(1);
    expect(new Set(progress.map((p) => p.stage))).toContain("inference");
  });

  it("falls back to the dj-core port when the model is missing, saying why and what it cannot do", async () => {
    const outcome = await analysePcm(stereo, { method: "auto", loadModel: missing });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    const { analysis } = outcome;
    expect(analysis.method).toBe("dj-core-fallback");
    expect(analysis.downbeatPhase).toBeNull();
    expect(analysis.residualRmsMs).toBeNull();
    expect(analysis.confidence).toBeLessThanOrEqual(0.5);
    expect(analysis.warnings.map((w) => w.kind)).toEqual(["model-missing", "four-on-the-floor-only"]);
    expect(score(truth, analysis).gridErrorMeanMs).toBeLessThan(10);
  });

  it("reports the missing model as an error, with the fix, when the model was required", async () => {
    const outcome = await analysePcm(stereo, { method: "beat-this", loadModel: missing });
    expect(outcome).toEqual({
      ok: false,
      error: { kind: "model-missing", modelUrl: "/models/x.onnx", fix: MODEL_MISSING_FIX },
    });
  });

  it("does not load the model when dj-core is asked for", async () => {
    const loadModel = vi.fn(withModel);
    const outcome = await analysePcm(stereo, { method: "dj-core", loadModel });
    expect(outcome.ok && outcome.analysis.method).toBe("dj-core-fallback");
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("collects every problem with the audio instead of stopping at the first", async () => {
    const outcome = await analysePcm(
      { channels: [new Float32Array(10), new Float32Array(20)], sampleRate: 0 },
      { method: "auto", loadModel: withModel },
    );
    expect(outcome.ok ? [] : outcome.error).toMatchObject({ kind: "invalid-audio" });
    expect(!outcome.ok && outcome.error.kind === "invalid-audio" ? outcome.error.problems : []).toHaveLength(2);
  });

  it("refuses audio shorter than 8 s", async () => {
    const outcome = await analysePcm({ channels: [track.subarray(0, 5 * RATE)], sampleRate: RATE }, { method: "auto", loadModel: withModel });
    expect(outcome).toEqual({ ok: false, error: { kind: "too-short", durationSec: 5, minimumSec: 8 } });
  });

  it("finds no steady beat in silence, with either method", async () => {
    const silence = { channels: [new Float32Array(20 * RATE)], sampleRate: RATE };
    const outcome = await analysePcm(silence, { method: "auto", loadModel: withModel });
    expect(outcome.ok ? null : outcome.error.kind).toBe("no-steady-beat");
  });
});
