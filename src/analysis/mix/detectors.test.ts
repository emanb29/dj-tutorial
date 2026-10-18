import { describe, expect, it } from "vitest";
import { downmixMean } from "../resample.ts";
import { bassClashBeats, nonNegativeFit } from "./bass.ts";
import { blendDrift } from "./drift.ts";
import { frameAt, spanFeature, spectralFrames } from "./features.ts";
import { audibleSpan, clipping, deadAir, levelDb, levelJumpDb, longestSilenceIn } from "./levels.ts";
import { phraseOffsetBeats } from "./phrase.ts";
import { renderMixFixture, type MixFixtureSpec } from "./test-mixes.ts";
import { novelty, tempoChangeAt, transitionExtent, transitionPeaks } from "./transitions.ts";

// Each detector on its own, on synthetic signals and on the two-track fixtures with the true grid.
const RATE = 22_050;
const GRID = { bpm: 128, firstBeatSec: 0 };
const BEAT = 60 / 128;
const BLEND = { startSec: 45, endSec: 60 };

function mix(spec: Partial<MixFixtureSpec> = {}) {
  const fixture = renderMixFixture({ bpm: 128, bEntryBeat: 96, blendBeats: 32, bBeats: 128, ...spec });
  return { ...fixture, mono: downmixMean(fixture.channels) };
}

const sine = (hz: number, seconds: number, amplitude = 0.5) => Float32Array.from({ length: seconds * RATE }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));

describe("phraseOffsetBeats", () => {
  it("is 0 on a phrase start and signed beats from the nearest one otherwise", () => {
    expect(phraseOffsetBeats(0, 32 * BEAT, 128)).toBe(0);
    expect(phraseOffsetBeats(0, 34 * BEAT, 128)).toBe(2);
    expect(phraseOffsetBeats(0, 30 * BEAT, 128)).toBe(-2);
    // Counted from when the outgoing track came in, not from the start of the mix.
    expect(phraseOffsetBeats(10, 10 + 64 * BEAT, 128)).toBe(0);
    expect(phraseOffsetBeats(10, 10 + 48 * BEAT, 128)).toBe(-16);
  });
});

describe("spectral features", () => {
  it("put a 440 Hz tone in pitch class A and call silence nothing", () => {
    const frames = spectralFrames(sine(440, 2));
    const feature = spanFeature(frames, 0, frames.count);
    const chroma = [...(feature ?? []).slice(24)];
    expect(chroma.indexOf(Math.max(...chroma))).toBe(9);
    const silent = spectralFrames(new Float32Array(2 * RATE));
    expect(spanFeature(silent, 0, silent.count)).toBeNull();
  });
});

describe("transition detection", () => {
  it("puts one novelty peak in a blend, and none in one steady track", { timeout: 60_000 }, () => {
    const { mono } = mix();
    const frames = spectralFrames(mono);
    const peaks = transitionPeaks(frames, novelty(frames));
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBeGreaterThan(45);
    expect(peaks[0]).toBeLessThan(60);
    const steady = mix({ bEntryBeat: 200, bBeats: 1 }).mono.subarray(0, 80 * RATE);
    const steadyFrames = spectralFrames(steady);
    expect(transitionPeaks(steadyFrames, novelty(steadyFrames))).toEqual([]);
  });

  it("measures the blend's extent on the outgoing grid: in on the entry beat, done within a bar of the end", { timeout: 60_000 }, () => {
    const { mono } = mix();
    const frames = spectralFrames(mono);
    const [peak = 0] = transitionPeaks(frames, novelty(frames));
    const extent = transitionExtent(frames, GRID, peak, { fromSec: 0, toSec: 105 });
    expect(extent?.startSec).toBeCloseTo(45, 3);
    expect(Math.abs((extent?.endSec ?? 0) - 60)).toBeLessThanOrEqual(4 * BEAT);
  });

  it("adds a tempo change across a point when the model's beats show one", () => {
    const steady = Array.from({ length: 60 }, (_, n) => n * 0.5);
    expect(tempoChangeAt(steady, 15)).toBe(0);
    const faster = [...Array.from({ length: 30 }, (_, n) => n * 0.5), ...Array.from({ length: 30 }, (_, n) => 15 + n * 0.45)];
    expect(tempoChangeAt(faster, 15)).toBeGreaterThan(0);
  });
});

describe("blendDrift", () => {
  it("holds a beat-matched blend at 0 ms, and catches a new track 0.6 % fast", { timeout: 60_000 }, () => {
    const aligned = blendDrift(mix().mono, RATE, GRID, BLEND, 29);
    expect(aligned).toMatchObject({ holdShare: 1, worstMs: 0 });
    const drifting = blendDrift(mix({ bTempoRatio: 1.006 }).mono, RATE, GRID, BLEND, 29);
    expect(drifting?.holdShare).toBeLessThan(0.85);
    // Fast: the new track's beats come early (negative), by up to ~0.6 % of 32 beats.
    expect(Math.min(...(drifting?.perBeatMs ?? []))).toBeLessThan(-60);
  });

  it("has nothing to say about less than a bar", () => {
    expect(blendDrift(mix().mono, RATE, GRID, { startSec: 45, endSec: 45 + 2 * BEAT }, 29)).toBeNull();
  });
});

describe("bass clash", () => {
  it("splits a spectrum into its parts without negative amounts", () => {
    const a = Float64Array.from([1, 0, 0]);
    const b = Float64Array.from([0, 1, 0]);
    const weights = nonNegativeFit(Float64Array.from([0.5, 2, 0]), [a, b]);
    expect(weights[0]).toBeCloseTo(0.5);
    expect(weights[1]).toBeCloseTo(2);
    expect(nonNegativeFit(Float64Array.from([-1, 1, 0]), [a, b])[0]).toBe(0);
  });

  it("counts the beats where both basslines play: none in a bass swap, most of a blend that keeps both", { timeout: 60_000 }, () => {
    const swap = mix();
    const both = mix({ bass: "both" });
    const references = { oldFromSec: 29, newToSec: 76 };
    expect(bassClashBeats(spectralFrames(swap.mono), GRID, BLEND, references)).toBeLessThanOrEqual(1);
    expect(bassClashBeats(spectralFrames(both.mono), GRID, BLEND, references)).toBeGreaterThan(16);
  });

  it("says nothing when the two tracks' bass sounds the same", { timeout: 60_000 }, () => {
    const { mono } = mix();
    const frames = spectralFrames(mono);
    // Both references from the old track alone.
    expect(bassClashBeats(frames, GRID, { startSec: 20, endSec: 30 }, { oldFromSec: 5, newToSec: 40 })).toBeNull();
    expect(frameAt(frames, 1e9)).toBe(frames.count);
  });
});

describe("levels", () => {
  it("measures a level jump across a transition, and nothing when a side is too short", () => {
    const step = Float32Array.from({ length: 40 * RATE }, (_, i) => (i < 20 * RATE ? 0.1 : 0.2) * Math.sin(i / 3));
    expect(levelJumpDb(step, RATE, { startSec: 20, endSec: 20 }, { fromSec: 0, toSec: 40 })).toBeCloseTo(6, 0);
    expect(levelJumpDb(step, RATE, { startSec: 20, endSec: 20 }, { fromSec: 19, toSec: 40 })).toBeNull();
    expect(levelDb(step, RATE, 0, 20)).toBeCloseTo(20 * Math.log10(0.1 / Math.SQRT2), 0);
  });

  it("counts time at full scale on any channel, and the peak", () => {
    const left = new Float32Array(RATE).fill(0.5);
    const right = new Float32Array(RATE).fill(0.5);
    right.fill(1, 0, RATE / 10);
    expect(clipping([left, right], RATE)).toEqual({ clippedSec: 0.1, peakDbfs: 0 });
    expect(clipping([left], RATE)).toEqual({ clippedSec: 0, peakDbfs: -6 });
    expect(clipping([left, right], RATE, 0.5).clippedSec).toBe(0);
  });

  it("finds silences of 1 s or more between the first and last sound, not before or after", () => {
    const signal = new Float32Array(20 * RATE);
    const tone = sine(220, 1);
    const sounds: [number, number][] = [
      [2, 3],
      [4.2, 4.6],
      [4.7, 5.7],
      [10, 11],
    ];
    for (const [from, to] of sounds) signal.set(tone.subarray(0, Math.round((to - from) * RATE)), Math.round(from * RATE));
    // Silences of 1.2 s (3-4.2), 0.1 s (too short) and 4.3 s (5.7-10); none before 2 s or after 11 s.
    const spans = deadAir(signal, RATE);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.fromSec).toBeCloseTo(3, 1);
    expect(spans[0]?.toSec).toBeCloseTo(4.2, 1);
    expect(spans[1]?.fromSec).toBeCloseTo(5.7, 1);
    expect(spans[1]?.toSec).toBeCloseTo(10, 1);
    expect(audibleSpan(signal, RATE)?.fromSec).toBeCloseTo(2, 1);
    expect(audibleSpan(signal, RATE)?.toSec).toBeCloseTo(11, 1);
    // To the nearest 50 ms block.
    expect(Math.abs(longestSilenceIn(spans, 0, 5) - 1.2)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(longestSilenceIn(spans, 9, 12) - 1)).toBeLessThanOrEqual(0.1);
  });
});
