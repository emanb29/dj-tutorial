// The Render's timeline (ISS-190): where each track of a Mix Plan plays in the set, in set seconds,
// worked out from the plan's beat positions, the tracks' beat grids, and its tempo and loop lanes.
// Pure. The track pass (track-pass.ts) renders each track's playback from it, and the mix pass
// (mix-pass.ts) places those renders on the decks; neither works out any timing of its own.
//
// How a set plays (as a DJ plays it, and as the Execution plan assumes):
// - Track 1 plays at its own tempo from its `startAt`.
// - Each Transition starts when the outgoing track reaches `outgoingAt`. The incoming track starts
//   there from `incomingAt`, matched to the outgoing track's heard tempo, beat for beat, unless its
//   tempo lane says otherwise. Transition beats are the outgoing track's heard beats.
// - After its Transition, the incoming track carries on at the tempo it reached, and leads the next.
// - The outgoing track stops once its Transition ends if it is silent by then, else when its deck is
//   needed for the next track (the next Transition's start), or at its end.
// - A loop holds `loopBeats` of the track from where it turns on, and plays straight on when it ends.
import type { DeckId } from "@audio/types.ts";
import { laneTimeline, trackVolume, valueAt } from "@app/mix-editor/lanes.ts";
import { deckOf } from "@app/mix-plans/deck-layout.ts";
import { beatIndexOf, secondsAtBeat, type Keyframe, type Lane, type MixPlan, type PlanGrid } from "@shared/mix-plan.ts";

/** A stretch of a track played at one rate, in set seconds. */
export interface PlaybackPiece {
  readonly fromSec: number;
  readonly toSec: number;
  /** The track position at `fromSec`, seconds. */
  readonly trackSec: number;
  /** Track seconds per set second: 1 is the track's own tempo. */
  readonly rate: number;
}

export interface TrackPlayback {
  readonly index: number;
  readonly deck: DeckId;
  /** When it starts playing, set seconds. */
  readonly enterSec: number;
  /** When it stops, set seconds. */
  readonly stopSec: number;
  /** In time order, covering enterSec to stopSec. A jump in `trackSec` between two pieces is a loop. */
  readonly pieces: readonly PlaybackPiece[];
}

/** A Transition beat (from `outgoingAt`) at a set time, and both tracks' heard BPM over the step that ends there (at beat 0: as it starts). */
export interface BeatPoint {
  readonly beat: number;
  readonly sec: number;
  readonly outgoingBpm: number;
  readonly incomingBpm: number;
}

export interface TransitionTiming {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  /** From beat 0 to the Transition's length, in beat order. */
  readonly points: readonly BeatPoint[];
}

export interface SetTimeline {
  /** The whole set, set seconds, with a short tail after the last track stops. */
  readonly durationSec: number;
  readonly tracks: readonly TrackPlayback[];
  readonly transitions: readonly TransitionTiming[];
}

export interface TimelineProblem {
  readonly message: string;
  readonly fix: string;
}

export type TimelineOutcome = { readonly ok: true; readonly timeline: SetTimeline } | { readonly ok: false; readonly problems: readonly TimelineProblem[] };

/** A tempo ramp is played as steps this many beats long (the spike's advice was one a beat). */
export const TEMPO_STEP_BEATS = 1 / 4;
/** After the last track stops: room for the mixer's last glide. */
export const SET_TAIL_SEC = 0.5;
/** A silent outgoing track plays on this long after its Transition, so nothing it holds is cut. */
const SILENT_STOP_AFTER_SEC = 0.05;
const EPSILON = 1e-9;

interface Cursor {
  readonly index: number;
  readonly grid: PlanGrid;
  readonly enterSec: number;
  trackSec: number;
  rate: number;
  loop: { readonly startSec: number; readonly endSec: number } | null;
  /** Set time it stops; null while it plays on. */
  stopAt: number | null;
  stopped: boolean;
  /** Whether it ran out of track while it was still meant to play. */
  ranOut: boolean;
  readonly pieces: PlaybackPiece[];
}

const heardBpm = (cursor: Cursor) => cursor.grid.bpm * cursor.rate;

function addPiece(cursor: Cursor, fromSec: number, seconds: number): void {
  const last = cursor.pieces.at(-1);
  const contiguous = last !== undefined && Math.abs(last.toSec - fromSec) < EPSILON && Math.abs(last.trackSec + (last.toSec - last.fromSec) * last.rate - cursor.trackSec) < 1e-7;
  if (contiguous && Math.abs(last.rate - cursor.rate) < EPSILON) {
    cursor.pieces[cursor.pieces.length - 1] = { ...last, toSec: fromSec + seconds };
  } else {
    cursor.pieces.push({ fromSec, toSec: fromSec + seconds, trackSec: cursor.trackSec, rate: cursor.rate });
  }
}

/** The set's clock and the tracks playing on it. */
class SetClock {
  now = 0;
  readonly live: Cursor[] = [];

  /** Plays every live track for `seconds`, wrapping loops, and stopping tracks at their stop time or end. */
  run(seconds: number): void {
    let remaining = seconds;
    while (remaining > EPSILON) {
      let chunk = remaining;
      for (const cursor of this.live) {
        if (cursor.stopAt !== null) chunk = Math.min(chunk, cursor.stopAt - this.now);
        const limit = Math.min(cursor.grid.durationSec, cursor.loop?.endSec ?? Number.POSITIVE_INFINITY);
        chunk = Math.min(chunk, (limit - cursor.trackSec) / cursor.rate);
      }
      chunk = Math.max(0, chunk);
      for (const cursor of this.live) {
        if (chunk > 0) addPiece(cursor, this.now, chunk);
        cursor.trackSec += chunk * cursor.rate;
      }
      this.now += chunk;
      remaining -= chunk;
      for (const cursor of [...this.live]) {
        if (cursor.loop !== null && cursor.trackSec >= cursor.loop.endSec - 1e-7) cursor.trackSec = cursor.loop.startSec;
        const ended = cursor.trackSec >= cursor.grid.durationSec - 1e-7;
        const due = cursor.stopAt !== null && this.now >= cursor.stopAt - EPSILON;
        if (ended || due) {
          cursor.ranOut = ended && !due;
          this.stop(cursor);
        }
      }
    }
  }

  stop(cursor: Cursor): void {
    cursor.stopped = true;
    cursor.stopAt = this.now;
    this.live.splice(this.live.indexOf(cursor), 1);
  }
}

const laneOf = (lanes: readonly Lane[], track: Lane["track"], param: Lane["param"]) => lanes.find((lane) => lane.track === track && lane.param === param);

/** The tempo lane's keyframes as `valueAt` reads them, or null without one. */
function tempoKeyframes(lanes: readonly Lane[], track: Lane["track"]): readonly Keyframe[] | null {
  const lane = laneOf(lanes, track, "tempo");
  return lane === undefined ? null : (laneTimeline(lane)?.keyframes ?? null);
}

/** Where a loop lane turns on and off, by beat (later changes at one beat win). */
function loopChanges(lanes: readonly Lane[], track: Lane["track"]): { readonly beat: number; readonly on: boolean; readonly beats: number }[] {
  const lane = laneOf(lanes, track, "loop");
  if (lane === undefined) return [];
  const timeline = laneTimeline(lane);
  const beats = lane.loopBeats ?? 4;
  return (timeline?.moves ?? []).map(({ keyframe }) => ({ beat: keyframe.beat, on: keyframe.value > 0, beats }));
}

const n = (index: number) => String(index + 1);

/**
 * Where every track of `plan` plays, given each track's beat grid in plan order. A grid's
 * `durationSec` is the track's length as decoded. Problems are what the Render cannot play: a plan
 * that also passes `mixPlanProblems` has none of them, except loops left on.
 */
export function setTimeline(plan: MixPlan, grids: readonly PlanGrid[]): TimelineOutcome {
  const problems: TimelineProblem[] = [];
  const clock = new SetClock();
  const cursors: Cursor[] = [];
  const transitions: TransitionTiming[] = [];

  const enter = (index: number, trackSec: number, rate: number): Cursor | null => {
    const grid = grids[index];
    if (grid === undefined) return null;
    const cursor: Cursor = { index, grid, enterSec: clock.now, trackSec, rate, loop: null, stopAt: null, stopped: false, ranOut: false, pieces: [] };
    if (trackSec >= grid.durationSec) {
      problems.push({ message: `Track ${n(index)} starts after its end.`, fix: "Pick an earlier cue for it." });
      return null;
    }
    cursors.push(cursor);
    clock.live.push(cursor);
    return cursor;
  };

  const firstTrack = plan.tracks[0];
  const firstGrid = grids[0];
  if (firstTrack === undefined || firstGrid === undefined || grids.length !== plan.tracks.length || plan.transitions.length !== plan.tracks.length - 1) {
    return { ok: false, problems: [{ message: "The plan needs at least one track, a beat grid for each, and one Transition between each pair.", fix: "Find every track, then render again." }] };
  }
  const first = enter(0, secondsAtBeat(firstGrid, beatIndexOf(firstTrack.startAt)), 1);
  if (first === null) return { ok: false, problems };
  let outgoing: Cursor = first;
  /** The track before the outgoing one, still playing until its deck is needed. */
  let previous: Cursor | null = null;

  for (const [index, transition] of plan.transitions.entries()) {
    const target = secondsAtBeat(outgoing.grid, beatIndexOf(transition.outgoingAt));
    if (outgoing.loop !== null) {
      problems.push({ message: `Track ${n(index)} is still looping when Transition ${n(index)} should start, so it never gets there.`, fix: `End its loop in Transition ${String(index)}.` });
      return { ok: false, problems };
    }
    const lead = (target - outgoing.trackSec) / outgoing.rate;
    if (lead < -1e-6) {
      problems.push({ message: `Transition ${n(index)} starts before track ${n(index)} is heard there.`, fix: "Move it later." });
      return { ok: false, problems };
    }
    if (previous !== null && !previous.stopped) previous.stopAt = Math.min(previous.stopAt ?? Number.POSITIVE_INFINITY, clock.now + Math.max(0, lead));
    clock.run(Math.max(0, lead));
    if (outgoing.stopped) {
      problems.push({ message: `Track ${n(index)} ends before Transition ${n(index)} starts.`, fix: "Start the Transition earlier." });
      return { ok: false, problems };
    }
    // The track before plays on until here at most: its deck takes the incoming track now.
    if (previous !== null && !previous.stopped) clock.stop(previous);

    const startSec = clock.now;
    const outgoingBase = heardBpm(outgoing);
    const incomingGrid = grids[index + 1];
    if (incomingGrid === undefined) return { ok: false, problems };
    const incoming = enter(index + 1, secondsAtBeat(incomingGrid, beatIndexOf(transition.incomingAt)), outgoingBase / incomingGrid.bpm);
    if (incoming === null) return { ok: false, problems };

    const outgoingTempo = tempoKeyframes(transition.lanes, "outgoing");
    const incomingTempo = tempoKeyframes(transition.lanes, "incoming");
    const ramps = outgoingTempo !== null || incomingTempo !== null;
    const loops = [
      ...loopChanges(transition.lanes, "outgoing").map((change) => ({ ...change, cursor: outgoing })),
      ...loopChanges(transition.lanes, "incoming").map((change) => ({ ...change, cursor: incoming })),
    ].sort((a, b) => a.beat - b.beat);
    const length = transition.lengthBeats;
    const bpmsAt = (beat: number) => {
      const outgoingBpm = outgoingTempo === null ? outgoingBase : (valueAt(outgoingTempo, beat) ?? outgoingBase);
      const incomingBpm = incomingTempo === null ? outgoingBpm : (valueAt(incomingTempo, beat) ?? outgoingBpm);
      return { outgoingBpm, incomingBpm };
    };
    const points: BeatPoint[] = [{ beat: 0, sec: startSec, ...bpmsAt(0) }];
    let beat = 0;
    const applyLoops = (at: number) => {
      for (const change of loops.filter((each) => Math.abs(each.beat - at) < 1e-9)) {
        const { cursor } = change;
        cursor.loop = change.on ? { startSec: cursor.trackSec, endSec: cursor.trackSec + (change.beats * 60) / cursor.grid.bpm } : null;
      }
    };
    applyLoops(0);
    while (beat < length - EPSILON) {
      const nextLoop = loops.find((change) => change.beat > beat + EPSILON)?.beat ?? Number.POSITIVE_INFINITY;
      const nextStep = ramps ? (Math.floor(beat / TEMPO_STEP_BEATS + EPSILON) + 1) * TEMPO_STEP_BEATS : Number.POSITIVE_INFINITY;
      const next = Math.min(length, nextLoop, nextStep);
      const bpms = bpmsAt((beat + next) / 2);
      outgoing.rate = bpms.outgoingBpm / outgoing.grid.bpm;
      incoming.rate = bpms.incomingBpm / incoming.grid.bpm;
      clock.run(((next - beat) * 60) / bpms.outgoingBpm);
      beat = next;
      points.push({ beat, sec: clock.now, ...bpms });
      applyLoops(beat);
      if (incoming.stopped) {
        problems.push({ message: `Track ${n(index + 1)} ends during Transition ${n(index)}.`, fix: "Pick an earlier cue in it, or shorten the Transition." });
        return { ok: false, problems };
      }
    }
    const endSec = clock.now;
    transitions.push({ index, startSec, endSec, points });

    // The incoming track leads now; the outgoing one stops once silent, else when its deck is needed.
    if (clock.live.includes(outgoing)) {
      const silent = trackVolume(transition, "outgoing", length) === 0;
      outgoing.stopAt = silent ? endSec + SILENT_STOP_AFTER_SEC : null;
    }
    previous = outgoing;
    outgoing = incoming;
  }

  // The last track plays to its end; the one before it to its stop.
  if (outgoing.loop !== null) {
    problems.push({ message: `The last track is still looping when the last Transition ends, so the set would never end.`, fix: "End its loop in the last Transition." });
    return { ok: false, problems };
  }
  while (clock.live.length > 0) clock.run(Math.max(...clock.live.map((cursor) => (cursor.grid.durationSec - cursor.trackSec) / cursor.rate)) + 1);

  const tracks: TrackPlayback[] = cursors.map((cursor) => ({
    index: cursor.index,
    deck: deckOf(cursor.index),
    enterSec: cursor.enterSec,
    stopSec: cursor.stopAt ?? clock.now,
    pieces: cursor.pieces,
  }));
  const durationSec = Math.max(...tracks.map((track) => track.stopSec)) + SET_TAIL_SEC;
  return { ok: true, timeline: { durationSec, tracks, transitions } };
}

/** The set time of a Transition beat. Outside the Transition, the nearest end's tempo carries on. */
export function secAtBeat(timing: TransitionTiming, beat: number): number {
  const { points } = timing;
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return timing.startSec;
  if (beat <= first.beat) return first.sec + ((beat - first.beat) * 60) / first.outgoingBpm;
  if (beat >= last.beat) return last.sec + ((beat - last.beat) * 60) / last.outgoingBpm;
  const after = points.findIndex((point) => point.beat >= beat);
  const upper = points[after];
  const lower = points[after - 1];
  if (upper === undefined || lower === undefined) return last.sec;
  return lower.sec + ((upper.sec - lower.sec) * (beat - lower.beat)) / (upper.beat - lower.beat);
}

/** A track's heard BPM at a Transition beat (at a step's end, the step's own). */
export function bpmAtBeat(timing: TransitionTiming, beat: number, track: Lane["track"]): number {
  const point = beat <= 0 ? timing.points[0] : (timing.points.find((each) => each.beat >= beat) ?? timing.points.at(-1));
  if (point === undefined) throw new Error("A TransitionTiming always has a point at beat 0: build it with setTimeline.");
  return track === "outgoing" ? point.outgoingBpm : point.incomingBpm;
}
