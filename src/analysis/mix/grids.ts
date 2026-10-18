// A beat grid for one track of a mix: fitted where it plays alone, then refined against its own
// onsets. With the model's beats the grid-fit of single tracks is reused on the beats in that
// stretch; without them (the model could not run), the dj-core port estimates it from the audio.

import { MIN_PHASE_CONTRAST } from "../confidence.ts";
import { estimateGrid } from "../dj-core.ts";
import { fitGrid } from "../grid-fit.ts";
import { refinePhase } from "../phase.ts";

export interface TrackGrid {
  readonly bpm: number;
  /** Any beat of the grid, in seconds of the mix. */
  readonly firstBeatSec: number;
}

/** dj-core needs 8 s; a shorter stretch has too few beats to trust a tempo from anyway. */
const MIN_SPAN_SEC = 8;

export function trackGrid(
  mono: Float32Array,
  sampleRate: number,
  span: { readonly fromSec: number; readonly toSec: number },
  beats: readonly number[] | null,
): TrackGrid | null {
  const fromSec = Math.max(0, span.fromSec);
  const toSec = Math.min(mono.length / sampleRate, span.toSec);
  if (toSec - fromSec < MIN_SPAN_SEC) return null;
  const from = Math.round(fromSec * sampleRate);
  const slice = mono.subarray(from, Math.round(toSec * sampleRate));
  const local = (() => {
    if (beats !== null) {
      const fit = fitGrid(beats.filter((t) => t >= fromSec && t < toSec).map((t) => t - fromSec));
      if (fit.ok) return fit.grid;
    }
    const estimate = estimateGrid(slice, sampleRate);
    return estimate.ok ? estimate.grid : null;
  })();
  if (local === null) return null;
  const refinement = refinePhase(slice, sampleRate, local);
  const shift = refinement.contrast >= MIN_PHASE_CONTRAST ? refinement.shiftSec : 0;
  return { bpm: local.bpm, firstBeatSec: fromSec + local.firstBeatSec + shift };
}

/** The grid beat nearest `seconds`. */
export function nearestBeat(grid: TrackGrid, seconds: number): number {
  const beatSec = 60 / grid.bpm;
  return grid.firstBeatSec + Math.round((seconds - grid.firstBeatSec) / beatSec) * beatSec;
}
