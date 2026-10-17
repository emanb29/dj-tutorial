import { describe, expect, it } from "vitest";
import { analyseTrack, MemoryAnalysisCache, type AnalysisProgress } from "./index.ts";
import { DEFAULT_MODEL_URL } from "./model.ts";
import { kickTrack } from "./test-signals.ts";

// Worker plumbing in a real browser, on a tiny synthetic track: 12 s of kicks at 124 BPM.
const RATE = 44_100;
const track = kickTrack(124, 0.137, 12, RATE, 2);
const audio = { channels: [track, track], sampleRate: RATE };

/** Model files are not committed (src/analysis/index.ts); the inference test below needs them. */
const modelPresent = await fetch(DEFAULT_MODEL_URL).then(
  async (response) => response.ok && !(await response.text()).trimStart().startsWith("<"),
  () => false,
);

describe("analyseTrack in a Web Worker", () => {
  it("runs the dj-core fallback when asked, reporting progress and leaving the caller's audio intact", async () => {
    const progress: AnalysisProgress[] = [];
    const outcome = await analyseTrack(audio, { method: "dj-core", onProgress: (p) => progress.push(p) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.fromCache).toBe(false);
    expect(outcome.analysis.method).toBe("dj-core-fallback");
    expect(outcome.analysis.bpm).toBeCloseTo(124, 0);
    expect(outcome.analysis.warnings.map((w) => w.kind)).toContain("four-on-the-floor-only");
    expect(outcome.analysis.waveformOverview.max).toBeInstanceOf(Float32Array);
    expect(progress.at(-1)?.fraction).toBe(1);
    // The worker got copies; the caller's channels were not transferred away.
    expect(track.length).toBe(12 * RATE);
  });

  it("reports a missing model as a typed error with the fix when the model is required", async () => {
    const outcome = await analyseTrack(audio, { method: "beat-this", modelUrl: "/models/does-not-exist.onnx" });
    expect(outcome.ok ? null : outcome.error).toMatchObject({ kind: "model-missing", fix: expect.stringContaining("fetch-models") as unknown });
  });

  it("serves the second analysis of the same audio from the cache", async () => {
    const cache = new MemoryAnalysisCache();
    const first = await analyseTrack(audio, { method: "dj-core", cache });
    const second = await analyseTrack(audio, { method: "dj-core", cache });
    expect(first.ok && !first.fromCache).toBe(true);
    expect(second.ok && second.fromCache).toBe(true);
  });

  it("never answers a Beat This! request with a cached dj-core result", async () => {
    const cache = new MemoryAnalysisCache();
    await analyseTrack(audio, { method: "dj-core", cache });
    const strict = await analyseTrack(audio, { method: "beat-this", modelUrl: "/models/does-not-exist.onnx", cache });
    expect(strict.ok ? "cached" : strict.error.kind).toBe("model-missing");
  });

  it("resolves as aborted when the signal fires", async () => {
    const controller = new AbortController();
    const pending = analyseTrack(audio, { method: "dj-core", signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  // Model inference: runs only when public/models/beat_this_small0.onnx is present (npm run fetch-models).
  it.skipIf(!modelPresent)("[needs model file] runs Beat This! small0 through onnxruntime-web", async () => {
    const long = kickTrack(124, 0.137, 35, RATE, 2);
    const outcome = await analyseTrack({ channels: [long], sampleRate: RATE }, { method: "beat-this" });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.analysis.method).toBe("beat-this");
    expect(outcome.analysis.modelVersion).toBe("beat-this-small0@b95c8ab");
    expect(outcome.analysis.bpm).toBeCloseTo(124, 1);
    // Cross-origin isolated (checked below), so more than the 1-thread fallback.
    expect(outcome.analysis.diagnostics.threads).toBeGreaterThan(1);
    expect(outcome.analysis.warnings).toEqual([]);
  });

  it("runs cross-origin isolated, as the app does, so the model gets its threads", () => {
    expect(crossOriginIsolated).toBe(true);
  });
});
