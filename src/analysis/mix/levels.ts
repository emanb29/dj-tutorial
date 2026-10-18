/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the signal
   lengths; these loops run over every sample of a mix. */

// Level checks on the samples themselves: loudness jumps across a transition, clipping, dead air.

import { MIX_THRESHOLDS, type SilenceSpan } from "./types.ts";

/** Samples at or above this (|x|, -0.01 dBFS) are at full scale: clipped, or about to be. */
export const CLIP_LEVEL = 0.999;
/** Blocks quieter than this (RMS) are silence: about the Lessons' -45 LUFS for music. */
const SILENCE_DBFS = -48;
const SILENCE_BLOCK_SEC = 0.05;
/** Loudness is compared over this long on each side of a transition. */
const LEVEL_SPAN_SEC = 8;
/** Shorter than this on either side, there is nothing to compare. */
const LEVEL_MIN_SEC = 2;

export const decibels = (power: number): number => 10 * Math.log10(power + 1e-20);

/** RMS level of [fromSec, toSec), in dBFS. */
export function levelDb(mono: Float32Array, sampleRate: number, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.round(fromSec * sampleRate));
  const to = Math.min(mono.length, Math.round(toSec * sampleRate));
  let sum = 0;
  for (let i = from; i < to; i++) sum += mono[i]! * mono[i]!;
  return decibels(to > from ? sum / (to - from) : 0);
}

/**
 * Loudness after a transition minus before it: the 8 s before it started against the 8 s after it
 * ended, kept inside `limits` (the neighbouring transitions). Null when either side is under 2 s.
 */
export function levelJumpDb(
  mono: Float32Array,
  sampleRate: number,
  transition: { readonly startSec: number; readonly endSec: number },
  limits: { readonly fromSec: number; readonly toSec: number },
): number | null {
  const beforeFrom = Math.max(limits.fromSec, transition.startSec - LEVEL_SPAN_SEC);
  const afterTo = Math.min(limits.toSec, transition.endSec + LEVEL_SPAN_SEC);
  if (transition.startSec - beforeFrom < LEVEL_MIN_SEC || afterTo - transition.endSec < LEVEL_MIN_SEC) return null;
  const jump = levelDb(mono, sampleRate, transition.endSec, afterTo) - levelDb(mono, sampleRate, beforeFrom, transition.startSec);
  return Math.round(jump * 10) / 10;
}

/** Time at full scale in [fromSec, toSec) on any channel, and the peak there in dBFS. */
export function clipping(channels: readonly Float32Array[], sampleRate: number, fromSec = 0, toSec = Infinity): { clippedSec: number; peakDbfs: number } {
  const length = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.round(fromSec * sampleRate));
  const to = Math.min(length, Number.isFinite(toSec) ? Math.round(toSec * sampleRate) : length);
  let clipped = 0;
  let peak = 0;
  for (let i = from; i < to; i++) {
    let over = false;
    for (const channel of channels) {
      const x = Math.abs(channel[i]!);
      if (x > peak) peak = x;
      if (x >= CLIP_LEVEL) over = true;
    }
    if (over) clipped++;
  }
  return { clippedSec: clipped / sampleRate, peakDbfs: Math.round(200 * Math.log10(peak + 1e-12)) / 10 };
}

/** Where the sound starts and ends (the first and last block above the silence level). */
export function audibleSpan(mono: Float32Array, sampleRate: number): SilenceSpan | null {
  const silent = silentBlocks(mono, sampleRate);
  const first = silent.indexOf(false);
  const last = silent.lastIndexOf(false);
  const blockSec = blockSamples(sampleRate) / sampleRate;
  return first < 0 ? null : { fromSec: first * blockSec, toSec: (last + 1) * blockSec };
}

const blockSamples = (sampleRate: number) => Math.max(1, Math.round(SILENCE_BLOCK_SEC * sampleRate));

function silentBlocks(mono: Float32Array, sampleRate: number): boolean[] {
  const block = blockSamples(sampleRate);
  const threshold = 10 ** (SILENCE_DBFS / 10);
  return Array.from({ length: Math.ceil(mono.length / block) }, (_, b) => {
    const from = b * block;
    const to = Math.min(mono.length, from + block);
    let sum = 0;
    for (let i = from; i < to; i++) sum += mono[i]! * mono[i]!;
    return sum / (to - from) < threshold;
  });
}

/** Every silence of deadAirSec or more between the first sound and the last. */
export function deadAir(mono: Float32Array, sampleRate: number): SilenceSpan[] {
  const silent = silentBlocks(mono, sampleRate);
  const first = silent.indexOf(false);
  const last = silent.lastIndexOf(false);
  const blockSec = blockSamples(sampleRate) / sampleRate;
  const spans: SilenceSpan[] = [];
  let runStart: number | null = null;
  for (let b = first; b >= 0 && b <= last + 1; b++) {
    if (b <= last && silent[b] === true) runStart ??= b;
    else if (runStart !== null) {
      const span = { fromSec: runStart * blockSec, toSec: b * blockSec };
      if (span.toSec - span.fromSec >= MIX_THRESHOLDS.deadAirSec - 1e-9) spans.push(span);
      runStart = null;
    }
  }
  return spans;
}

/** The longest part of `spans` inside [fromSec, toSec). */
export function longestSilenceIn(spans: readonly SilenceSpan[], fromSec: number, toSec: number): number {
  const lengths = spans.map((span) => Math.max(0, Math.min(toSec, span.toSec) - Math.max(fromSec, span.fromSec)));
  return Math.round(100 * Math.max(0, ...lengths)) / 100;
}
