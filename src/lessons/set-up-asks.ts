// What a set-up step of the Lesson's own asks the Learner to do ("Set up: CUE 🎧 B on, fader B up"),
// as data the session can read off the decks and the mixer: the step goes on by itself once every ask
// is done (and the controller matches), with or without a DDJ-FLX4. The caption is made from the asks,
// so it never names something the step does not check.
import type { DeckId } from "@shared/attempt.ts";
import { UNMEASURED_PEAK_DB } from "./track.ts";

export type SetUpAsk =
  | { readonly kind: "cue-on"; readonly deck: DeckId }
  | { readonly kind: "sync-on"; readonly deck: DeckId }
  | { readonly kind: "low-cut"; readonly deck: DeckId }
  | { readonly kind: "fader-up"; readonly deck: DeckId }
  /** Beat FX on (the echo-out Check's ECHO). */
  | { readonly kind: "echo-on" }
  /** Both decks would peak within TRIMS_MATCHED_DB of each other. */
  | { readonly kind: "trims-matched" };

/** A set-up step: its caption, and what it waits for. */
export interface SetUpStepPlan {
  readonly caption: string;
  readonly asks: readonly SetUpAsk[];
}

/** A channel fader this high is up (the hooks' "fader up"). */
export const FADER_UP_AT = 0.9;
/** Trims matched: the decks' trimmed peaks this close (practice's loud-match limit, under the Check's 2 dB jump). */
export const TRIMS_MATCHED_DB = 1.5;

function askLine(ask: SetUpAsk): string {
  switch (ask.kind) {
    case "cue-on":
      return `CUE 🎧 ${ask.deck} on`;
    case "sync-on":
      return `SYNC ${ask.deck} on`;
    case "low-cut":
      return `LOW ${ask.deck} all the way down`;
    case "fader-up":
      return `fader ${ask.deck} up`;
    case "echo-on":
      return "ECHO on (V)";
    case "trims-matched":
      return "trims matched";
  }
}

export function setUpStep(asks: readonly SetUpAsk[]): SetUpStepPlan {
  return { caption: `Set up: ${asks.map(askLine).join(", ")}`, asks };
}

/** The decks and the mixer as a set-up step reads them. */
export interface SetUpReading {
  readonly cueOn: Readonly<Record<DeckId, boolean>>;
  readonly syncOn: Readonly<Record<DeckId, boolean>>;
  /** Each deck's LOW at or under the kill line the Checks grade (EQ_CUT_DB). */
  readonly lowCut: Readonly<Record<DeckId, boolean>>;
  readonly fader: Readonly<Record<DeckId, number>>;
  readonly beatFxOn: boolean;
  /** Each deck's track peak plus its trim, in dB (`trimmedPeakDb`); null for a deck with no track. */
  readonly levelDb: Readonly<Record<DeckId, number | null>>;
}

export function askDone(ask: SetUpAsk, reading: SetUpReading): boolean {
  switch (ask.kind) {
    case "cue-on":
      return reading.cueOn[ask.deck];
    case "sync-on":
      return reading.syncOn[ask.deck];
    case "low-cut":
      return reading.lowCut[ask.deck];
    case "fader-up":
      return reading.fader[ask.deck] >= FADER_UP_AT;
    case "echo-on":
      return reading.beatFxOn;
    case "trims-matched": {
      const { A, B } = reading.levelDb;
      return A === null || B === null || Math.abs(A - B) <= TRIMS_MATCHED_DB + 1e-9;
    }
  }
}

/** Where a track peaks with this trim: its measured peak (or the set-up level's guess) plus the trim. */
export function trimmedPeakDb(track: { readonly peakDbfs?: number }, trimDb: number): number {
  return (track.peakDbfs ?? UNMEASURED_PEAK_DB) + trimDb;
}
