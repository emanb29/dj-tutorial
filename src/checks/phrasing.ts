// Phrase and loudness measures around a transition (check-design §2).
import type { CtxSpan, CtxTime } from "@shared/attempt.ts";
import { barSeconds, type CheckContext, type LoadedDeck } from "./context.ts";
import { energyMeanDb } from "./measures.ts";
import { channelGainDb, deckTracks, framesIn } from "./mix.ts";
import { isPlaying, positionAt, rateAt, trackBeat } from "./timeline.ts";

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
  return pos === null ? null : phraseOffsetBeatsOf(loaded, pos);
}

/** Signed beats from the nearest phrase marker of a track position. */
export function phraseOffsetBeatsOf(loaded: LoadedDeck, pos: number): number | null {
  if (loaded.phraseMarkers.length === 0) return null;
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

/**
 * The master gain the mixer alone gives at `t`, dB: the power sum of the playing decks' channel gains
 * (fader × crossfader curve), as if every track were equally loud. Null when no deck plays.
 */
function mixerGainDb(context: CheckContext, t: CtxTime): number | null {
  const { attempt } = context;
  const playing = (["A", "B"] as const).filter((deck) => deckTracks(attempt.decks[deck]).some((track) => isPlaying(track.playhead, t)));
  if (playing.length === 0) return null;
  return 10 * Math.log10(playing.reduce((power, deck) => power + 10 ** (channelGainDb(attempt, deck, t) / 10), 0));
}

/** Mean, over consecutive bars, of the energy mean of `mixerGainDb` on the master meter's frames. */
function meanBarMixerGain(context: CheckContext, from: CtxTime, bar: number, bars: number): number | null {
  const values = Array.from({ length: bars }, (_, index) => {
    const gains = framesIn(context.attempt.meters.master, { from: from + index * bar, to: from + (index + 1) * bar })
      .map((frame) => mixerGainDb(context, frame.ctx))
      .filter((gain) => gain !== null);
    return gains.length === 0 ? null : energyMeanDb(gains);
  }).filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * `loudJump(t)`: |mean barLoud of the 4 bars after `t` − the 4 bars before − the mixer's own part of
 * that change|, bars of the master deck. The mixer's part is what the faders and the crossfader curve
 * alone would do to two equally loud tracks (`mixerGainDb`): the jump left is the tracks' levels as
 * the trims set them. The crossfader's curve is constant power, so a cut from either end, or from the
 * centre with both decks playing, changes the mixer's part by 0 dB; a cut from the centre with only
 * one deck playing (−3 dB there) to that deck's side (0 dB) is the curve's own +3 dB, not the
 * Learner's level mistake. A later curve (a hardware's own dip, ISS-196) is discounted the same way.
 */
export function loudJump(context: CheckContext, master: LoadedDeck, t: CtxTime): number | null {
  const bar = barSeconds(master, t);
  const before = meanBarLoudness(context, t - 4 * bar, bar, 4);
  const after = meanBarLoudness(context, t, bar, 4);
  if (before === null || after === null) return null;
  const mixerBefore = meanBarMixerGain(context, t - 4 * bar, bar, 4);
  const mixerAfter = meanBarMixerGain(context, t, bar, 4);
  const mixerChange = mixerBefore === null || mixerAfter === null ? 0 : mixerAfter - mixerBefore;
  return Math.abs(after - before - mixerChange);
}
