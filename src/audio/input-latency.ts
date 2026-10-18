// The Learner's input latency: how late (or early) their taps land on a click they hear, measured once
// per browser and output by the Controller page's Timing check, and taken off every Learner input's time
// before it is mapped to heard time (engine.ts, AudioEngine.command). Output latency is already in the
// heard-time mapping (output-clock.ts); this is what is left: the device's input lag, a Bluetooth or
// USB output the browser misreports, and the Learner's own habit of tapping a little after the sound.
//
// It is not the two-device headphone offset (output.ts, headphoneOffsetMs): that lines two outputs up
// with each other; this lines the Learner's hands up with what they hear. They are kept apart.

/** The largest correction applied either way. More than this is not latency but tapping off the beat. */
export const MAX_INPUT_CORRECTION_MS = 150;
/** Taps a Timing check asks for. */
export const TIMING_CHECK_TAPS = 16;
/** Taps that must survive outlier rejection for a measurement to count. */
export const TIMING_CHECK_MIN_KEPT = 10;
/** A tap further than this from the median (and than 3 scaled MADs) is an outlier: a miss, not latency. */
const OUTLIER_FLOOR_MS = 35;
/** Scales a median absolute deviation to a standard deviation for normal data. */
const MAD_TO_SD = 1.4826;
/** Kept taps spread wider than this (as a scaled MAD) are too unsteady to measure latency from. */
const MAX_SPREAD_MS = 60;

export type TimingMeasurement =
  | { readonly kind: "measured"; readonly offsetMs: number; readonly kept: number; readonly rejected: number; readonly spreadMs: number }
  | { readonly kind: "too-few"; readonly kept: number; readonly needed: number }
  | { readonly kind: "too-unsteady"; readonly spreadMs: number };

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The median tap offset (ms, positive = late) after rejecting outliers: taps further from the median
 * than 3 scaled median absolute deviations, and than 35 ms. A median of the kept taps, so one stray tap
 * cannot move it.
 */
export function measureTimingOffset(offsetsMs: readonly number[]): TimingMeasurement {
  if (offsetsMs.length < TIMING_CHECK_MIN_KEPT) return { kind: "too-few", kept: offsetsMs.length, needed: TIMING_CHECK_MIN_KEPT };
  const centre = median(offsetsMs);
  const spread = MAD_TO_SD * median(offsetsMs.map((offset) => Math.abs(offset - centre)));
  const limit = Math.max(3 * spread, OUTLIER_FLOOR_MS);
  const kept = offsetsMs.filter((offset) => Math.abs(offset - centre) <= limit);
  if (kept.length < TIMING_CHECK_MIN_KEPT) return { kind: "too-few", kept: kept.length, needed: TIMING_CHECK_MIN_KEPT };
  const keptCentre = median(kept);
  const keptSpread = MAD_TO_SD * median(kept.map((offset) => Math.abs(offset - keptCentre)));
  if (keptSpread > MAX_SPREAD_MS) return { kind: "too-unsteady", spreadMs: keptSpread };
  return { kind: "measured", offsetMs: keptCentre, kept: kept.length, rejected: offsetsMs.length - kept.length, spreadMs: keptSpread };
}

/** A stored or measured correction held to ±MAX_INPUT_CORRECTION_MS; anything not a finite number is none. */
export function boundedCorrectionMs(offsetMs: number): number {
  if (!Number.isFinite(offsetMs)) return 0;
  return Math.max(-MAX_INPUT_CORRECTION_MS, Math.min(MAX_INPUT_CORRECTION_MS, offsetMs));
}

/** The time a Learner's input is taken to be at, on the performance clock: its event time less their latency. */
export function correctedInputTime(eventTimeMs: number, correctionMs: number): number {
  return eventTimeMs - boundedCorrectionMs(correctionMs);
}
