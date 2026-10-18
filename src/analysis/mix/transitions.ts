/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the frame and
   beat counts computed here. */

// Where one track gives way to the next, from the sound alone.
//
// 1. Novelty: at every frame, how different the 12 s before sound from the 12 s after (band shape and
//    which notes play, level ignored). A track change is a peak; a tempo change across it (from the
//    model's beats, when there are any) adds to it.
// 2. Peaks at least MIN_TRACK_SEC apart, well above the mix's typical novelty.
// 3. Extent, on the outgoing track's beat grid: per beat, how far the sound has moved from the old
//    track's towards the new one's (0 = old only, 1 = new only). The transition starts on the first
//    beat that leaves the old track's range and ends on the first beat inside the new one's. Progress
//    is a projection, not a distance ratio: a single beat's sound varies a lot more than a track's.

import { distance, frameAt, frameTime, spanFeature, type SpectralFrames } from "./features.ts";

const WINDOW_SEC = 12;
const GAP_SEC = 1.5;
/** A track in a mix plays at least this long; two peaks closer than this are one transition. */
export const MIN_TRACK_SEC = 30;
/** Novelty below this is a track's own changes (sections, fills), never a new track. */
const NOVELTY_MIN = 0.12;
/**
 * A peak must also stand this far above the mix's typical novelty: its lower quartile, not its
 * median, because in a short mix most frames are near a transition.
 */
const NOVELTY_OVER_TYPICAL = 3;
/** Tempo changes larger than this (3 %) across a frame add TEMPO_WEIGHT to its novelty. */
const TEMPO_CHANGE = 0.03;
const TEMPO_WEIGHT = 0.5;
/** Seconds of the old track (before) and the new one (after) that set the 0 and 1 of the extent. */
const REFERENCE_SEC = 28;
const REFERENCE_GAP_SEC = 2;
/** A beat leaves the old track's range this far above its mean (or 3 σ), and enters the new one's this far below (or 2 σ). */
const DEPARTURE = 0.08;

/** Median beat interval of `beats` within [from, to), or null with fewer than 6 beats there. */
function medianInterval(beats: readonly number[], from: number, to: number): number | null {
  const inside = beats.filter((t) => t >= from && t < to);
  if (inside.length < 6) return null;
  const gaps = inside.slice(1).map((t, i) => t - inside[i]!).sort((a, b) => a - b);
  return gaps[gaps.length >> 1] ?? null;
}

/** 0 or TEMPO_WEIGHT: whether the tempo changes by more than 3 % across `seconds`. */
export function tempoChangeAt(beats: readonly number[], seconds: number): number {
  const before = medianInterval(beats, seconds - WINDOW_SEC, seconds);
  const after = medianInterval(beats, seconds, seconds + WINDOW_SEC);
  if (before === null || after === null) return 0;
  return Math.abs(Math.log(after / before)) > TEMPO_CHANGE ? TEMPO_WEIGHT : 0;
}

/** Novelty per frame (0 where either side is silent or outside the signal). */
export function novelty(frames: SpectralFrames, beats: readonly number[] = []): Float32Array {
  const window = Math.round(WINDOW_SEC / frames.hopSec);
  const gap = Math.round(GAP_SEC / frames.hopSec);
  return Float32Array.from({ length: frames.count }, (_, f) => {
    if (f - gap - window < 0 || f + gap + window > frames.count) return 0;
    const before = spanFeature(frames, f - gap - window, f - gap);
    const after = spanFeature(frames, f + gap, f + gap + window);
    if (before === null || after === null) return 0;
    return distance(before, after) + (beats.length > 0 ? tempoChangeAt(beats, frameTime(frames, f)) : 0);
  });
}

/** Times of the novelty peaks that are track changes, in order. */
export function transitionPeaks(frames: SpectralFrames, curve: Float32Array): number[] {
  const positive = [...curve].filter((value) => value > 0).sort((a, b) => a - b);
  const typical = positive[positive.length >> 2] ?? 0;
  const floor = Math.max(NOVELTY_MIN, NOVELTY_OVER_TYPICAL * typical);
  const reach = Math.round(MIN_TRACK_SEC / frames.hopSec);
  // Strongest first, so a weaker bump next to a real change never takes its place.
  const candidates = [...curve.keys()].filter((f) => curve[f]! >= floor).sort((a, b) => curve[b]! - curve[a]!);
  const kept: number[] = [];
  for (const f of candidates) if (kept.every((k) => Math.abs(k - f) >= reach)) kept.push(f);
  return kept.sort((a, b) => a - b).map((f) => frameTime(frames, f));
}

export interface BeatGridLike {
  readonly bpm: number;
  readonly firstBeatSec: number;
}

export interface TransitionExtent {
  readonly startSec: number;
  readonly endSec: number;
  /** Progress per beat (0 old track, 1 new), and those beats' times: for tests and debugging. */
  readonly beats: readonly number[];
  readonly progress: readonly number[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Robust spread (median absolute deviation, scaled to σ): a few beats of the other track in a reference do not move it. */
function spread(values: readonly number[]): number {
  const centre = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - centre)));
}

/** At most this many passes of the extent, each with its references moved out to the last one's transition. */
const PASSES = 6;

/**
 * The transition around `peakSec`, measured on `grid`, between the limits (the neighbouring
 * transitions, or the mix's ends). Null when the sound does not move from one side to the other.
 */
export function transitionExtent(
  frames: SpectralFrames,
  grid: BeatGridLike,
  peakSec: number,
  limits: { readonly fromSec: number; readonly toSec: number },
): TransitionExtent | null {
  const beatSec = 60 / grid.bpm;
  const first = Math.max(limits.fromSec, peakSec - 2 * REFERENCE_SEC);
  const last = Math.min(limits.toSec, peakSec + 2 * REFERENCE_SEC);
  const k0 = Math.ceil((first - grid.firstBeatSec) / beatSec);
  const k1 = Math.floor((last - grid.firstBeatSec) / beatSec);
  const beats = Array.from({ length: Math.max(0, k1 - k0) }, (_, i) => grid.firstBeatSec + (k0 + i) * beatSec);
  // Only frames wholly inside the beat: a loud next beat must not leak into this one.
  const half = frames.offsetSec;
  const perBeat = beats.map((t) => spanFeature(frames, frameAt(frames, t + half), Math.max(frameAt(frames, t + half) + 1, frameAt(frames, t + beatSec - half))));

  const measure = (before: readonly [number, number], after: readonly [number, number]) => {
    const old = spanFeature(frames, frameAt(frames, Math.max(limits.fromSec, before[0])), frameAt(frames, before[1]));
    const next = spanFeature(frames, frameAt(frames, after[0]), frameAt(frames, Math.min(limits.toSec, after[1])));
    if (old === null || next === null) return null;
    // Progress is the beat's position along the line from the old track's sound to the new one's, so
    // a beat's own variation (kick, hat, fill) across that line does not count. Silent beats count as
    // neither: they keep the previous beat's progress (dead air is its own check).
    const axis = next.map((value, d) => value - old[d]!);
    const length = axis.reduce((sum, value) => sum + value * value, 0);
    if (length < 1e-9) return null;
    let carried = 0;
    const progress = perBeat.map((feature) => {
      if (feature !== null) carried = feature.reduce((sum, value, d) => sum + (value - old[d]!) * axis[d]!, 0) / length;
      return carried;
    });
    const range = (from: number, to: number) => progress.filter((_, i) => beats[i]! >= from && beats[i]! + beatSec <= to);
    const oldRange = range(Math.max(limits.fromSec, before[0]), before[1]);
    const newRange = range(after[0], Math.min(limits.toSec, after[1]));
    if (oldRange.length < 2 || newRange.length < 2) return null;
    const leave = median(oldRange) + Math.max(3 * spread(oldRange), DEPARTURE);
    const arrive = median(newRange) - Math.max(2 * spread(newRange), DEPARTURE);
    // The crossing nearest the peak.
    const crossings = progress.flatMap((value, i) => (i > 0 && progress[i - 1]! < 0.5 && value >= 0.5 ? [i] : []));
    if (crossings.length === 0) return null;
    const crossing = crossings.reduce((best, i) => (Math.abs(beats[i]! - peakSec) < Math.abs(beats[best]! - peakSec) ? i : best));
    let start = crossing;
    while (start > 0 && progress[start - 1]! > leave) start--;
    let end = crossing;
    while (end < progress.length - 1 && progress[end]! < arrive) end++;
    return { startSec: beats[start]!, endSec: beats[end]!, beats, progress };
  };

  let before: [number, number] = [peakSec - REFERENCE_SEC, peakSec - WINDOW_SEC];
  let after: [number, number] = [peakSec + WINDOW_SEC, peakSec + REFERENCE_SEC];
  let extent = measure(before, after);
  // Again with references next to the transition found, so a long blend does not leak into them. They
  // only ever move outwards: a reference that slid into the blend would pull the extent in after it.
  for (let pass = 1; pass < PASSES && extent !== null; pass++) {
    const beforeEnd = Math.min(before[1], extent.startSec - REFERENCE_GAP_SEC);
    const afterStart = Math.max(after[0], extent.endSec + REFERENCE_GAP_SEC);
    if (beforeEnd === before[1] && afterStart === after[0]) break;
    before = [beforeEnd - (REFERENCE_SEC - REFERENCE_GAP_SEC), beforeEnd];
    after = [afterStart, afterStart + (REFERENCE_SEC - REFERENCE_GAP_SEC)];
    const next = measure(before, after);
    if (next === null) break;
    extent = next;
  }
  return extent;
}
