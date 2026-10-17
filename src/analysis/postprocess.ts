/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the logit and
   chunk lengths; these loops run over every frame of a track. */

// Chunking and "minimal" postprocessing, ported from beat_this.inference (split_piece,
// aggregate_prediction with keep_first) and beat_this.model.postprocessor (postp_minimal).

import { MEL_BANDS } from "./mel.ts";

/** The exported model's fixed time axis: 1500 frames (30 s at 50 fps). */
export const CHUNK = 1500;
export const BORDER = 6;

export interface Chunk {
  /** Frame index where the chunk starts (may be negative: left zero padding). */
  readonly start: number;
  /** [CHUNK][MEL_BANDS], zero padded. */
  readonly spect: Float32Array;
}

/** split_piece(avoid_short_end=True), except every chunk is padded to CHUNK frames, because the
 * exported graph has a fixed time axis. */
export function splitPiece(spect: Float32Array, frames: number): Chunk[] {
  const starts: number[] = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  return starts.map((start) => {
    const chunk = new Float32Array(CHUNK * MEL_BANDS);
    const from = Math.max(start, 0);
    const to = Math.min(start + CHUNK, frames);
    chunk.set(spect.subarray(from * MEL_BANDS, to * MEL_BANDS), (from - start) * MEL_BANDS);
    return { start, spect: chunk };
  });
}

/** aggregate_prediction(overlap_mode="keep_first"): earlier chunks win in overlaps. */
export function aggregate(predictions: readonly Float32Array[], starts: readonly number[], frames: number): Float32Array {
  const out = new Float32Array(frames).fill(-1000);
  for (let c = predictions.length - 1; c >= 0; c--) {
    const start = starts[c]!;
    const prediction = predictions[c]!;
    for (let i = BORDER; i < CHUNK - BORDER; i++) {
      const frame = start + i;
      if (frame >= 0 && frame < frames) out[frame] = prediction[i]!;
    }
  }
  return out;
}

/** Frames that are the maximum of a 7-frame window and have logit > 0. */
function peakFrames(logits: Float32Array): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    const value = logits[i]!;
    if (value <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(logits.length - 1, i + 3); j++) {
      if (logits[j]! > value) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push(i);
  }
  return peaks;
}

/** deduplicate_peaks(width=1): runs of peaks at most `width` apart become their running mean. */
function deduplicate(peaks: readonly number[], width = 1): number[] {
  const [first, ...rest] = peaks;
  if (first === undefined) return [];
  const result: number[] = [];
  let peak = first;
  let count = 1;
  for (const next of rest) {
    if (next - peak <= width) {
      count += 1;
      peak += (next - peak) / count;
    } else {
      result.push(peak);
      peak = next;
      count = 1;
    }
  }
  result.push(peak);
  return result;
}

/** Sub-frame position of a peak: vertex of the parabola through the logits at frame-1, frame,
 * frame+1. Not part of the reference; it lets a 20 ms frame grid report beats more finely. */
function refine(logits: Float32Array, frame: number): number {
  const i = Math.round(frame);
  if (i <= 0 || i >= logits.length - 1 || frame !== i) return frame;
  const left = logits[i - 1]!;
  const centre = logits[i]!;
  const right = logits[i + 1]!;
  const curvature = left - 2 * centre + right;
  if (curvature >= 0) return frame;
  return i + Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature));
}

export interface DetectedBeats {
  /** Seconds, on the model's frame grid. */
  readonly beats: readonly number[];
  /** Seconds, each snapped to the nearest beat. */
  readonly downbeats: readonly number[];
  /** The same beats, refined to sub-frame positions by parabolic interpolation of the logits. */
  readonly refinedBeats: readonly number[];
}

export function minimalPostprocess(beatLogits: Float32Array, downbeatLogits: Float32Array, fps: number): DetectedBeats {
  const beatFrames = deduplicate(peakFrames(beatLogits));
  const downbeatFrames = deduplicate(peakFrames(downbeatLogits));
  const beats = beatFrames.map((f) => f / fps);
  const refinedBeats = beatFrames.map((f) => refine(beatLogits, f) / fps);
  const nearestBeat = (time: number) =>
    beats.reduce((best, beat) => (Math.abs(beat - time) < Math.abs(best - time) ? beat : best), beats[0] ?? time);
  const snapped = downbeatFrames.map((f) => nearestBeat(f / fps));
  const downbeats = [...new Set(snapped)].sort((a, b) => a - b);
  return { beats, downbeats, refinedBeats };
}
