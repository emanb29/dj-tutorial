// Arithmetic on a Transition's lanes for the Execution plan: where each lane starts, its value at a
// beat, and where phrases start. The plan's types are shared/mix-plan.ts's (the stored schema); this
// file only reads them.
//
// Where a lane starts: before its first keyframe a lane holds its resting value (`restingValue`: the
// outgoing track at full, the incoming one silent, everything else flat), and tempo, which has none,
// starts at its first keyframe. The incoming track is not playing before the Transition, so its
// continuous controls (fader, EQ, filter, tempo) can be set anywhere in the set-up: an incoming
// keyframe at beat 0 or before is where that control starts, not a move. The outgoing track is heard
// up to beat 0, so a keyframe of its own at beat 0 is a move on the 1. Buttons (echo, loop) always
// start off and are pressed where they turn on. A first keyframe that ramps ramps from beat 0.

import { BEATS_PER_PHRASE, beatIndexOf, type Keyframe, type Lane, type LaneParam, restingValue, type Transition } from "@shared/mix-plan.ts";

export type LaneTrack = Lane["track"];

/** A keyframe with its index in its lane. */
export interface LaneEntry {
  readonly index: number;
  readonly keyframe: Keyframe;
}

export interface LaneTimeline {
  /** Where the lane's control is when the Transition starts. */
  readonly startValue: number;
  /** The keyframes (indices) that starting position realises: incoming ones at beat 0 or before, and tempo's first. */
  readonly absorbed: readonly number[];
  /** The rest, in beat order: each one a move (or a hold) from the one before. */
  readonly moves: readonly LaneEntry[];
  /** The start as a keyframe at beat 0 (or the first keyframe's beat, if earlier), then the moves: what `valueAt` reads. */
  readonly keyframes: readonly Keyframe[];
}

const BUTTON_PARAMS: ReadonlySet<LaneParam> = new Set(["echo-send", "loop"]);

/** Whether a Transition beat lands on a phrase start of the outgoing track (every 8 bars from bar 1). */
export function isPhraseStart(transition: Pick<Transition, "outgoingAt">, beat: number): boolean {
  const onGrid = beatIndexOf(transition.outgoingAt) + beat;
  return Number.isInteger(onGrid) && onGrid % BEATS_PER_PHRASE === 0;
}

/** Whether a keyframe is reached at once: a jump, or a ramp with no length. */
export function isJump(previous: Keyframe, keyframe: Keyframe): boolean {
  return keyframe.curve === "jump" || keyframe.beat <= previous.beat;
}

/** A lane's keyframes in beat order, each with its index in the lane (keyframes at one beat keep their order). */
export function orderedKeyframes(lane: Lane): LaneEntry[] {
  return lane.keyframes.map((keyframe, index) => ({ index, keyframe })).sort((a, b) => a.keyframe.beat - b.keyframe.beat);
}

/** Where a lane starts and the moves after it; null for a tempo lane with no keyframes (nothing to set). */
export function laneTimeline(lane: Lane): LaneTimeline | null {
  const ordered = orderedKeyframes(lane);
  const first = ordered[0];
  if (lane.param === "tempo" && first === undefined) return null;
  const setFreely = lane.param === "tempo" || (lane.track === "incoming" && !BUTTON_PARAMS.has(lane.param));
  const leading = setFreely ? ordered.filter(({ keyframe }) => keyframe.beat <= 0) : [];
  const absorbed = lane.param === "tempo" && leading.length === 0 && first !== undefined ? [first] : leading;
  const last = absorbed.at(-1);
  let startValue: number;
  if (last !== undefined) startValue = last.keyframe.value;
  else if (lane.param === "tempo") return null; // Not reached: a tempo lane with keyframes starts at its first.
  else startValue = restingValue(lane.track, lane.param);
  const moves = ordered.slice(absorbed.length);
  const start: Keyframe = { beat: Math.min(0, first?.keyframe.beat ?? 0), value: startValue, curve: "jump" };
  return { startValue, absorbed: absorbed.map(({ index }) => index), moves, keyframes: [start, ...moves.map(({ keyframe }) => keyframe)] };
}

const ease = (x: number) => x * x * (3 - 2 * x);

function between(previous: Keyframe, next: Keyframe, beat: number): number {
  if (isJump(previous, next)) return previous.value;
  const x = (beat - previous.beat) / (next.beat - previous.beat);
  const shaped = next.curve === "ease" ? ease(x) : x;
  return previous.value + (next.value - previous.value) * shaped;
}

/**
 * The value at `beat` of keyframes in beat order, counting a keyframe at exactly that beat (a jump
 * there has happened). Before the first keyframe, the first's value.
 */
export function valueAt(keyframes: readonly Keyframe[], beat: number): number | null {
  const next = keyframes.findIndex((keyframe) => keyframe.beat > beat);
  if (next === -1) return keyframes.at(-1)?.value ?? null;
  const previous = keyframes[next - 1];
  const upcoming = keyframes[next];
  if (upcoming === undefined) return null;
  return previous === undefined ? upcoming.value : between(previous, upcoming, beat);
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

/** The index of a track's volume lane (the first, if there are more), or -1. */
export function volumeLaneIndex(transition: Pick<Transition, "lanes">, track: LaneTrack): number {
  return transition.lanes.findIndex((lane) => lane.track === track && lane.param === "volume");
}

/** A track's level at `beat` (or just before it) from its volume lane; at rest without one. */
export function trackVolume(transition: Pick<Transition, "lanes">, track: LaneTrack, beat: number, when: "at" | "before" = "at"): number {
  const lane = transition.lanes[volumeLaneIndex(transition, track)];
  const timeline = lane === undefined ? null : laneTimeline(lane);
  if (timeline === null) return restingValue(track, "volume");
  return (when === "at" ? valueAt(timeline.keyframes, beat) : valueBefore(timeline.keyframes, beat)) ?? restingValue(track, "volume");
}

/** Whether a track can be heard at `beat`, just before it or at it. */
export function heard(transition: Pick<Transition, "lanes">, track: LaneTrack, beat: number): boolean {
  return Math.max(trackVolume(transition, track, beat, "before"), trackVolume(transition, track, beat)) > 0;
}
