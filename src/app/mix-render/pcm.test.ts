import { describe, expect, it } from "vitest";
import { integratedLoudness, PcmEncoder } from "./pcm.ts";

const RATE = 48_000;

const sine = (peak: number, seconds: number, hz = 1000) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => peak * Math.sin((2 * Math.PI * hz * index) / RATE));

describe("PcmEncoder", () => {
  it("writes little-endian interleaved 16-bit PCM, holding full scale", () => {
    const encoder = new PcmEncoder(RATE);
    const bytes = encoder.encode(Float32Array.from([0, 0.5, -1, 1.5]), Float32Array.from([1, -0.5, -2, 0]));
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: 8 }, (_, index) => view.getInt16(index * 2, true))).toEqual([0, 32767, 16384, -16384, -32768, -32768, 32767, 0]);
    expect(encoder.levels()).toMatchObject({ clippedSamples: 2 });
    expect(encoder.levels().peakDbfs).toBeCloseTo(20 * Math.log10(2), 9);
  });

  it("measures a −20 dBFS stereo 1 kHz tone at −20 LUFS across segments, as one signal", () => {
    // EBU Tech 3341: a 1 kHz sine in both channels reads its peak level in LUFS (within 0.1 LU).
    const encoder = new PcmEncoder(RATE);
    const tone = sine(0.1, 6);
    for (const [from, to] of [[0, 100_000], [100_000, 250_000], [250_000, tone.length]] as const) {
      encoder.encode(tone.subarray(from, to), tone.subarray(from, to));
    }
    const levels = encoder.levels();
    expect(levels.integratedLufs).toBeCloseTo(-20, 0);
    expect(Math.abs(levels.integratedLufs + 20)).toBeLessThan(0.15);
    expect(levels.peakDbfs).toBeCloseTo(-20, 2);
    expect(levels.clippedSamples).toBe(0);
  });
});

describe("integratedLoudness", () => {
  it("gates out silence and quiet blocks more than 10 LU under the rest", () => {
    expect(integratedLoudness([])).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([-80, -90, -71])).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([-20, -20, -80, -45])).toBeCloseTo(-20, 9);
  });
});
