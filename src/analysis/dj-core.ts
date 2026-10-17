/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the envelope
   and FFT lengths computed here; these loops run over every frame of a track. */

// TypeScript port of dj-core's estimate_grid (dj-study/dj-core/src/beat.rs, MIT): band-weighted
// log spectral flux at 200 Hz plus a sub-bass rise envelope, autocorrelation tempo with a 120 BPM
// prior, joint period/phase grid search, and a kick-versus-off-beat choice by sub-bass score.
// Constant tempo, no downbeats, and FOUR-ON-THE-FLOOR ONLY: on the spike it picked 2/3 of the true
// tempo on UK garage and DnB and locked to the off-beat on half-time dubstep (spike/beat-this
// RESULTS.md). The pipeline uses it only when the model cannot run, or when asked.

import { Fft } from "./fft.ts";

export interface DjCoreGrid {
  readonly bpm: number;
  readonly firstBeatSec: number;
}

export type DjCoreFailure =
  | { readonly kind: "too-short"; readonly seconds: number; readonly minimum: number }
  | { readonly kind: "no-steady-beat" };

export type DjCoreResult =
  | { readonly ok: true; readonly grid: DjCoreGrid }
  | { readonly ok: false; readonly failure: DjCoreFailure };

const MIN_BPM = 70;
const MAX_BPM = 180;
const ENVELOPE_RATE = 200;
const MINIMUM_SECONDS = 8;
const START_TOLERANCE_SECONDS = 0.05;

export function estimateGrid(mono: Float32Array, sampleRate: number): DjCoreResult {
  const seconds = mono.length / sampleRate;
  if (seconds < MINIMUM_SECONDS) {
    return { ok: false, failure: { kind: "too-short", seconds, minimum: MINIMUM_SECONDS } };
  }
  const envelopes = onsetEnvelopes(mono, sampleRate);
  const roughPeriod = tempoPeriod(envelopes.onsets);
  if (roughPeriod === null) return { ok: false, failure: { kind: "no-steady-beat" } };
  const [period, fittedPhase] = fitPeriodAndPhase(envelopes.onsets, roughPeriod);
  const offBeat = fittedPhase + period / 2;
  const phase =
    gridScore(envelopes.subBass, period, offBeat) > gridScore(envelopes.subBass, period, fittedPhase)
      ? offBeat
      : fittedPhase;
  const secondsPerBeat = period / ENVELOPE_RATE;
  const first = envelopes.startSeconds + phase / ENVELOPE_RATE;
  const firstBeatSec = first - secondsPerBeat * Math.floor((first + START_TOLERANCE_SECONDS) / secondsPerBeat);
  return { ok: true, grid: { bpm: 60 / secondsPerBeat, firstBeatSec } };
}

interface Envelopes {
  onsets: Float64Array;
  subBass: Float64Array;
  startSeconds: number;
}

function onsetEnvelopes(mono: Float32Array, sampleRate: number): Envelopes {
  const BANDS = 16;
  const SUB_BASS_HZ = 120;
  let frame = 1;
  while (frame < Math.round(sampleRate * 0.046)) frame *= 2;
  const hop = sampleRate / ENVELOPE_RATE;
  const binHz = sampleRate / frame;
  const topBin = Math.floor(8000 / binHz);
  const bandOfBin = Array.from({ length: topBin }, (_, bin) => {
    const hz = Math.max(bin * binHz, 30);
    return Math.floor(Math.min((Math.log(hz / 30) / Math.log(8000 / 30)) * BANDS, BANDS - 1));
  });
  const binsPerBand = new Array<number>(BANDS).fill(0);
  bandOfBin.forEach((band) => (binsPerBand[band] = binsPerBand[band]! + 1));
  const binWeight = Float64Array.from(bandOfBin, (band) =>
    binsPerBand[band] === 0 ? 0 : (2 - band / BANDS) / binsPerBand[band]!,
  );

  const fft = new Fft(frame);
  const window = Float64Array.from({ length: frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
  const count = Math.floor(Math.max(0, mono.length - frame) / hop);
  const real = new Float64Array(frame);
  const imaginary = new Float64Array(frame);
  const previous = new Float64Array(topBin);
  const subBassEnd = Math.max(Math.ceil(SUB_BASS_HZ / binHz), 2);
  const flux = new Float64Array(count);
  const subBass = new Float64Array(count);
  let previousSubBass = 0;
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * hop);
    for (let n = 0; n < frame; n++) {
      real[n] = mono[start + n]! * window[n]!;
      imaginary[n] = 0;
    }
    fft.forward(real, imaginary);
    let rise = 0;
    for (let bin = 0; bin < topBin; bin++) {
      const magnitude = Math.log(1 + 1000 * Math.hypot(real[bin]!, imaginary[bin]!));
      rise += Math.max(0, magnitude - previous[bin]!) * binWeight[bin]!;
      previous[bin] = magnitude;
    }
    flux[i] = i === 0 ? 0 : rise;
    let power = 0;
    for (let bin = 1; bin < subBassEnd; bin++) power += real[bin]! * real[bin]! + imaginary[bin]! * imaginary[bin]!;
    subBass[i] = i === 0 ? 0 : Math.max(0, power - previousSubBass);
    previousSubBass = power;
  }
  // Remove the slowly varying level (running mean over ±0.25 s) so that only onsets remain.
  const half = Math.floor(0.25 * ENVELOPE_RATE);
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i]! + flux[i]!;
  const onsets = Float64Array.from({ length: count }, (_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(count, i + half + 1);
    return Math.max(0, flux[i]! - (prefix[hi]! - prefix[lo]!) / (hi - lo));
  });
  const CALIBRATION_SECONDS = 0.002;
  return { onsets: smooth(onsets), subBass: smooth(subBass), startSeconds: frame / 2 / sampleRate + CALIBRATION_SECONDS };
}

function smooth(values: Float64Array): Float64Array {
  const TAPS = [1, 2, 3, 2, 1] as const;
  return Float64Array.from({ length: values.length }, (_, i) =>
    TAPS.reduce((sum, tap, k) => {
      const j = i + k - 2;
      return j >= 0 && j < values.length ? sum + tap * values[j]! : sum;
    }, 0) / 9,
  );
}

function gridScore(envelope: Float64Array, period: number, phase: number): number {
  const beats = Math.max(0, Math.floor((envelope.length - phase) / period));
  let sum = 0;
  for (let n = 0; n < beats; n++) {
    const position = phase + n * period;
    const index = Math.floor(position);
    const t = position - index;
    if (index >= 0 && index + 1 < envelope.length) sum += envelope[index]! * (1 - t) + envelope[index + 1]! * t;
  }
  return sum;
}

function tempoPeriod(envelope: Float64Array): number | null {
  const minLag = Math.floor((60 / MAX_BPM) * ENVELOPE_RATE);
  const maxLag = Math.ceil((60 / MIN_BPM) * ENVELOPE_RATE);
  if (envelope.length < 4 * maxLag) return null;
  const mean = envelope.reduce((s, v) => s + v, 0) / envelope.length;
  const centred = envelope.map((v) => v - mean);
  const energy = centred.reduce((s, v) => s + v * v, 0);
  if (energy <= 0) return null;
  const correlation = (lag: number) => {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i]! * centred[i + lag]!;
    return sum / energy;
  };
  const scores = new Map<number, number>();
  for (let lag = minLag; lag <= maxLag; lag++) {
    const support = correlation(lag) + 0.5 * Math.max(0, correlation(2 * lag));
    const bpm = (60 * ENVELOPE_RATE) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
    scores.set(lag, support * prior);
  }
  let bestLag = minLag;
  let best = -Infinity;
  for (const [lag, score] of scores) {
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (best <= 0.05) return null;
  const left = scores.get(bestLag - 1);
  const right = scores.get(bestLag + 1);
  if (left === undefined || right === undefined) return bestLag;
  const curvature = left - 2 * best + right;
  return curvature < 0 ? bestLag + (0.5 * (left - right)) / curvature : bestLag;
}

function fitPeriodAndPhase(envelope: Float64Array, roughPeriod: number): [number, number] {
  const search = (from: number, to: number, steps: number, phasesOf: (period: number) => number[]) => {
    let best = { score: -Infinity, period: roughPeriod, phase: 0 };
    for (let step = 0; step <= steps; step++) {
      const period = from + ((to - from) * step) / steps;
      for (const phase of phasesOf(period)) {
        const score = gridScore(envelope, period, phase);
        if (score > best.score) best = { score, period, phase };
      }
    }
    return best;
  };
  const coarse = search(roughPeriod * 0.98, roughPeriod * 1.02, 80, (period) =>
    Array.from({ length: Math.ceil(period) }, (_, p) => p),
  );
  const fine = search(coarse.period * 0.999, coarse.period * 1.001, 40, () =>
    Array.from({ length: 21 }, (_, p) => coarse.phase + (p - 10) * 0.1).filter((p) => p >= 0),
  );
  return [fine.period, fine.phase];
}
