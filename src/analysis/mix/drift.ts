/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the envelope
   and histogram lengths computed here. */

// Beat drift through a blend, from the onset envelope above 150 Hz: kick clicks, snares and hats,
// not the bass, whose two basslines beat against each other in a blend and read as onsets.
//
// Onsets are folded onto the outgoing track's grid: onset strength by how far from the grid beat it
// is (up to 0.4 beat either way). The old track alone, summed over its beats, gives the reference:
// its kick's peak, and whatever else it has there. In each beat of the blend, a strong peak the old
// track does not have is the new track's beat; its distance from the reference peak is the drift.
// Beats less than SEPARABLE_MS apart merge into one peak and read as 0, inside the hold anyway.

import { lowPassZeroPhase } from "../phase.ts";
import type { TrackGrid } from "./grids.ts";
import { MIX_THRESHOLDS } from "./types.ts";

const HOP_SEC = 0.001;
const WINDOW_SEC = 0.0058;
const HIGH_PASS_HZ = 150;
/** Peaks closer than this to the reference peak cannot be told apart from it. */
const SEPARABLE_MS = 12;
/** A peak counts at this share of its bar's strongest, and as new where the reference is below it. */
const PEAK_SHARE = 0.35;

/**
 * Onset envelope above HIGH_PASS_HZ, every HOP_SEC from sample `from`: the rise in energy from one
 * window to the next. Linear, not log as in phase.ts: loud transients must outweigh the small
 * fluctuations of two pads beating against each other.
 */
export function onsetEnvelope(mono: Float32Array, sampleRate: number, from: number, to: number): Float64Array {
  const start = Math.max(0, from);
  const end = Math.min(mono.length, to);
  const slice = mono.subarray(start, end);
  const low = lowPassZeroPhase(slice, sampleRate, HIGH_PASS_HZ);
  const window = Math.max(1, Math.round(WINDOW_SEC * sampleRate));
  const prefix = new Float64Array(slice.length + 1);
  for (let i = 0; i < slice.length; i++) prefix[i + 1] = prefix[i]! + (slice[i]! - low[i]!) ** 2;
  const hop = HOP_SEC * sampleRate;
  const envelope = new Float64Array(Math.floor(slice.length / hop));
  for (let k = 0; k < envelope.length; k++) {
    const n = Math.round(k * hop);
    if (n < window || n + window > slice.length) continue;
    envelope[k] = Math.max(0, prefix[n + window]! - 2 * prefix[n]! + prefix[n - window]!);
  }
  return envelope;
}

export interface BlendDrift {
  readonly holdShare: number;
  readonly worstMs: number;
  /** Per beat of the blend, in ms (signed: positive when the new track is late). */
  readonly perBeatMs: readonly number[];
}

/**
 * Drift through the blend [startSec, endSec) against `grid` (the outgoing track's), with
 * [referenceFromSec, startSec) as the old track alone. Null when there is less than a bar to measure.
 */
export function blendDrift(
  mono: Float32Array,
  sampleRate: number,
  grid: TrackGrid,
  blend: { readonly startSec: number; readonly endSec: number },
  referenceFromSec: number,
): BlendDrift | null {
  const beatSec = 60 / grid.bpm;
  // Up to just short of the off-beat: further out, a beat is nearer the next one.
  const reach = Math.round((0.4 * beatSec) / HOP_SEC);
  const fromSec = Math.max(0, referenceFromSec) - 0.5;
  const from = Math.round(fromSec * sampleRate);
  const envelope = onsetEnvelope(mono, sampleRate, from, Math.round((blend.endSec + 0.5) * sampleRate));
  const origin = Math.max(0, from) / sampleRate;
  const beatsIn = (a: number, b: number) => {
    const k0 = Math.ceil((a - grid.firstBeatSec) / beatSec - 1e-6);
    const k1 = Math.ceil((b - grid.firstBeatSec) / beatSec - 1e-6);
    return Array.from({ length: Math.max(0, k1 - k0) }, (_, i) => grid.firstBeatSec + (k0 + i) * beatSec);
  };
  const fold = (beats: readonly number[]) => {
    const histogram = new Float64Array(2 * reach + 1);
    for (const beat of beats) {
      const centre = Math.round((beat - origin) / HOP_SEC);
      for (let lag = -reach; lag <= reach; lag++) histogram[lag + reach]! += envelope[centre + lag] ?? 0;
    }
    return histogram;
  };
  const reference = fold(beatsIn(Math.max(0, referenceFromSec), blend.startSec));
  const referenceMax = Math.max(...reference);
  if (!(referenceMax > 0)) return null;
  const referencePeak = reference.indexOf(referenceMax);
  const blendBeats = beatsIn(blend.startSec, blend.endSec);
  if (blendBeats.length < 4) return null;
  // Beat by beat, not bar by bar: a drifting beat moves a few ms each beat, and a bar's sum would
  // smear it below PEAK_SHARE.
  const perBeatMs = blendBeats.map((beat) => {
    const histogram = fold([beat]);
    const top = Math.max(...histogram);
    if (!(top > 0)) return 0;
    const peaks = [...histogram.keys()].filter(
      (i) => i > 0 && i < histogram.length - 1 && histogram[i]! >= PEAK_SHARE * top && histogram[i]! >= histogram[i - 1]! && histogram[i]! >= histogram[i + 1]!,
    );
    const isNew = (i: number) => Math.abs(i - referencePeak) * HOP_SEC * 1000 >= SEPARABLE_MS && reference[i]! < PEAK_SHARE * referenceMax;
    const fresh = peaks.filter(isNew);
    if (fresh.length === 0) return 0;
    const strongest = fresh.reduce((best, i) => (histogram[i]! > histogram[best]! ? i : best));
    return (strongest - referencePeak) * HOP_SEC * 1000;
  });
  const held = perBeatMs.filter((ms) => Math.abs(ms) <= MIX_THRESHOLDS.driftHoldMs).length;
  return { holdShare: held / perBeatMs.length, worstMs: Math.max(...perBeatMs.map(Math.abs)), perBeatMs };
}
