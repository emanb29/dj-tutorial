import { describe, expect, it } from "vitest";
import { renderHouseLoop } from "./synthetic-loops.ts";

const SAMPLE_RATE = 8000;

function rms(samples: Float32Array, from: number, to: number): number {
  const slice = samples.subarray(from, to);
  return Math.sqrt(slice.reduce((sum, sample) => sum + sample * sample, 0) / slice.length);
}

describe("renderHouseLoop", () => {
  const loop = renderHouseLoop({ sampleRate: SAMPLE_RATE, bpm: 120, bars: 4, rootHz: 55, seed: 1 });

  it("is exactly the requested number of bars long", () => {
    // 4 bars × 4 beats × 0.5 s at 120 BPM = 8 s.
    expect(loop.left.length).toBe(8 * SAMPLE_RATE);
    expect(loop.right.length).toBe(8 * SAMPLE_RATE);
  });

  it("puts a kick on every beat: louder just after a beat than just before the next", () => {
    const beat = SAMPLE_RATE / 2;
    const window = SAMPLE_RATE / 50;
    for (const index of [4, 5, 6, 7]) {
      const onBeat = rms(loop.left, index * beat, index * beat + window);
      const beforeNext = rms(loop.left, (index + 1) * beat - window, (index + 1) * beat);
      expect(onBeat).toBeGreaterThan(beforeNext * 2);
    }
  });

  it("never clips", () => {
    const peak = loop.left.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(0.3);
  });

  it("is the same every time for the same seed", () => {
    const again = renderHouseLoop({ sampleRate: SAMPLE_RATE, bpm: 120, bars: 4, rootHz: 55, seed: 1 });
    expect(again.left).toEqual(loop.left);
  });
});
