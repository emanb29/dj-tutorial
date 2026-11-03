// A Transition as the Mix Editor stores it: musical intent, as lanes of keyframes in beats, never
// controller moves. The shapes follow the Mix Editor design doc's data model ("Design: Mix Editor",
// Data model), read-only here because the derivation only reads them. The Mix Plan that holds
// Transitions (tracks, storage, validation) is its own module; when both exist, they share one copy of
// these types.
//
// Also the arithmetic on lanes the derivation needs: a lane's value at a beat, and where phrases start.

import { BARS_PER_PHRASE, BEATS_PER_BAR } from "@lessons/track.ts";

/** The named, ready-made Transitions (Transition recipes); all seven ship in v1. */
export type RecipeId = "long-blend" | "bass-swap" | "filter-sweep" | "echo-out" | "cut-on-the-one" | "loop-to-extend" | "tempo-ride";

/** A position on one track's beat grid, 1-based as the captions say. */
export interface GridPos {
  readonly bar: number;
  readonly beat: 1 | 2 | 3 | 4;
}

export interface Transition {
  readonly recipe: RecipeId | "custom";
  /** On the outgoing track: where the Transition starts (a phrase start by default). */
  readonly outgoingAt: GridPos;
  /** On the incoming track: what is heard at that moment. */
  readonly incomingAt: GridPos;
  /** Span, from `outgoingAt`, on the outgoing track's grid. */
  readonly lengthBeats: number;
  readonly lanes: readonly Lane[];
}

export type LaneParam =
  /** The track's level in the mix, 0…1 (fader × crossfader, merged). */
  | "volume"
  /** −1…1, as on the mixer: 0 is the centre, −1 a kill (EQ) or full low-pass (filter), 1 full high-pass. */
  | "eq-low"
  | "eq-mid"
  | "eq-high"
  | "filter"
  /** The track's BPM (matched to the outgoing one unless a ride is drawn). */
  | "tempo"
  /** 0…1 wet; the echo's length in beats is the lane's `echoBeats`. */
  | "echo-send"
  /** 0 is off; any other value is a loop of that many beats ("hold this bar" is 4). */
  | "loop";

export type LaneTrack = "outgoing" | "incoming";

export interface Lane {
  readonly track: LaneTrack;
  readonly param: LaneParam;
  /** Ordered by beat; the lane holds its value between them, and before the first and after the last. */
  readonly keyframes: readonly Keyframe[];
  /** For "echo-send". */
  readonly echoBeats?: number;
}

export type KeyframeCurve = "jump" | "linear" | "ease";

export interface Keyframe {
  /** Beats from `outgoingAt`; fractions allowed (0.5 is an eighth note). */
  readonly beat: number;
  /** In the param's range. */
  readonly value: number;
  /** How to reach this value from the previous keyframe. */
  readonly curve: KeyframeCurve;
}

export const BEATS_PER_PHRASE = BARS_PER_PHRASE * BEATS_PER_BAR;

/** Beats from the start of bar 1 (0-based): bar 17 beat 1 is 64. */
export function gridBeat(position: GridPos): number {
  return (position.bar - 1) * BEATS_PER_BAR + (position.beat - 1);
}

/** Whether a Transition beat lands on a phrase start of the outgoing track (every 8 bars from bar 1). */
export function isPhraseStart(transition: Pick<Transition, "outgoingAt">, beat: number): boolean {
  const onGrid = gridBeat(transition.outgoingAt) + beat;
  return Number.isInteger(onGrid) && onGrid % BEATS_PER_PHRASE === 0;
}

/** Whether a keyframe is reached at once: a jump, or a ramp with no length. */
export function isJump(previous: Keyframe, keyframe: Keyframe): boolean {
  return keyframe.curve === "jump" || keyframe.beat <= previous.beat;
}

const ease = (x: number) => x * x * (3 - 2 * x);

function between(previous: Keyframe, next: Keyframe, beat: number): number {
  if (isJump(previous, next)) return previous.value;
  const x = (beat - previous.beat) / (next.beat - previous.beat);
  const shaped = next.curve === "ease" ? ease(x) : x;
  return previous.value + (next.value - previous.value) * shaped;
}

/**
 * A lane's value at `beat`, counting a keyframe at exactly that beat (a jump there has happened).
 * `keyframes` must be ordered by beat.
 */
export function valueAt(keyframes: readonly Keyframe[], beat: number): number | null {
  const next = keyframes.findIndex((keyframe) => keyframe.beat > beat);
  if (next === -1) return keyframes.at(-1)?.value ?? null;
  const previous = keyframes[next - 1];
  const upcoming = keyframes[next];
  if (upcoming === undefined) return null;
  return previous === undefined ? upcoming.value : between(previous, upcoming, beat);
}

/** A lane's keyframes in beat order, each with its index in the lane (keyframes at one beat keep their order). */
export function orderedKeyframes(lane: Lane): { readonly index: number; readonly keyframe: Keyframe }[] {
  return lane.keyframes.map((keyframe, index) => ({ index, keyframe })).sort((a, b) => a.keyframe.beat - b.keyframe.beat);
}

/** The index of a track's volume lane (the first, if there are more), or -1. */
export function volumeLaneIndex(transition: Pick<Transition, "lanes">, track: LaneTrack): number {
  return transition.lanes.findIndex((lane) => lane.track === track && lane.param === "volume");
}

/**
 * A track's level at `beat` from its volume lane, at the beat or just before it. A track without one
 * plays at full level.
 */
export function trackVolume(transition: Pick<Transition, "lanes">, track: LaneTrack, beat: number, when: "at" | "before" = "at"): number {
  const lane = transition.lanes[volumeLaneIndex(transition, track)];
  if (lane === undefined) return 1;
  const keyframes = orderedKeyframes(lane).map(({ keyframe }) => keyframe);
  return (when === "at" ? valueAt(keyframes, beat) : valueBefore(keyframes, beat)) ?? 1;
}

/** Whether a track can be heard at `beat`, just before it or at it. */
export function heard(transition: Pick<Transition, "lanes">, track: LaneTrack, beat: number): boolean {
  return Math.max(trackVolume(transition, track, beat, "before"), trackVolume(transition, track, beat)) > 0;
}

/** The same, just before `beat`: a jump at exactly that beat has not happened yet. */
export function valueBefore(keyframes: readonly Keyframe[], beat: number): number | null {
  const next = keyframes.findIndex((keyframe) => keyframe.beat >= beat);
  if (next === -1) return keyframes.at(-1)?.value ?? null;
  const previous = keyframes[next - 1];
  const upcoming = keyframes[next];
  if (upcoming === undefined) return null;
  return previous === undefined ? upcoming.value : between(previous, upcoming, beat);
}
