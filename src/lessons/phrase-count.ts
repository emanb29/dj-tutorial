// The live 8-bar count a Lesson's hook and practice show ("bar 3 of 8"), and when it steps aside so
// the Learner counts by ear: after 2 phrase-timed actions right in a row (phrase taps in Count phrases;
// cuts, swaps, pad jumps … elsewhere) it fades out, after 2 misses in a row it comes back. Never in a
// Check: counting is the skill the Check grades. Pure.
import type { BeatGrid } from "@shared/attempt.ts";
import { BARS_PER_PHRASE, BEATS_PER_BAR, beatSec } from "./track.ts";

/** Phrase taps right in a row that fade the count out, and misses in a row that bring it back. */
export const COUNT_FADES_AFTER = 2;
export const COUNT_RETURNS_AFTER = 2;

export interface PhraseCountState {
  /** Whether the count shows now (false: "now by ear"). */
  readonly shown: boolean;
  /** Phrase taps right in a row, and misses in a row (an off tap, or a phrase start passed untapped). */
  readonly right: number;
  readonly missed: number;
  /** Whether this phrase start was already tapped right (it is judged once, a bar after it). */
  readonly tapped: boolean;
}

export const PHRASE_COUNT_START: PhraseCountState = { shown: true, right: 0, missed: 0, tapped: false };

export type PhraseCountEvent =
  | { readonly kind: "tap"; readonly onPhraseStart: boolean }
  /** A bar after a phrase start: was it tapped? */
  | { readonly kind: "phrase-passed" }
  /** Another phrase-timed practice rep (a cut, a swap, a pad jump …): right or not. */
  | { readonly kind: "action"; readonly good: boolean };

export function phraseCountStep(state: PhraseCountState, event: PhraseCountEvent): PhraseCountState {
  if (event.kind === "action") return event.good ? hit(state) : miss(state);
  if (event.kind === "tap") {
    // A second tap on a phrase start already counted is neither right nor a miss.
    if (event.onPhraseStart && state.tapped) return state;
    return event.onPhraseStart ? hit(state) : miss(state);
  }
  return state.tapped ? { ...state, tapped: false } : miss(state);
}

function hit(state: PhraseCountState): PhraseCountState {
  const right = state.right + 1;
  return { shown: state.shown && right < COUNT_FADES_AFTER, right, missed: 0, tapped: true };
}

function miss(state: PhraseCountState): PhraseCountState {
  const missed = state.missed + 1;
  return { shown: state.shown || missed >= COUNT_RETURNS_AFTER, right: 0, missed, tapped: false };
}

export interface PhrasePosition {
  /** 1-based phrase of the track (phrase 1 starts on bar 1). */
  readonly phrase: number;
  /** 1–8: the bar within the phrase. */
  readonly bar: number;
  /** 1–4: the beat within the bar. */
  readonly beat: number;
}

/** Where track position `positionSec` sits in its 8-bar phrase, counted from bar 1 of the grid. */
export function phrasePosition(grid: BeatGrid, positionSec: number): PhrasePosition {
  const firstDownbeat = ((grid.downbeatIndex % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  // A hair of slack, so a reading exactly on a beat counts as that beat, not the one before.
  const beats = Math.floor((positionSec - grid.firstBeat) / beatSec(grid) - firstDownbeat + 1e-6);
  const bars = Math.floor(beats / BEATS_PER_BAR);
  const inPhrase = ((bars % BARS_PER_PHRASE) + BARS_PER_PHRASE) % BARS_PER_PHRASE;
  return {
    phrase: Math.floor(bars / BARS_PER_PHRASE) + 1,
    bar: inPhrase + 1,
    beat: (((beats % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR) + 1,
  };
}
