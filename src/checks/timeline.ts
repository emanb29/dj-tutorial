// Reading the recorded timeline: playheads, beat grids and mixer state at a heard time.
import type {
  BeatGrid,
  ControlEvent,
  ControlId,
  CtxSpan,
  CtxTime,
  DeckId,
  PlayheadModel,
  PlayheadSegment,
} from "@shared/attempt.ts";
import { at, TIME_EPSILON } from "./measures.ts";

function segmentAt(model: PlayheadModel, t: CtxTime): PlayheadSegment | null {
  let found: PlayheadSegment | null = null;
  for (const segment of model.segments) {
    if (segment.fromCtx > t + TIME_EPSILON) break;
    found = segment;
  }
  return found;
}

/** Track seconds at heard time `t`; `null` before the deck first starts. */
export function positionAt(model: PlayheadModel, t: CtxTime): number | null {
  const segment = segmentAt(model, t);
  return segment === null ? null : segment.pos + segment.rate * (t - segment.fromCtx);
}

export function rateAt(model: PlayheadModel, t: CtxTime): number {
  return segmentAt(model, t)?.rate ?? 0;
}

export function isPlaying(model: PlayheadModel, t: CtxTime): boolean {
  return rateAt(model, t) > 0;
}

/** The first heard time at or after `from` when the deck goes from stopped to playing. */
export function firstPlayStart(model: PlayheadModel, from: CtxTime): CtxTime | null {
  const start = model.segments.find(
    (segment, index) =>
      segment.rate > 0 &&
      segment.fromCtx >= from - TIME_EPSILON &&
      (index === 0 || (model.segments[index - 1]?.rate ?? 0) <= 0),
  );
  return start?.fromCtx ?? null;
}

/** Start of the play run (stopped → playing) that `t` falls in or follows; `null` before any. */
export function playRunStartAt(model: PlayheadModel, t: CtxTime): CtxTime | null {
  const starts = model.segments.filter(
    (segment, index) =>
      segment.rate > 0 && (model.segments[index - 1]?.rate ?? 0) <= 0 && segment.fromCtx <= t + TIME_EPSILON,
  );
  return starts.at(-1)?.fromCtx ?? null;
}

/** `t` when the deck plays then, else the start of its next play run (`t` when there is none). */
export function playingFrom(model: PlayheadModel, t: CtxTime): CtxTime {
  return isPlaying(model, t) ? t : (firstPlayStart(model, t) ?? t);
}

/** Beat phase φ at `t`, in beats from the grid's beat 0; `null` before the deck starts. */
export function beatPhase(model: PlayheadModel, grid: BeatGrid, t: CtxTime): number | null {
  const pos = positionAt(model, t);
  return pos === null ? null : trackBeat(grid, pos);
}

/** Beat index (fractional) of a track position. */
export function trackBeat(grid: BeatGrid, pos: number): number {
  return ((pos - grid.firstBeat) * grid.bpm) / 60;
}

/** A beat's heard length at `t` (track beat length while paused). */
export function beatSeconds(model: PlayheadModel, grid: BeatGrid, t: CtxTime): number {
  const rate = rateAt(model, t);
  return 60 / grid.bpm / (rate > 0 ? rate : 1);
}

export function isDownbeat(grid: BeatGrid, beat: number): boolean {
  return (((beat - grid.downbeatIndex) % 4) + 4) % 4 === 0;
}

export interface HeardBeat {
  readonly ctx: CtxTime;
  readonly beat: number;
  readonly isDownbeat: boolean;
}

interface PlayingStretch {
  readonly segment: PlayheadSegment;
  readonly from: CtxTime;
  readonly to: CtxTime;
}

/** The parts of `span` in which the deck plays, one per playhead segment. */
function playingStretches(model: PlayheadModel, span: CtxSpan): PlayingStretch[] {
  return model.segments.flatMap((segment, index) => {
    const segmentEnd = model.segments[index + 1]?.fromCtx ?? Infinity;
    const from = Math.max(segment.fromCtx, span.from);
    const to = Math.min(segmentEnd, span.to);
    return segment.rate > 0 && to > from ? [{ segment, from, to }] : [];
  });
}

/** Heard time at which a stretch's playhead reaches `pos`. */
function heardAt(segment: PlayheadSegment, pos: number): CtxTime {
  return segment.fromCtx + (pos - segment.pos) / segment.rate;
}

/** Every grid beat the deck plays in `span`, in heard order. */
export function heardBeats(model: PlayheadModel, grid: BeatGrid, span: CtxSpan): HeardBeat[] {
  const beatLength = 60 / grid.bpm;
  return playingStretches(model, span).flatMap(({ segment, from, to }) => {
    const firstBeat = Math.ceil(trackBeat(grid, segment.pos + segment.rate * (from - segment.fromCtx)) - TIME_EPSILON);
    const beats: HeardBeat[] = [];
    for (let beat = firstBeat; ; beat += 1) {
      const ctx = heardAt(segment, grid.firstBeat + beat * beatLength);
      if (ctx >= to - TIME_EPSILON) break;
      beats.push({ ctx, beat, isDownbeat: isDownbeat(grid, beat) });
    }
    return beats;
  });
}

/** Heard times at which the deck plays through any of the track `positions` in `span`. */
export function heardTimesOf(model: PlayheadModel, positions: readonly number[], span: CtxSpan): CtxTime[] {
  return playingStretches(model, span).flatMap(({ segment, from, to }) =>
    positions
      .map((pos) => heardAt(segment, pos))
      .filter((ctx) => ctx >= from - TIME_EPSILON && ctx < to - TIME_EPSILON),
  );
}

function matches(event: ControlEvent, control: ControlId, deck: DeckId | undefined): boolean {
  return event.control === control && event.deck === deck;
}

/** A control's value at `t`: the latest event at or before `t`, else `initial`. */
export function controlValueAt(
  events: readonly ControlEvent[],
  control: ControlId,
  deck: DeckId | undefined,
  t: CtxTime,
  initial: number,
): number {
  let value = initial;
  for (const event of events) {
    if (event.ctx > t + TIME_EPSILON) break;
    if (matches(event, control, deck)) value = event.value;
  }
  return value;
}

/** Events of one control (and deck) inside `span`. */
export function controlEvents(
  events: readonly ControlEvent[],
  control: ControlId,
  deck: DeckId | undefined,
  span: CtxSpan,
): ControlEvent[] {
  return events.filter(
    (event) => matches(event, control, deck) && event.ctx >= span.from - TIME_EPSILON && event.ctx < span.to,
  );
}

/** Events closer together than this belong to one fader gesture. */
export const GESTURE_GAP_S = 0.25;
/** A gesture starts when it has moved this far (fraction of full travel). */
export const GESTURE_START_TRAVEL = 0.1;

/**
 * When the fader move that leads up to `t` started: the first event of that gesture at which it
 * had moved 10% of full travel. A gesture is a run of same-direction events less than 250 ms
 * apart. `null` when no such move leads up to `t`.
 */
export function faderGestureStart(
  events: readonly ControlEvent[],
  control: ControlId,
  /** `undefined` for the crossfader, which has no deck. */
  deck: DeckId | undefined,
  t: CtxTime,
  initial: number,
): CtxTime | null {
  const start = faderGesture(events, control, deck, t, initial)?.travelStart ?? null;
  return start !== null && start <= t + TIME_EPSILON ? start : null;
}

export interface FaderGesture {
  /** The gesture's first movement. */
  readonly firstMove: CtxTime;
  /** The first event at which it had moved 10% of full travel. */
  readonly travelStart: CtxTime;
}

/**
 * The fader gesture leading up to `t` (see `faderGestureStart`), including its moves after `t`;
 * `null` when it never moved 10% of travel. Its `travelStart` may be after `t`.
 */
export function faderGesture(
  events: readonly ControlEvent[],
  control: ControlId,
  deck: DeckId | undefined,
  t: CtxTime,
  initial: number,
): FaderGesture | null {
  const moves = events.filter((event) => matches(event, control, deck) && event.ctx <= t + TIME_EPSILON);
  const last = moves.at(-1);
  if (last === undefined || t - last.ctx > GESTURE_GAP_S) return null;

  const valueBefore = (index: number): number => moves[index - 1]?.value ?? initial;
  const direction = Math.sign(last.value - valueBefore(moves.length - 1));
  let first = moves.length - 1;
  while (first > 0) {
    const previous = moves[first - 1];
    const step = Math.sign(at(moves, first).value - valueBefore(first));
    if (previous === undefined || at(moves, first).ctx - previous.ctx > GESTURE_GAP_S) break;
    if (step !== 0 && step !== direction) break;
    first -= 1;
  }
  // The run may have started with a step in the other direction; the gesture starts after it.
  while (first < moves.length - 1 && Math.sign(at(moves, first).value - valueBefore(first)) === -direction) first += 1;

  // The gesture may go on after `t` (a slow blend is audible long before it has moved 10%).
  const all = events.filter((event) => matches(event, control, deck));
  const later: ControlEvent[] = [];
  for (const next of all.slice(moves.length)) {
    const previous = later.at(-1) ?? last;
    if (next.ctx - previous.ctx > GESTURE_GAP_S || Math.sign(next.value - previous.value) === -direction) break;
    later.push(next);
  }
  const origin = valueBefore(first);
  const crossing = [...moves.slice(first), ...later].find(
    (event) => Math.abs(event.value - origin) >= GESTURE_START_TRAVEL - TIME_EPSILON,
  );
  return crossing === undefined ? null : { firstMove: at(moves, first).ctx, travelStart: crossing.ctx };
}
