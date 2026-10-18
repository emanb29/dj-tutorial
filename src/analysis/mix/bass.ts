/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the bin count. */

// Bass clash: two basslines at once in a blend. Each beat's spectrum under 200 Hz is split into the
// old track's bass, the new track's bass and what they share (the kicks, mostly), by non-negative
// least squares against the two tracks' own spectra. A beat clashes when both basslines are there
// at more than a quarter of their own power (-6 dB). Two tracks on the same bass note cannot be told
// apart this way: then the check says nothing rather than guess.

import { frameAt, spanBass, type SpectralFrames } from "./features.ts";
import type { TrackGrid } from "./grids.ts";

/** Each bassline must be at least a quarter of its own power (-6 dB) for the beat to clash. */
const CLASH_POWER = 0.25;
/** Below this share of a track's bass spectrum, the part only it has is too small to follow. */
const MIN_OWN_SHARE = 0.1;

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Non-negative least squares of `target` on up to three components, by trying every subset. */
export function nonNegativeFit(target: Float64Array, components: readonly Float64Array[]): number[] {
  const n = components.length;
  let best: { error: number; weights: number[] } = { error: dot(target, target), weights: new Array<number>(n).fill(0) };
  for (let mask = 1; mask < 1 << n; mask++) {
    const used = [...Array(n).keys()].filter((i) => (mask & (1 << i)) !== 0);
    const gram = used.map((i) => used.map((j) => dot(components[i]!, components[j]!)));
    const rhs = used.map((i) => dot(components[i]!, target));
    const solved = solve(gram, rhs);
    if (solved === null || solved.some((w) => w < 0)) continue;
    const weights = new Array<number>(n).fill(0);
    used.forEach((i, k) => (weights[i] = solved[k]!));
    const residual = target.map((value, bin) => value - weights.reduce((sum, w, i) => sum + w * components[i]![bin]!, 0));
    const error = dot(residual, residual);
    if (error < best.error) best = { error, weights };
  }
  return best.weights;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solve(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    const pivot = a.slice(col).reduce((best, row, i) => (Math.abs(row[col]!) > Math.abs(a[best]![col]!) ? col + i : best), col);
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const head = a[col]!;
    if (Math.abs(head[col]!) < 1e-18) return null;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]! / head[col]!;
      a[row] = a[row]!.map((value, k) => value - factor * head[k]!);
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/**
 * Beats of the blend [startSec, endSec) on `grid` in which both basslines play. The references are
 * the old track alone ([oldFromSec, startSec)) and the new one alone ([endSec, newToSec)). Null when
 * the two basslines are too alike to tell apart, or there is no reference.
 */
export function bassClashBeats(
  frames: SpectralFrames,
  grid: TrackGrid,
  blend: { readonly startSec: number; readonly endSec: number },
  references: { readonly oldFromSec: number; readonly newToSec: number },
): number | null {
  const old = spanBass(frames, frameAt(frames, references.oldFromSec), frameAt(frames, blend.startSec));
  const next = spanBass(frames, frameAt(frames, blend.endSec), frameAt(frames, references.newToSec));
  const shared = old.map((value, k) => Math.min(value, next[k]!));
  const oldOwn = old.map((value, k) => value - shared[k]!);
  const newOwn = next.map((value, k) => value - shared[k]!);
  const share = (own: Float64Array, all: Float64Array) => own.reduce((s, v) => s + v, 0) / (all.reduce((s, v) => s + v, 0) || 1);
  if (share(oldOwn, old) < MIN_OWN_SHARE || share(newOwn, next) < MIN_OWN_SHARE) return null;
  const beatSec = 60 / grid.bpm;
  const k0 = Math.ceil((blend.startSec - grid.firstBeatSec) / beatSec - 1e-6);
  const k1 = Math.ceil((blend.endSec - grid.firstBeatSec) / beatSec - 1e-6);
  let clashes = 0;
  for (let k = k0; k < k1; k++) {
    const t = grid.firstBeatSec + k * beatSec;
    const [a = 0, b = 0] = nonNegativeFit(spanBass(frames, frameAt(frames, t), frameAt(frames, t + beatSec)), [oldOwn, newOwn, shared]);
    if (a >= CLASH_POWER && b >= CLASH_POWER) clashes++;
  }
  return clashes;
}
