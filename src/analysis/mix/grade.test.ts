import { describe, expect, it } from "vitest";
import { MIX_MAX_SEC } from "@shared/outside-practice.ts";
import { MODEL_MISSING_FIX, type ModelLoad } from "../model.ts";
import { onsetModel } from "../test-signals.ts";
import { gradeMixPcm } from "./grade.ts";
import { renderMixFixture, type MixFixtureSpec } from "./test-mixes.ts";
import type { MixProgress, MixReport, MixTransition } from "./types.ts";

// The whole grading on synthetic two-track mixes with known transitions (test-mixes.ts), through the
// dj-core fallback, which is what runs wherever the model file is missing (CI, a fresh checkout).
// 128 BPM: a beat is 0.46875 s, a phrase (32 beats) 15 s. Track A starts at 0 s, on a phrase.

const BEAT = 60 / 128;
const missing = (): Promise<ModelLoad> => Promise.resolve({ ok: false, error: { kind: "model-missing", modelUrl: "/models/x.onnx", fix: MODEL_MISSING_FIX } });
const withModel = (): Promise<ModelLoad> => Promise.resolve({ ok: true, model: onsetModel(), threads: 1 });

async function grade(spec: MixFixtureSpec, method: "dj-core" | "auto" = "dj-core"): Promise<MixReport> {
  const fixture = renderMixFixture(spec);
  const outcome = await gradeMixPcm(fixture, { method, loadModel: method === "dj-core" ? missing : withModel });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.report;
}

function only(report: MixReport): MixTransition {
  expect(report.transitions).toHaveLength(1);
  const [transition] = report.transitions;
  if (transition === undefined) throw new Error("no transition");
  return transition;
}

const BASE = { bpm: 128, bEntryBeat: 96, bBeats: 128 } as const;
const SLOW = 60_000;

describe("gradeMixPcm on synthetic two-track mixes", () => {
  it("finds a clean 32-beat blend on the phrase: start, length, phrase, drift, levels, bass", async () => {
    const t = only(await grade({ ...BASE, blendBeats: 32 }));
    expect(t.kind).toBe("blend");
    expect(t.startSec).toBeCloseTo(45, 1);
    // The new track has taken over within a bar of the old one's end (60 s).
    expect(t.endSec).toBeGreaterThan(60 - 4 * BEAT);
    expect(t.endSec).toBeLessThan(60 + 4 * BEAT);
    expect(t.bpm).toBeCloseTo(128, 0);
    expect(t.phraseOffsetBeats).toBe(0);
    expect(t.drift?.holdShare).toBe(1);
    expect(Math.abs(t.levelJumpDb ?? Infinity)).toBeLessThan(1);
    expect(t.bassClashBeats).toBeLessThanOrEqual(1);
    expect(t.clippedSec).toBe(0);
    expect(t.deadAirSec).toBe(0);
  }, SLOW);

  it("reads a blend that starts 2 beats after the phrase as 2 beats late", async () => {
    const t = only(await grade({ ...BASE, bEntryBeat: 98, blendBeats: 32 }));
    expect(t.startSec).toBeCloseTo(98 * BEAT, 1);
    expect(t.phraseOffsetBeats).toBe(2);
  }, SLOW);

  it("finds a cut on the phrase as a cut", async () => {
    const t = only(await grade({ ...BASE, blendBeats: 0 }));
    expect(t.kind).toBe("cut");
    expect(t.startSec).toBeCloseTo(45, 1);
    expect(t.endSec).toBe(t.startSec);
    expect(t.phraseOffsetBeats).toBe(0);
    expect(t.drift).toBeNull();
    expect(t.bassClashBeats).toBeNull();
  }, SLOW);

  it("finds the cut in a one-minute mix, where most of the mix is near the transition", async () => {
    const t = only(await grade({ bpm: 128, bEntryBeat: 64, blendBeats: 0, bBeats: 64 }));
    expect(t.startSec).toBeCloseTo(30, 1);
    expect(t.phraseOffsetBeats).toBe(0);
  }, SLOW);

  it("catches a blend whose new track runs 0.6 % fast: the beats drift apart", async () => {
    const t = only(await grade({ ...BASE, blendBeats: 32, bTempoRatio: 1.006 }));
    expect(t.kind).toBe("blend");
    expect(t.drift?.holdShare).toBeLessThan(0.85);
    expect(t.drift?.worstMs).toBeGreaterThan(40);
  }, SLOW);

  it("catches both basslines playing through a blend", async () => {
    const t = only(await grade({ ...BASE, blendBeats: 32, bass: "both" }));
    expect(t.bassClashBeats).toBeGreaterThan(16);
  }, SLOW);

  it("measures a cut into a track 6 dB louder as a 6 dB jump", async () => {
    const t = only(await grade({ ...BASE, blendBeats: 0, bGainDb: 6 }));
    expect(t.levelJumpDb).toBeGreaterThan(5);
    expect(t.levelJumpDb).toBeLessThan(7);
  }, SLOW);

  it("finds 1.5 s of dead air between two tracks", async () => {
    const report = await grade({ ...BASE, blendBeats: 0, gapSec: 1.5 });
    const t = only(report);
    expect(t.deadAirSec).toBeGreaterThan(1.3);
    expect(report.deadAir).toHaveLength(1);
    expect(report.deadAir[0]?.fromSec).toBeCloseTo(45, 1);
  }, SLOW);

  it("finds the clipping of a track that came in too hot", async () => {
    const report = await grade({ ...BASE, blendBeats: 0, clip: true });
    const t = only(report);
    expect(t.clippedSec).toBeGreaterThan(0.05);
    expect(report.clippedSec).toBeGreaterThan(t.clippedSec);
    expect(report.peakDbfs).toBe(0);
  }, SLOW);

  it("uses the model's beats when it runs, and says how the beats were found", async () => {
    const report = await grade({ ...BASE, blendBeats: 0 }, "auto");
    expect(report.method).toBe("beat-this");
    expect(only(report).startSec).toBeCloseTo(45, 1);
  }, SLOW);

  it("falls back to dj-core with a warning when the model is missing", async () => {
    const fixture = renderMixFixture({ ...BASE, blendBeats: 0 });
    const progress: MixProgress[] = [];
    const outcome = await gradeMixPcm(fixture, { method: "auto", loadModel: missing, onProgress: (p) => progress.push(p) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.report.method).toBe("dj-core-fallback");
    expect(outcome.report.warnings).toContainEqual({ kind: "model-missing", fix: MODEL_MISSING_FIX });
    expect(progress.at(-1)?.fraction).toBe(1);
    expect(progress.every((p, i) => i === 0 || p.fraction >= (progress[i - 1]?.fraction ?? 0))).toBe(true);
  }, SLOW);
});

describe("gradeMixPcm refuses", () => {
  it("a mix under 30 s, a mix over the limit, and audio it cannot read, as typed errors", async () => {
    const short = await gradeMixPcm({ channels: [new Float32Array(20 * 1000)], sampleRate: 1000 }, { method: "dj-core", loadModel: missing });
    expect(short).toMatchObject({ ok: false, error: { kind: "too-short", minimumSec: 30 } });
    const long = await gradeMixPcm({ channels: [new Float32Array((MIX_MAX_SEC + 1) * 100)], sampleRate: 100 }, { method: "dj-core", loadModel: missing });
    expect(long).toMatchObject({ ok: false, error: { kind: "too-long", maximumSec: MIX_MAX_SEC } });
    const uneven = await gradeMixPcm({ channels: [new Float32Array(10), new Float32Array(11)], sampleRate: 44_100 }, { method: "dj-core", loadModel: missing });
    expect(uneven).toMatchObject({ ok: false, error: { kind: "invalid-audio" } });
  });

  it("to fall back when the model is required: the missing model is the error", async () => {
    const fixture = renderMixFixture({ ...BASE, blendBeats: 0, bBeats: 32 });
    const outcome = await gradeMixPcm(fixture, { method: "beat-this", loadModel: missing });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "model-missing", fix: MODEL_MISSING_FIX } });
  });
});
