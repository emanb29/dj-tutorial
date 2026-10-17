// Tempo fader arithmetic. The rate is a playbackRate multiplier: 1.06 plays 6% faster.

import { fail, type Result } from "./result.ts";

export type TempoRangePercent = 6 | 10 | 16;
export const TEMPO_RANGES: readonly TempoRangePercent[] = [6, 10, 16];

/** `fader` is -1 (slowest) to +1 (fastest); 0 is the original tempo. */
export function tempoRate(fader: number, rangePercent: TempoRangePercent): number {
  return 1 + (fader * rangePercent) / 100;
}

export function tempoFaderForRate(rate: number, rangePercent: TempoRangePercent): Result<{ fader: number }> {
  const fader = ((rate - 1) * 100) / rangePercent;
  // A hair of tolerance so a rate computed from the range end still fits.
  if (Math.abs(fader) > 1 + 1e-9) {
    return fail({ kind: "tempo-out-of-range", requestedRate: rate, rangePercent });
  }
  return { ok: true, fader: Math.max(-1, Math.min(1, fader)) };
}
