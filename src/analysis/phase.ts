/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the signal and
   envelope lengths; these loops run over every sample of a track. */

// Fine phase refinement of a fitted grid against the audio itself.
//
// Beat This! places beats on a 20 ms frame grid and, on the spike's synthetic tracks, a few to 30 ms
// late, by an amount that differs per track; a single calibration constant cannot remove that. The
// fitted grid already has the right tempo, the right beat (not the off-beat) and the right bar line,
// so all that is left is a shift of a few tens of ms. Here we pick the shift (within ±MAX_SHIFT) at
// which the grid beats sit on the sharpest energy rises.
//
// Onset function: log energy in the window [n, n+W) minus log energy in [n-W, n), with W = 5.8 ms,
// for the full band and for a <150 Hz band (kick). For a step onset at t0 this difference peaks at
// n = t0 by construction, so it has no systematic lead or lag of its own.

const HOP_SECONDS = 0.0005;
const WINDOW_SECONDS = 0.0058;
const MAX_SHIFT_SECONDS = 0.06;
const LOW_HZ = 150;

/** Second-order Butterworth low-pass (RBJ biquad), run forward then backward for zero phase. */
export function lowPassZeroPhase(x: Float32Array, sampleRate: number, hz: number): Float32Array {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const run = (input: Float32Array, reverse: boolean) => {
    const out = new Float32Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let k = 0; k < input.length; k++) {
      const i = reverse ? input.length - 1 - k : k;
      const sample = input[i]!;
      const y = b0 * sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = sample;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    return out;
  };
  return run(run(x, false), true);
}

/** Energy-rise onset function sampled every HOP_SECONDS, normalised to a mean of 1. */
function riseEnvelope(x: Float32Array, sampleRate: number): Float64Array {
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i]! + x[i]! * x[i]!;
  const window = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
  const hop = HOP_SECONDS * sampleRate;
  const count = Math.floor(x.length / hop);
  const meanPower = prefix[x.length]! / x.length;
  const floor = 1e-6 * meanPower * window + 1e-12;
  const envelope = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const n = Math.round(k * hop);
    if (n < window || n + window > x.length) continue;
    const after = prefix[n + window]! - prefix[n]!;
    const before = prefix[n]! - prefix[n - window]!;
    envelope[k] = Math.max(0, Math.log(after + floor) - Math.log(before + floor));
  }
  const mean = envelope.reduce((s, v) => s + v, 0) / envelope.length || 1;
  return envelope.map((v) => v / mean);
}

export interface PhaseRefinement {
  /** Seconds added to the grid's first beat. */
  readonly shiftSec: number;
  /** Best score over the median score across shifts: near 1 means no clear onset alignment. */
  readonly contrast: number;
  /** Low-band (<150 Hz) onset score on the beats over the score on the off-beats; > 1 means the
   * grid sits on the kick, not on the off-beat. */
  readonly lowOnBeatVsOffBeat: number;
}

export function refinePhase(
  mono: Float32Array,
  sampleRate: number,
  grid: { readonly bpm: number; readonly firstBeatSec: number },
): PhaseRefinement {
  const full = riseEnvelope(mono, sampleRate);
  const low = riseEnvelope(lowPassZeroPhase(mono, sampleRate, LOW_HZ), sampleRate);
  const period = 60 / grid.bpm;
  const seconds = mono.length / sampleRate;
  const sumOnBeats = (envelope: Float64Array, start: number) => {
    let sum = 0;
    for (let t = start; t < seconds; t += period) {
      const k = Math.round(t / HOP_SECONDS);
      if (k >= 0 && k < envelope.length) sum += envelope[k]!;
    }
    return sum;
  };
  const steps = Math.round(MAX_SHIFT_SECONDS / HOP_SECONDS);
  const scores = Array.from({ length: 2 * steps + 1 }, (_, i) => {
    const shift = (i - steps) * HOP_SECONDS;
    const start = grid.firstBeatSec + shift;
    return { shift, score: sumOnBeats(full, start) + sumOnBeats(low, start) };
  });
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  const sorted = scores.map((s) => s.score).sort((a, b) => a - b);
  const middle = sorted[sorted.length >> 1] ?? 0;
  const median = middle > 0 ? middle : 1;
  const refinedStart = grid.firstBeatSec + best.shift;
  return {
    shiftSec: best.shift,
    contrast: best.score / median,
    lowOnBeatVsOffBeat: sumOnBeats(low, refinedStart) / (sumOnBeats(low, refinedStart + period / 2) || 1e-9),
  };
}
