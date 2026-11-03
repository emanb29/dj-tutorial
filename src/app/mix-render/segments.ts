// Where the Render cuts the set into segments (ISS-190): about every 2 minutes, but only where
// nothing moves, so each segment can start from a snapshot of the mixer and lose nothing. "Nothing
// moves" means no mixer move (a ramp is a move every few ms), no track starting or stopping, and no
// echo still ringing, for a margin either side, plus the pre-roll a segment plays before its cut.
// Pure.
import { controlKey, type TimedCommand } from "./commands.ts";
import type { SetTimeline } from "./timeline.ts";

/** A segment, as set frames: [fromFrame, toFrame). */
export interface Segment {
  readonly fromFrame: number;
  readonly toFrame: number;
}

export const SEGMENT_TARGET_SEC = 120;
/** No segment shorter than this, unless the set is. */
export const SEGMENT_MIN_SEC = 20;
/** A segment starts this long before its cut, from the snapshot there, and drops it: the mixer's filters settle in it. */
export const PREROLL_SEC = 0.25;
/** Nothing moves this close to a cut. */
const MARGIN_SEC = 0.1;
/** An echo turned off rings on for this many repeats (about −36 dB at ECHO_FEEDBACK 0.5). */
const ECHO_TAIL_REPEATS = 6;

type Span = readonly [number, number];

function merged(spans: readonly Span[]): Span[] {
  const out: [number, number][] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** When something moves, padded so a cut outside these spans and its pre-roll see nothing move. */
export function busySpans(timeline: SetTimeline, commands: readonly TimedCommand[]): Span[] {
  const spans: Span[] = [];
  const around = (from: number, to: number) => spans.push([from - MARGIN_SEC, to + MARGIN_SEC + PREROLL_SEC]);
  for (const track of timeline.tracks) {
    around(track.enterSec, track.enterSec);
    around(track.stopSec, track.stopSec);
  }
  let echoOnSince: number | null = null;
  let beats = 1;
  let bpm = 120;
  for (const { atSec, command } of commands) {
    if (atSec > 0) around(atSec, atSec);
    if (command.control === "beat-fx-beats") beats = command.value;
    if (command.control === "beat-fx-bpm" && command.value !== null) bpm = command.value;
    if (command.control === "beat-fx") {
      if (command.value) echoOnSince ??= atSec;
      else if (echoOnSince !== null) {
        around(echoOnSince, atSec + ECHO_TAIL_REPEATS * Math.min(4, (beats * 60) / bpm));
        echoOnSince = null;
      }
    }
  }
  if (echoOnSince !== null) around(echoOnSince, timeline.durationSec);
  return merged(spans);
}

/** The set cut into segments of about `targetSec`, each cut where nothing moves. */
export function planSegments(timeline: SetTimeline, commands: readonly TimedCommand[], sampleRate: number, targetSec = SEGMENT_TARGET_SEC): Segment[] {
  const end = timeline.durationSec;
  const busy = busySpans(timeline, commands);
  // The quiet spans between busy ones, where a cut may go.
  const quiet: Span[] = [];
  let from = 0;
  for (const [busyFrom, busyTo] of busy) {
    if (busyFrom > from) quiet.push([from, busyFrom]);
    from = Math.max(from, busyTo);
  }
  if (from < end) quiet.push([from, end]);

  const cuts: number[] = [];
  let start = 0;
  for (;;) {
    const want = start + targetSec;
    if (want >= end - SEGMENT_MIN_SEC) break;
    const earliest = start + SEGMENT_MIN_SEC;
    const candidates = quiet.flatMap(([a, b]) => {
      const low = Math.max(a, earliest);
      return low < Math.min(b, end - SEGMENT_MIN_SEC) ? [Math.min(Math.max(want, low), b)] : [];
    });
    const best = candidates.reduce<number | null>((chosen, candidate) => (chosen === null || Math.abs(candidate - want) < Math.abs(chosen - want) ? candidate : chosen), null);
    if (best === null) break;
    cuts.push(best);
    start = best;
  }
  const totalFrames = Math.ceil(end * sampleRate);
  const edges = [0, ...cuts.map((cut) => Math.round(cut * sampleRate)), totalFrames];
  return edges.slice(0, -1).map((fromFrame, index) => ({ fromFrame, toFrame: edges[index + 1] ?? totalFrames }));
}

/** Whether a control keeps moving across `sec`: used by tests to show a cut is quiet. */
export function movesAround(commands: readonly TimedCommand[], sec: number, withinSec: number): string[] {
  return commands.filter(({ atSec }) => atSec > 0 && Math.abs(atSec - sec) < withinSec).map(({ command }) => controlKey(command));
}
