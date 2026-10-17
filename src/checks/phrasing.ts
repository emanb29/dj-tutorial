// Phrase and loudness measures around a transition (check-design §2).
import type { CtxSpan, CtxTime } from "@shared/attempt.ts";
import { barSeconds, type CheckContext, type LoadedDeck } from "./context.ts";
import { energyMeanDb } from "./measures.ts";
import { framesIn } from "./mix.ts";
import { positionAt, rateAt, trackBeat } from "./timeline.ts";

/**
 * Signed heard seconds from the deck's nearest phrase marker at `t` (positive = after it).
 * `null` when the deck is not loaded yet or the track has no markers.
 */
export function phraseOffsetSeconds(loaded: LoadedDeck, t: CtxTime): number | null {
  const pos = positionAt(loaded.playhead, t);
  if (pos === null || loaded.phraseMarkers.length === 0) return null;
  const nearest = loaded.phraseMarkers.reduce((best, marker) => (Math.abs(marker - pos) < Math.abs(best - pos) ? marker : best));
  const rate = rateAt(loaded.playhead, t);
  return (pos - nearest) / (rate > 0 ? rate : 1);
}

/** `phraseOff(t, d)`: signed beats from the deck's nearest phrase marker at `t`. */
export function phraseOffsetBeats(loaded: LoadedDeck, t: CtxTime): number | null {
  const pos = positionAt(loaded.playhead, t);
  if (pos === null || loaded.phraseMarkers.length === 0) return null;
  const nearest = loaded.phraseMarkers.reduce((best, marker) => (Math.abs(marker - pos) < Math.abs(best - pos) ? marker : best));
  return trackBeat(loaded.grid, pos) - trackBeat(loaded.grid, nearest);
}

/** `barLoud`: energy mean of master momentary loudness over one bar. */
function barLoudness(context: CheckContext, bar: CtxSpan): number | null {
  return energyMeanDb(framesIn(context.attempt.meters.master, bar).map((frame) => frame.momentaryLufs));
}

/** Mean `barLoud` over consecutive bars of `bar` seconds starting at `from`. */
export function meanBarLoudness(context: CheckContext, from: CtxTime, bar: number, bars: number): number | null {
  const values = Array.from({ length: bars }, (_, index) =>
    barLoudness(context, { from: from + index * bar, to: from + (index + 1) * bar }),
  ).filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `loudJump(t)`: |mean barLoud of the 4 bars before `t` − the 4 bars after|, bars of the master deck. */
export function loudJump(context: CheckContext, master: LoadedDeck, t: CtxTime): number | null {
  const bar = barSeconds(master, t);
  const before = meanBarLoudness(context, t - 4 * bar, bar, 4);
  const after = meanBarLoudness(context, t, bar, 4);
  return before === null || after === null ? null : Math.abs(before - after);
}
