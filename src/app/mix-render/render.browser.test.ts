// The Render end to end in the browser (ISS-190): synthetic WAV tracks, decoded as a Learner's files
// are, rendered through the engine on OfflineAudioContexts. Nothing reaches the speakers.
import { describe, expect, it } from "vitest";
import { crossfaderGain } from "@audio/curves.ts";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import type { MixPlan, PlanGrid } from "@shared/mix-plan.ts";
import { renderMixPlan, type RenderOutcome, type RenderProgress } from "./render.ts";
import { setTimeline } from "./timeline.ts";
import { MemorySink, partialsTrack, rms, source, TEST_RATE, wavFile, zeroCrossingHz } from "./test-support.ts";

const SECONDS = 60;
const grid = (bpm = 120): PlanGrid => testGrid({ bpm, durationSec: SECONDS });

async function render(plan: MixPlan, grids: readonly PlanGrid[], tracks: readonly Blob[], options: { segmentSec?: number; masterTempo?: boolean; signal?: AbortSignal; onProgress?: (progress: RenderProgress) => void } = {}) {
  const sink = new MemorySink();
  const outcome: RenderOutcome = await renderMixPlan({
    plan,
    grids,
    sources: tracks.map((blob, index) => source(`Track ${String(index + 1)}.wav`, blob)),
    sink,
    sampleRate: TEST_RATE,
    ...options,
  });
  return { outcome, sink };
}

function startOf(plan: MixPlan, grids: readonly PlanGrid[]): number {
  const timed = setTimeline(plan, grids);
  if (!timed.ok) throw new Error(timed.problems[0]?.message);
  return timed.timeline.transitions[0]?.startSec ?? Number.NaN;
}

describe("renderMixPlan", () => {
  it("lands a two-track plan's moves on the planned samples: the cut on the 1, and the incoming track's first beat", async () => {
    // Track 1 is a steady level, so the crossfader's cut shows sample by sample; track 2 is silent but
    // for a click on bar 1, beat 2 (0.6 s into it), a beat after the cut at 120 BPM.
    const { plan } = testPlan(2, { recipe: "cut-on-the-1", grid: () => grid() });
    const grids = [grid(), grid()];
    const steady = new Float32Array(SECONDS * TEST_RATE).fill(0.5);
    const click = new Float32Array(SECONDS * TEST_RATE);
    click[Math.round(0.6 * TEST_RATE)] = 0.9;
    const { outcome, sink } = await render(plan, grids, [wavFile(steady), wavFile(click)]);
    expect(outcome.ok).toBe(true);
    const out = sink.channel(0);
    const cut = Math.round(startOf(plan, grids) * TEST_RATE);
    const level = 0.5 * crossfaderGain("A", 0.5);
    // Untouched up to the sample before the cut (16-bit precision), then the crossfader's 3 ms glide down from it.
    expect(out[cut - 1000]).toBeCloseTo(level, 3);
    expect(out[cut - 1]).toBeCloseTo(level, 3);
    expect(out[cut + 1]).toBeLessThan(level - 0.001);
    expect((out[cut + Math.round(0.003 * TEST_RATE)] ?? 0) / level).toBeCloseTo(Math.exp(-1), 1);
    expect(Math.abs(out[cut + Math.round(0.05 * TEST_RATE)] ?? 1)).toBeLessThan(1e-3);
    // The click lands on its beat: one beat (0.5 s) after the cut, to the sample.
    const after = out.subarray(cut + 0.1 * TEST_RATE);
    const clickAt = cut + 0.1 * TEST_RATE + after.findIndex((sample) => Math.abs(sample) > 0.01);
    expect(Math.abs(clickAt - (cut + 0.5 * TEST_RATE))).toBeLessThanOrEqual(1);
  }, 60_000);

  it("joins segments with no seam: a render in 30-second segments matches one rendered whole", async () => {
    const { plan } = testPlan(2, { recipe: "cut-on-the-1", grid: () => grid() });
    const grids = [grid(), grid()];
    const tracks = [wavFile(partialsTrack(SECONDS, [[311, 0.2], [440, 0.2], [677, 0.2]])), wavFile(partialsTrack(SECONDS, [[262, 0.2], [523, 0.2], [831, 0.15]]))];
    const whole = await render(plan, grids, tracks, { segmentSec: 10_000 });
    const segmented = await render(plan, grids, tracks, { segmentSec: 30 });
    if (!whole.outcome.ok || !segmented.outcome.ok) throw new Error("both renders should succeed");
    expect(whole.outcome.result.segments).toBe(1);
    expect(segmented.outcome.result.segments).toBe(3);
    const reference = whole.sink.channel(0);
    const pieces = segmented.sink.channel(0);
    expect(pieces.length).toBe(reference.length);
    let largest = 0;
    for (let index = 0; index < reference.length; index++) largest = Math.max(largest, Math.abs((reference[index] ?? 0) - (pieces[index] ?? 0)));
    // Measured by the spike: within 3e-4 once the pre-roll has let the mixer settle.
    expect(largest).toBeLessThan(1e-3);
    // And at each seam, the step from one sample to the next is no bigger than the music's own.
    let at = 0;
    for (const segment of segmented.sink.segments.slice(0, -1)) {
      at += segment.length / 4;
      let natural = 0;
      for (let index = at - 4410; index < at; index++) natural = Math.max(natural, Math.abs((pieces[index] ?? 0) - (pieces[index - 1] ?? 0)));
      expect(Math.abs((pieces[at] ?? 0) - (pieces[at - 1] ?? 0))).toBeLessThanOrEqual(natural * 1.1);
    }
  }, 120_000);

  it("keeps the incoming track's key at the outgoing track's tempo with Master Tempo, and says when it could not", async () => {
    // Track 2 is 126 BPM and plays at 120 BPM after the crossfade: 660 Hz stays 660 Hz with the key held.
    const grids = [grid(120), grid(126)];
    const { plan } = testPlan(2, { recipe: "crossfade-8", grid: (index) => grids[index] ?? grid() });
    const tracks = [wavFile(partialsTrack(SECONDS, [[440, 0.4]])), wavFile(partialsTrack(SECONDS, [[660, 0.4]]))];
    const afterBlend = startOf(plan, grids) + 16 + 2;
    const kept = await render(plan, grids, tracks);
    const off = await render(plan, grids, tracks, { masterTempo: false });
    if (!kept.outcome.ok || !off.outcome.ok) throw new Error("both renders should succeed");
    expect(kept.outcome.result.masterTempo).toEqual({ kind: "kept" });
    expect(off.outcome.result.masterTempo).toEqual({ kind: "off", tracks: [2] });
    expect(zeroCrossingHz(kept.sink.channel(0), afterBlend, afterBlend + 10) / 660).toBeCloseTo(1, 2);
    expect(zeroCrossingHz(off.sink.channel(0), afterBlend, afterBlend + 10) / (660 * (120 / 126))).toBeCloseTo(1, 2);
  }, 120_000);

  it("reports the peak and integrated loudness, and never normalises", async () => {
    const { plan } = testPlan(2, { recipe: "crossfade-8", grid: () => grid() });
    const tone = wavFile(partialsTrack(SECONDS, [[1000, 0.2]]));
    const { outcome, sink } = await render(plan, [grid(), grid()], [tone, tone]);
    if (!outcome.ok) throw new Error("the render should succeed");
    const { levels } = outcome.result;
    // One deck alone at the crossfader's centre: 0.2 × −3 dB.
    expect(rms(sink.channel(0), 2, 10) * Math.SQRT2).toBeCloseTo(0.2 * crossfaderGain("A", 0.5), 2);
    expect(levels.peakDbfs).toBeLessThan(-10);
    expect(levels.integratedLufs).toBeGreaterThan(-20);
    expect(levels.integratedLufs).toBeLessThan(-14);
    expect(levels.clippedSamples).toBe(0);
  }, 60_000);

  it("names the track that cannot be decoded, with what to do", async () => {
    const { plan } = testPlan(2, { grid: () => grid() });
    const { outcome } = await render(plan, [grid(), grid()], [new Blob(["not audio"]), new Blob(["not audio"])]);
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "track", track: 0, message: 'Track 1 ("Track 1.wav") could not be decoded: this browser cannot read its format.', fix: "Convert it to MP3, AAC or WAV, or pick another track for that place." },
    });
  });

  it("stops when cancelled", async () => {
    const { plan } = testPlan(2, { recipe: "crossfade-8", grid: () => grid() });
    const tone = wavFile(partialsTrack(SECONDS, [[440, 0.2]]));
    const cancel = new AbortController();
    const { outcome, sink } = await render(plan, [grid(), grid()], [tone, tone], {
      segmentSec: 25,
      signal: cancel.signal,
      onProgress: ({ caption }) => {
        if (caption.startsWith("Mixing")) cancel.abort();
      },
    });
    expect(outcome).toEqual({ ok: false, failure: { kind: "cancelled" } });
    expect(sink.segments).toHaveLength(0);
  });
});
