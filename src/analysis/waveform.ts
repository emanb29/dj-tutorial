/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the signal and
   bucket counts; this runs over every sample of a track. */

// Waveform overview for drawing: min/max per ~10 ms bucket, and RMS in three bands (below 200 Hz,
// 200 Hz-2 kHz, above 2 kHz) for colouring. Filters are causal second-order Butterworths, which is
// fine for display; nothing here is used for timing.

import type { WaveformOverview } from "./types.ts";

const BUCKET_SECONDS = 0.01;
const LOW_SPLIT_HZ = 200;
const HIGH_SPLIT_HZ = 2000;

/** RBJ biquad, direct form I, one sample at a time. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  static lowPass(sampleRate: number, hz: number): Biquad {
    const { cos, alpha } = Biquad.prewarp(sampleRate, hz);
    const a0 = 1 + alpha;
    return new Biquad((1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static highPass(sampleRate: number, hz: number): Biquad {
    const { cos, alpha } = Biquad.prewarp(sampleRate, hz);
    const a0 = 1 + alpha;
    return new Biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  private static prewarp(sampleRate: number, hz: number) {
    const w = (2 * Math.PI * Math.min(hz, 0.45 * sampleRate)) / sampleRate;
    return { cos: Math.cos(w), alpha: Math.sin(w) / Math.SQRT2 };
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export function waveformOverview(mono: Float32Array, sampleRate: number): WaveformOverview {
  const bucketSamples = Math.max(1, Math.round(BUCKET_SECONDS * sampleRate));
  const buckets = Math.ceil(mono.length / bucketSamples);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  // Two cascaded biquads per edge give 24 dB/octave, enough to keep the bands apart for colouring.
  const lowFilters = [Biquad.lowPass(sampleRate, LOW_SPLIT_HZ), Biquad.lowPass(sampleRate, LOW_SPLIT_HZ)];
  const highFilters = [Biquad.highPass(sampleRate, HIGH_SPLIT_HZ), Biquad.highPass(sampleRate, HIGH_SPLIT_HZ)];
  const midFilters = [
    Biquad.highPass(sampleRate, LOW_SPLIT_HZ),
    Biquad.highPass(sampleRate, LOW_SPLIT_HZ),
    Biquad.lowPass(sampleRate, HIGH_SPLIT_HZ),
    Biquad.lowPass(sampleRate, HIGH_SPLIT_HZ),
  ];
  const chain = (filters: readonly Biquad[], x: number) => filters.reduce((value, filter) => filter.process(value), x);
  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSamples;
    const end = Math.min(mono.length, start + bucketSamples);
    let lo = Infinity;
    let hi = -Infinity;
    let lowPower = 0;
    let midPower = 0;
    let highPower = 0;
    for (let i = start; i < end; i++) {
      const x = mono[i]!;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      lowPower += chain(lowFilters, x) ** 2;
      midPower += chain(midFilters, x) ** 2;
      highPower += chain(highFilters, x) ** 2;
    }
    const count = end - start;
    min[b] = lo;
    max[b] = hi;
    low[b] = Math.sqrt(lowPower / count);
    mid[b] = Math.sqrt(midPower / count);
    high[b] = Math.sqrt(highPower / count);
  }
  return { bucketSec: bucketSamples / sampleRate, min, max, low, mid, high };
}
