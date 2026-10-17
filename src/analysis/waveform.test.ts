import { describe, expect, it } from "vitest";
import { waveformOverview } from "./waveform.ts";

const RATE = 44_100;
const sine = (hz: number, amplitude: number, seconds: number) =>
  Float32Array.from({ length: seconds * RATE }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));

describe("waveform overview", () => {
  // One second of a 60 Hz bass tone, then one second of a 6 kHz tone.
  const signal = new Float32Array(2 * RATE);
  signal.set(sine(60, 0.5, 1));
  signal.set(sine(6000, 0.25, 1), RATE);
  const overview = waveformOverview(signal, RATE);

  it("has one bucket per ~10 ms, a whole number of samples long", () => {
    expect(overview.bucketSec).toBeCloseTo(0.01, 4);
    expect(overview.bucketSec * RATE).toBe(441);
    expect(overview.min.length).toBe(200);
    expect(overview.low.length).toBe(200);
  });

  it("keeps the peaks of each bucket", () => {
    // A 60 Hz cycle (16.7 ms) spans two buckets, so look at a pair of them.
    expect(Math.max(...overview.max.subarray(50, 52))).toBeCloseTo(0.5, 2);
    expect(Math.min(...overview.min.subarray(50, 52))).toBeCloseTo(-0.5, 2);
    expect(overview.max[150]).toBeCloseTo(0.25, 2);
    expect(overview.min[150]).toBeCloseTo(-0.25, 2);
  });

  it("puts a bass tone in the low band and a 6 kHz tone in the high band", () => {
    const at = (bucket: number) => ({
      low: overview.low[bucket] ?? Number.NaN,
      mid: overview.mid[bucket] ?? Number.NaN,
      high: overview.high[bucket] ?? Number.NaN,
    });
    const bass = at(50);
    expect(bass.low).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(bass.high).toBeLessThan(0.01);
    expect(bass.mid).toBeLessThan(bass.low / 4);
    const treble = at(150);
    expect(treble.high).toBeCloseTo(0.25 / Math.SQRT2, 1);
    expect(treble.low).toBeLessThan(0.01);
  });
});
