// What a Transition's preview plays, as numbers: which part of each track's audio plays when (loops are
// repeated parts), and every sound parameter as points to ramp between, from 1 phrase before the
// Transition to 1 phrase after. Pure, so it is tested without audio; preview-audio.ts turns it into
// Web Audio nodes and automation.
//
// The preview is the Transition alone, in software, so it can follow edits at once: the outgoing track
// plays at its own tempo and the incoming one is matched to it (a tempo lane rides it). Values use the
// mixer's own curves (src/audio/curves.ts): volume is the channel fader with the crossfader left out,
// EQ the isolator's dB, the filter the CFX knob's cutoff. It is a preview, not the Render (ISS-190):
// a track with both a loop and a tempo lane plays its loop at the matched tempo.
import { channelFaderGain, eqKnobToDecibels, filterKnobSettings } from "@audio/curves.ts";
import { beatIndexOf, restingValue, secondsAtBeat, type Lane, type LaneParam, type PlanGrid, type Transition } from "@shared/mix-plan.ts";
import { laneTimeline, valueAt, valueBefore, type LaneTrack } from "./lanes.ts";
import { transitionFocus, type BeatSpan } from "./timeline.ts";

/** How often a moving lane is sampled, beats: ramps between samples are linear. */
export const SAMPLE_BEATS = 1 / 4;
/** An EQ kill, dB: a shelf cannot take −∞. */
export const KILL_DB = -60;
export const FILTER_OPEN_LOW_PASS_HZ = 20_000;
export const FILTER_OPEN_HIGH_PASS_HZ = 10;
/** Beat FX ECHO's feedback (src/audio/beat-fx.ts ECHO_FEEDBACK). */
export const PREVIEW_ECHO_FEEDBACK = 0.5;

export interface ParamPoint {
  readonly beat: number;
  readonly value: number;
}

/** One stretch of a track's audio: from `startBeat` to `endBeat` (Transition beats), starting `offsetSec` into the file. */
export interface SourceSegment {
  readonly startBeat: number;
  readonly endBeat: number;
  readonly offsetSec: number;
}

export interface TrackSchedule {
  readonly segments: readonly SourceSegment[];
  readonly rate: readonly ParamPoint[];
  /** Amplitude after the channel fader. */
  readonly gain: readonly ParamPoint[];
  readonly lowDb: readonly ParamPoint[];
  readonly midDb: readonly ParamPoint[];
  readonly highDb: readonly ParamPoint[];
  readonly lowPassHz: readonly ParamPoint[];
  readonly highPassHz: readonly ParamPoint[];
  /** Echo wet, 0…1, taken after the fader so a cut lets the echo ring out. */
  readonly echoSend: readonly ParamPoint[];
  readonly echoDelaySec: number | null;
}

export interface PreviewSchedule {
  /** Seconds per Transition beat: the outgoing track's own tempo. */
  readonly secPerBeat: number;
  readonly fromBeat: number;
  readonly toBeat: number;
  readonly outgoing: TrackSchedule;
  readonly incoming: TrackSchedule;
}

export interface PreviewGrids {
  readonly outgoing: PlanGrid;
  readonly incoming: PlanGrid;
}

function laneOf(transition: Transition, track: LaneTrack, param: LaneParam): Lane | undefined {
  return transition.lanes.find((lane) => lane.track === track && lane.param === param);
}

/** Drops points that only repeat the value on both sides, so a still lane is two points. */
function compress(points: readonly ParamPoint[]): ParamPoint[] {
  return points.filter((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];
    return before === undefined || after === undefined || before.value !== point.value || after.value !== point.value;
  });
}

/** A lane's values over `span`, mapped through `toParam`: samples every SAMPLE_BEATS, and both sides of every keyframe (so a jump is a jump). */
function sampled(lane: Lane | undefined, span: BeatSpan, resting: number, toParam: (value: number) => number): ParamPoint[] {
  const timeline = lane === undefined ? null : laneTimeline(lane);
  if (timeline === null) {
    const value = toParam(resting);
    return [
      { beat: span.fromBeat, value },
      { beat: span.toBeat, value },
    ];
  }
  const beats = new Set<number>();
  for (let beat = span.fromBeat; beat < span.toBeat; beat += SAMPLE_BEATS) beats.add(beat);
  beats.add(span.toBeat);
  const points: ParamPoint[] = [];
  const keyBeats = new Set(timeline.keyframes.map((keyframe) => keyframe.beat).filter((beat) => beat > span.fromBeat && beat < span.toBeat));
  for (const beat of [...new Set([...beats, ...keyBeats])].sort((a, b) => a - b)) {
    if (keyBeats.has(beat)) points.push({ beat, value: toParam(valueBefore(timeline.keyframes, beat) ?? resting) });
    points.push({ beat, value: toParam(valueAt(timeline.keyframes, beat) ?? resting) });
  }
  return compress(points.filter((point, index) => index === 0 || points[index - 1]?.beat !== point.beat || points[index - 1]?.value !== point.value));
}

/** Where a loop lane holds the loop, Transition beats. */
function loopSpans(lane: Lane | undefined): { readonly from: number; readonly to: number }[] {
  const timeline = lane === undefined ? null : laneTimeline(lane);
  if (timeline === null) return [];
  const spans: { from: number; to: number }[] = [];
  let since: number | null = null;
  for (const keyframe of timeline.keyframes) {
    if (keyframe.value >= 0.5 && since === null) since = keyframe.beat;
    else if (keyframe.value < 0.5 && since !== null) {
      if (keyframe.beat > since) spans.push({ from: since, to: keyframe.beat });
      since = null;
    }
  }
  if (since !== null) spans.push({ from: since, to: Number.POSITIVE_INFINITY });
  return spans;
}

/**
 * The parts of a track that play in `span`. `positionAt` is the track time of a Transition beat at the
 * matched tempo; a loop repeats the `loopBeats` after it starts until it ends, then the track plays on
 * from where the loop was.
 */
function segmentsOf(span: BeatSpan, startBeat: number, positionAt: (beat: number) => number, loop: Lane | undefined): SourceSegment[] {
  const loopBeats = loop?.loopBeats ?? 0;
  const pieces: { startBeat: number; endBeat: number; fromTrackBeat: number }[] = [];
  let cursor = startBeat;
  let trackBeat = startBeat;
  for (const held of loopBeats > 0 ? loopSpans(loop) : []) {
    if (held.from >= span.toBeat || held.from < cursor) continue;
    pieces.push({ startBeat: cursor, endBeat: held.from, fromTrackBeat: trackBeat });
    const until = Math.min(held.to, span.toBeat);
    for (let at = held.from; at < until; at += loopBeats) pieces.push({ startBeat: at, endBeat: Math.min(at + loopBeats, until), fromTrackBeat: held.from });
    cursor = until;
    trackBeat = held.from + ((until - held.from) % loopBeats);
  }
  pieces.push({ startBeat: cursor, endBeat: span.toBeat, fromTrackBeat: trackBeat });
  return pieces.flatMap((piece) => {
    const from = Math.max(piece.startBeat, span.fromBeat);
    const to = Math.min(piece.endBeat, span.toBeat);
    if (to <= from) return [];
    const offsetSec = positionAt(piece.fromTrackBeat + (from - piece.startBeat));
    return offsetSec < 0 ? [] : [{ startBeat: from, endBeat: to, offsetSec }];
  });
}

function trackSchedule(transition: Transition, track: LaneTrack, span: BeatSpan, grid: PlanGrid, matchedBpm: number): TrackSchedule {
  const onGrid = beatIndexOf(track === "outgoing" ? transition.outgoingAt : transition.incomingAt);
  const lane = (param: LaneParam) => laneOf(transition, track, param);
  const rest = (param: Exclude<LaneParam, "tempo">) => restingValue(track, param);
  // The incoming track starts with PLAY at beat 0, as the Execution plan does.
  const startBeat = track === "outgoing" ? span.fromBeat : Math.max(0, span.fromBeat);
  const playing: BeatSpan = { fromBeat: startBeat, toBeat: span.toBeat };
  const echo = lane("echo-send");
  const eq = (value: number) => Math.max(KILL_DB, eqKnobToDecibels(value));
  const filter = (kind: "lowpass" | "highpass") => (value: number) => {
    const settings = filterKnobSettings(value);
    if (settings.kind === kind) return settings.cutoffHz;
    return kind === "lowpass" ? FILTER_OPEN_LOW_PASS_HZ : FILTER_OPEN_HIGH_PASS_HZ;
  };
  return {
    segments: startBeat >= span.toBeat ? [] : segmentsOf(span, startBeat, (beat) => secondsAtBeat(grid, onGrid + beat), lane("loop")),
    rate: sampled(lane("tempo"), playing, matchedBpm, (bpm) => bpm / grid.bpm),
    gain: sampled(lane("volume"), span, rest("volume"), (value) => (value <= 0 ? 0 : channelFaderGain(value))),
    lowDb: sampled(lane("eq-low"), span, rest("eq-low"), eq),
    midDb: sampled(lane("eq-mid"), span, rest("eq-mid"), eq),
    highDb: sampled(lane("eq-high"), span, rest("eq-high"), eq),
    lowPassHz: sampled(lane("filter"), span, rest("filter"), filter("lowpass")),
    highPassHz: sampled(lane("filter"), span, rest("filter"), filter("highpass")),
    echoSend: sampled(echo, span, rest("echo-send"), (value) => value),
    echoDelaySec: echo?.echoBeats === undefined ? null : (echo.echoBeats * 60) / matchedBpm,
  };
}

/** The preview of `transition` over `span` (by default 1 phrase before it to 1 phrase after). */
export function previewSchedule(transition: Transition, grids: PreviewGrids, span: BeatSpan = transitionFocus(transition)): PreviewSchedule {
  const bpm = grids.outgoing.bpm;
  return {
    secPerBeat: 60 / bpm,
    fromBeat: span.fromBeat,
    toBeat: span.toBeat,
    outgoing: trackSchedule(transition, "outgoing", span, grids.outgoing, bpm),
    incoming: trackSchedule(transition, "incoming", span, grids.incoming, bpm),
  };
}

/** A parameter's value at `beat` from its points (linear between them; after a jump, the new value). */
export function pointValueAt(points: readonly ParamPoint[], beat: number): number | null {
  const next = points.findIndex((point) => point.beat > beat);
  if (next === -1) return points.at(-1)?.value ?? null;
  const before = points[next - 1];
  const after = points[next];
  if (after === undefined) return null;
  if (before === undefined) return after.value;
  return before.value + ((after.value - before.value) * (beat - before.beat)) / (after.beat - before.beat);
}
