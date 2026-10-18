/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the frame,
   band and bin counts computed here; this runs over every frame of a mix. */

// Spectral frames for mix grading: a 4096-point FFT every 2048 samples at 22 050 Hz (93 ms hops).
// Per frame, power in 24 log-spaced bands (timbre), in 12 pitch classes (what notes play) and in the
// FFT bins under 200 Hz (the basslines). Powers are kept linear, so any span of frames can be averaged
// before it is turned into a feature: that is what makes a track's "sound" comparable across a mix.

import { Fft } from "../fft.ts";

export const MIX_RATE = 22_050;
const FFT_SIZE = 4096;
const HOP = 2048;
const BANDS = 24;
const BAND_LOW_HZ = 40;
const BAND_HIGH_HZ = 8000;
/** Above the basslines, so a bass swap alone does not read as the new track having taken over. */
const CHROMA_LOW_HZ = 150;
const CHROMA_HIGH_HZ = 2000;
const BASS_LOW_HZ = 25;
const BASS_HIGH_HZ = 200;
/** Band shape matters less than which notes play: tracks in a mix share a genre's timbre. */
const BAND_WEIGHT = 0.35;
/** Mean square below which a span counts as silent (-60 dBFS). */
const SILENT_POWER = 1e-6;

export interface SpectralFrames {
  readonly count: number;
  readonly hopSec: number;
  /** Seconds from the start of the signal to the centre of frame 0. */
  readonly offsetSec: number;
  /** count × 24 band powers. */
  readonly bands: Float64Array;
  /** count × 12 pitch-class powers (150 Hz to 2 kHz). */
  readonly chroma: Float64Array;
  /** count × bassBins powers (25 to 200 Hz). */
  readonly bass: Float64Array;
  readonly bassBins: number;
  /** Mean square of each frame's samples. */
  readonly power: Float64Array;
  /** Prefix sums of bands, chroma and power, for means over any span. */
  readonly prefix: Float64Array;
}

const DIMENSIONS = BANDS + 12 + 1;

export function frameTime(frames: Pick<SpectralFrames, "hopSec" | "offsetSec">, frame: number): number {
  return frames.offsetSec + frame * frames.hopSec;
}

/** The first frame whose centre is at or after `seconds`. */
export function frameAt(frames: Pick<SpectralFrames, "hopSec" | "offsetSec" | "count">, seconds: number): number {
  return Math.min(frames.count, Math.max(0, Math.ceil((seconds - frames.offsetSec) / frames.hopSec)));
}

export function spectralFrames(mono: Float32Array, sampleRate: number = MIX_RATE): SpectralFrames {
  const count = mono.length < FFT_SIZE ? 0 : 1 + Math.floor((mono.length - FFT_SIZE) / HOP);
  const binHz = sampleRate / FFT_SIZE;
  const bandOf = new Int16Array(FFT_SIZE / 2).fill(-1);
  const chromaOf = new Int16Array(FFT_SIZE / 2).fill(-1);
  const bassFrom = Math.ceil(BASS_LOW_HZ / binHz);
  const bassTo = Math.floor(BASS_HIGH_HZ / binHz);
  const bassBins = bassTo - bassFrom + 1;
  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const hz = k * binHz;
    if (hz >= BAND_LOW_HZ && hz < BAND_HIGH_HZ) bandOf[k] = Math.floor((BANDS * Math.log(hz / BAND_LOW_HZ)) / Math.log(BAND_HIGH_HZ / BAND_LOW_HZ));
    if (hz >= CHROMA_LOW_HZ && hz < CHROMA_HIGH_HZ) chromaOf[k] = (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;
  }
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const fft = new Fft(FFT_SIZE);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const bands = new Float64Array(count * BANDS);
  const chroma = new Float64Array(count * 12);
  const bass = new Float64Array(count * bassBins);
  const power = new Float64Array(count);
  // Hann window power, so band powers are on the same scale as the samples' mean square.
  const scale = 2 / (FFT_SIZE * FFT_SIZE * 0.375);
  for (let f = 0; f < count; f++) {
    const start = f * HOP;
    let squares = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const x = mono[start + i]!;
      squares += x * x;
      real[i] = x * window[i]!;
      imaginary[i] = 0;
    }
    power[f] = squares / FFT_SIZE;
    fft.forward(real, imaginary);
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const p = scale * (real[k]! * real[k]! + imaginary[k]! * imaginary[k]!);
      const band = bandOf[k]!;
      if (band >= 0) bands[f * BANDS + band]! += p;
      const pitch = chromaOf[k]!;
      if (pitch >= 0) chroma[f * 12 + pitch]! += p;
      if (k >= bassFrom && k <= bassTo) bass[f * bassBins + k - bassFrom] = p;
    }
  }
  const prefix = new Float64Array((count + 1) * DIMENSIONS);
  for (let f = 0; f < count; f++) {
    const row = f * DIMENSIONS;
    const next = row + DIMENSIONS;
    for (let d = 0; d < BANDS; d++) prefix[next + d] = prefix[row + d]! + bands[f * BANDS + d]!;
    for (let d = 0; d < 12; d++) prefix[next + BANDS + d] = prefix[row + BANDS + d]! + chroma[f * 12 + d]!;
    prefix[next + BANDS + 12] = prefix[row + BANDS + 12]! + power[f]!;
  }
  return { count, hopSec: HOP / sampleRate, offsetSec: FFT_SIZE / 2 / sampleRate, bands, chroma, bass, bassBins, power, prefix };
}

/**
 * The sound of frames [from, to) as one vector: band shape (log, mean removed, so level does not
 * count) and pitch-class profile (unit length). Null when the span is empty or silent.
 */
export function spanFeature(frames: SpectralFrames, from: number, to: number): Float64Array | null {
  const a = Math.max(0, Math.min(frames.count, from));
  const b = Math.max(a, Math.min(frames.count, to));
  if (b - a < 1) return null;
  const mean = (d: number) => (frames.prefix[b * DIMENSIONS + d]! - frames.prefix[a * DIMENSIONS + d]!) / (b - a);
  if (mean(BANDS + 12) < SILENT_POWER) return null;
  const feature = new Float64Array(BANDS + 12);
  const logs = Array.from({ length: BANDS }, (_, d) => Math.log10(mean(d) + 1e-12));
  const average = logs.reduce((sum, value) => sum + value, 0) / BANDS;
  logs.forEach((value, d) => {
    feature[d] = BAND_WEIGHT * (value - average);
  });
  const pitches = Array.from({ length: 12 }, (_, d) => mean(BANDS + d));
  const length = Math.sqrt(pitches.reduce((sum, value) => sum + value * value, 0)) || 1;
  pitches.forEach((value, d) => {
    feature[BANDS + d] = value / length;
  });
  return feature;
}

/** Mean square of frames [from, to): the span's level. */
export function spanPower(frames: SpectralFrames, from: number, to: number): number {
  const a = Math.max(0, Math.min(frames.count, from));
  const b = Math.max(a, Math.min(frames.count, to));
  if (b === a) return 0;
  return (frames.prefix[b * DIMENSIONS + BANDS + 12]! - frames.prefix[a * DIMENSIONS + BANDS + 12]!) / (b - a);
}

/** Mean bass-bin powers of frames [from, to). */
export function spanBass(frames: SpectralFrames, from: number, to: number): Float64Array {
  const a = Math.max(0, Math.min(frames.count, from));
  const b = Math.max(a, Math.min(frames.count, to));
  const out = new Float64Array(frames.bassBins);
  for (let f = a; f < b; f++) for (let k = 0; k < frames.bassBins; k++) out[k]! += frames.bass[f * frames.bassBins + k]!;
  return b > a ? out.map((value) => value / (b - a)) : out;
}

export function distance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(sum);
}

export const isSilentPower = (power: number): boolean => power < SILENT_POWER;
