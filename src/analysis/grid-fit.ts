// Constant-tempo grid fit over detected beats, built to survive what Beat This! actually emits on
// dance music: stretches locked to the off-beat (open hats in house), stretches at half tempo
// (half-time dubstep), and missing or extra beats.
//
// 1. Rough period: median inter-beat interval, folded into the DJ tempo range [MIN_BPM, 2*MIN_BPM).
//    Half-tempo stretches then sit on every other grid beat, so they still count.
// 2. Period and phase: maximise the circular resultant |sum exp(2 pi i t / P)| over P within ±1.5 %.
//    Off-beat stretches point the opposite way and lose the vote to the majority instead of
//    dragging the phase.
// 3. Least squares of beat time on beat index over the inliers (|residual| < 35 ms), iterated.
// 4. Bar 1: the beat phase modulo 4 that most detected downbeats vote for.

export interface FittedGrid {
  readonly bpm: number;
  /** First grid beat at or after -50 ms. */
  readonly firstBeatSec: number;
  /** Index (0-3) of the first downbeat among the grid beats counted from firstBeatSec; null without downbeats. */
  readonly downbeatPhase: number | null;
  /** Share of downbeats that voted for downbeatPhase. */
  readonly downbeatAgreement: number | null;
  readonly inliers: number;
  readonly detected: number;
  /** Detected beats within 35 ms of the grid's off-beats (a sign of off-beat locking). */
  readonly offBeats: number;
  readonly residualRmsMs: number;
  readonly residualMaxMs: number;
}

export interface FitFailure {
  readonly kind: "too-few-beats";
  readonly detected: number;
  readonly minimum: number;
}

export type FitResult = { readonly ok: true; readonly grid: FittedGrid } | { readonly ok: false; readonly failure: FitFailure };

/** Lower edge of the tempo range the grid is folded into; DJ software uses a similar setting. */
export const MIN_BPM = 90;
/** The first grid beat is the first one at or after this time (so a beat at -10 ms still counts as beat 0). */
export const START_TOLERANCE_SEC = 0.05;
const OUTLIER_SECONDS = 0.035;
const MINIMUM_BEATS = 8;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? Number.NaN;
  return sorted.length % 2 ? upper : 0.5 * ((sorted[mid - 1] ?? Number.NaN) + upper);
}

interface Line {
  readonly period: number;
  readonly offset: number;
}

function leastSquares(points: readonly { index: number; time: number }[]): Line {
  const n = points.length;
  const meanIndex = points.reduce((s, p) => s + p.index, 0) / n;
  const meanTime = points.reduce((s, p) => s + p.time, 0) / n;
  const covariance = points.reduce((s, p) => s + (p.index - meanIndex) * (p.time - meanTime), 0);
  const variance = points.reduce((s, p) => s + (p.index - meanIndex) ** 2, 0);
  const period = covariance / variance;
  return { period, offset: meanTime - period * meanIndex };
}

/** Period and offset maximising the circular resultant of the beat phases. */
function circularFit(beats: readonly number[], rough: number): Line {
  const STEPS = 3000;
  const SPAN = 0.015;
  let best = { strength: -1, period: rough, offset: 0 };
  for (let step = 0; step <= STEPS; step++) {
    const period = rough * (1 - SPAN + (2 * SPAN * step) / STEPS);
    let re = 0;
    let im = 0;
    for (const t of beats) {
      const angle = (2 * Math.PI * t) / period;
      re += Math.cos(angle);
      im += Math.sin(angle);
    }
    const strength = Math.hypot(re, im);
    if (strength > best.strength) {
      const phase = Math.atan2(im, re) / (2 * Math.PI);
      best = { strength, period, offset: phase * period };
    }
  }
  return best;
}

/** Index (0-3) of bar 1 among grid beats counted from `firstBeatSec`, by majority of `downbeats`. */
export function voteDownbeatPhase(
  downbeats: readonly number[],
  firstBeatSec: number,
  period: number,
): { phase: number; agreement: number } | null {
  if (downbeats.length === 0) return null;
  const votes = [0, 0, 0, 0];
  for (const d of downbeats) {
    const index = Math.round((d - firstBeatSec) / period);
    const slot = ((index % 4) + 4) % 4;
    votes[slot] = (votes[slot] ?? 0) + 1;
  }
  const most = Math.max(...votes);
  return { phase: votes.indexOf(most), agreement: most / downbeats.length };
}

export function fitGrid(beats: readonly number[], downbeats: readonly number[] = []): FitResult {
  const tooFew = (detected: number): FitResult => ({
    ok: false,
    failure: { kind: "too-few-beats", detected, minimum: MINIMUM_BEATS },
  });
  if (beats.length < MINIMUM_BEATS) return tooFew(beats.length);
  const intervals = beats
    .slice(1)
    .map((b, i) => b - (beats[i] ?? b))
    .filter((d) => d > 0.2 && d < 2);
  let bpm = 60 / median(intervals.length ? intervals : [0.5]);
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm >= 2 * MIN_BPM) bpm /= 2;
  let line = circularFit(beats, 60 / bpm);
  const residual = (t: number) => {
    const index = Math.round((t - line.offset) / line.period);
    return { index, time: t, error: t - (line.offset + index * line.period) };
  };
  let inliers = beats.map(residual).filter((p) => Math.abs(p.error) < 0.15 * line.period);
  for (let iteration = 0; iteration < 5 && inliers.length >= MINIMUM_BEATS; iteration++) {
    line = leastSquares(inliers);
    inliers = beats.map(residual).filter((p) => Math.abs(p.error) < OUTLIER_SECONDS);
  }
  if (inliers.length < MINIMUM_BEATS) return tooFew(inliers.length);
  const residuals = inliers.map((p) => p.error);
  const offBeats = beats.filter((t) => Math.abs(residual(t - line.period / 2).error) < OUTLIER_SECONDS).length;
  const shift = Math.floor((line.offset + START_TOLERANCE_SEC) / line.period);
  const firstBeatSec = line.offset - shift * line.period;
  const vote = voteDownbeatPhase(downbeats, firstBeatSec, line.period);
  return {
    ok: true,
    grid: {
      bpm: 60 / line.period,
      firstBeatSec,
      downbeatPhase: vote?.phase ?? null,
      downbeatAgreement: vote?.agreement ?? null,
      inliers: inliers.length,
      detected: beats.length,
      offBeats,
      residualRmsMs: 1000 * Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length),
      residualMaxMs: 1000 * Math.max(...residuals.map(Math.abs)),
    },
  };
}

/** Beat times of a constant-tempo grid from its first beat to `durationSec`, skipping negative times. */
export function gridBeats(grid: { readonly bpm: number; readonly firstBeatSec: number }, durationSec: number): number[] {
  const period = 60 / grid.bpm;
  const count = Math.max(0, Math.ceil((durationSec - grid.firstBeatSec) / period));
  return Array.from({ length: count }, (_, n) => grid.firstBeatSec + n * period).filter((t) => t >= 0 && t < durationSec);
}
