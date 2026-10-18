// On the phrase: dance music moves in 8-bar phrases, and a track's first beat is a phrase start. So
// the outgoing track's phrases are counted from when it came in, and the incoming track should come
// in on one of them.

export const PHRASE_BEATS = 32;

/**
 * Beats from `startSec` to the nearest phrase start of a track that came in at `entrySec` and plays
 * at `bpm`: signed, positive when late, in [-16, 16).
 */
export function phraseOffsetBeats(entrySec: number, startSec: number, bpm: number): number {
  const beats = ((startSec - entrySec) * bpm) / 60;
  const offset = beats - PHRASE_BEATS * Math.round(beats / PHRASE_BEATS);
  // Round to 0.01 beat: the grid is not finer than that, and it keeps -0 and 1e-12 out of captions.
  const rounded = Math.round(offset * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
