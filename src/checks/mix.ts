// Mixer-derived measures: channel gain, `audible`, entry (`t_in`) and exit (`t_out`).
import {
  channelFaderGainDb,
  crossfaderGainDb,
  GAIN_FLOOR_DB,
  type Attempt,
  type CtxSpan,
  type CtxTime,
  type DeckId,
  type DeckRecording,
  type MeterFrame,
  type PlayheadModel,
} from "@shared/attempt.ts";
import { playPressTime, type GradedAttempt } from "./deck-controls.ts";
import { TIME_EPSILON } from "./measures.ts";
import { controlValueAt, faderGesture, isPlaying, playRunStartAt } from "./timeline.ts";

/** A deck counts as in the mix above this gain (check-design §10). */
export const AUDIBLE_GAIN_DB = -24;
/** … and above this channel momentary loudness. */
export const AUDIBLE_CHANNEL_LUFS = -40;

export function channelFaderAt(attempt: Attempt, deck: DeckId, t: CtxTime): number {
  return controlValueAt(attempt.events, "channelFader", deck, t, attempt.initialMixer[deck].channelFader);
}

/** Effective gain from deck to master, dB: channel fader × crossfader curve. */
export function channelGainDb(attempt: Attempt, deck: DeckId, t: CtxTime): number {
  const crossfader = controlValueAt(attempt.events, "crossfader", undefined, t, attempt.initialMixer.crossfader);
  return Math.max(GAIN_FLOOR_DB, channelFaderGainDb(channelFaderAt(attempt, deck, t)) + crossfaderGainDb(deck, crossfader));
}

/** The highest channel gain the deck had at any moment of `span` (gain changes only at events). */
export function maxChannelGainDb(attempt: Attempt, deck: DeckId, span: CtxSpan): number {
  const changes = attempt.events
    .filter((event) => (event.control === "channelFader" && event.deck === deck) || event.control === "crossfader")
    .filter((event) => event.ctx >= span.from && event.ctx < span.to)
    .map((event) => event.ctx);
  return [span.from, ...changes].reduce(
    (highest, t) => Math.max(highest, channelGainDb(attempt, deck, t)),
    GAIN_FLOOR_DB,
  );
}

/** Fraction of `span` with the deck's headphone CUE on. */
export function cueOnFraction(attempt: Attempt, deck: DeckId, span: CtxSpan): number {
  return cueOnSeconds(attempt, deck, span) / (span.to - span.from);
}

/** Seconds of `span` with the deck's headphone CUE on. */
export function cueOnSeconds(attempt: Attempt, deck: DeckId, span: CtxSpan): number {
  if (span.to <= span.from) return 0;
  const initial = attempt.initialMixer[deck].cueMonitor ? 1 : 0;
  const changes = attempt.events
    .filter((event) => event.control === "cueMonitor" && event.deck === deck && event.ctx > span.from && event.ctx < span.to)
    .map((event) => event.ctx);
  const edges = [span.from, ...changes, span.to];
  return edges.slice(0, -1).reduce((total, from, index) => {
    const to = edges[index + 1] ?? from;
    return controlValueAt(attempt.events, "cueMonitor", deck, from, initial) > 0 ? total + (to - from) : total;
  }, 0);
}

/** A meter frame older than this is stale (the stream has a gap): five 50 Hz frames. */
export const MAX_FRAME_AGE_S = 0.1;

/** The latest frame at or before `t`, or `null` when there is none or it is stale. Frames are ordered by `ctx`. */
export function frameAt(frames: readonly MeterFrame[] | undefined, t: CtxTime): MeterFrame | null {
  if (frames === undefined) return null;
  let low = 0;
  let high = frames.length - 1;
  let found: MeterFrame | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const frame = frames[middle];
    if (frame === undefined) break;
    if (frame.ctx <= t + TIME_EPSILON) {
      found = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found !== null && t - found.ctx <= MAX_FRAME_AGE_S + TIME_EPSILON ? found : null;
}

export function framesIn(frames: readonly MeterFrame[] | undefined, span: CtxSpan): MeterFrame[] {
  return (frames ?? []).filter((frame) => frame.ctx >= span.from - TIME_EPSILON && frame.ctx < span.to - TIME_EPSILON);
}

/** Every track a deck held in the attempt, oldest first: the `earlier` ones, then its last. */
export function deckTracks(recording: DeckRecording | undefined): readonly { readonly trackId: string; readonly playhead: PlayheadModel }[] {
  return recording === undefined ? [] : [...(recording.earlier ?? []), recording];
}

/** `audible(d, t)`: playing ∧ gain > −24 dB ∧ channel momentary > −40 LUFS. Any track the deck held may be the one playing. */
export function isAudible(attempt: Attempt, deck: DeckId, t: CtxTime): boolean {
  if (!deckTracks(attempt.decks[deck]).some((track) => isPlaying(track.playhead, t))) return false;
  const level = frameAt(attempt.meters[deck], t);
  return (
    level !== null && level.momentaryLufs > AUDIBLE_CHANNEL_LUFS && channelGainDb(attempt, deck, t) > AUDIBLE_GAIN_DB
  );
}

/** Maximal spans in which the deck is audible, on the master meter's frame clock. */
export function audibleSpans(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxSpan[] {
  const clock = framesIn(attempt.meters.master, window);
  const spans: CtxSpan[] = [];
  let openedAt: CtxTime | null = null;
  for (const frame of clock) {
    const audible = isAudible(attempt, deck, frame.ctx);
    if (audible && openedAt === null) openedAt = frame.ctx;
    if (!audible && openedAt !== null) {
      spans.push({ from: openedAt, to: frame.ctx });
      openedAt = null;
    }
  }
  if (openedAt !== null) spans.push({ from: openedAt, to: window.to });
  return spans;
}

/**
 * Maximal spans in which the deck is open to the master: playing, with its channel gain above the
 * audible line, whatever its own loudness (on the master meter's frame clock). A deck high-passed or
 * EQ'd down to a whisper is still in the mix until the Learner takes it out.
 */
export function openSpans(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxSpan[] {
  const open = (t: CtxTime) => deckTracks(attempt.decks[deck]).some((track) => isPlaying(track.playhead, t)) && channelGainDb(attempt, deck, t) > AUDIBLE_GAIN_DB;
  const spans: CtxSpan[] = [];
  let openedAt: CtxTime | null = null;
  for (const frame of framesIn(attempt.meters.master, window)) {
    if (open(frame.ctx) && openedAt === null) openedAt = frame.ctx;
    if (!open(frame.ctx) && openedAt !== null) {
      spans.push({ from: openedAt, to: frame.ctx });
      openedAt = null;
    }
  }
  if (openedAt !== null) spans.push({ from: openedAt, to: window.to });
  return spans;
}

/**
 * When the Learner took the deck out for good: the first frame of the last stretch, to the window's
 * end, in which it is stopped or its fader (or the crossfader) is below the audible line. Unlike `t_out`
 * it ignores the deck's own loudness, so a filter or EQ that thins it out is not its exit. Null while
 * it is still open at the end.
 */
export function takenOutTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  const last = openSpans(attempt, deck, window).at(-1);
  return last === undefined || last.to >= window.to - TIME_EPSILON ? null : last.to;
}

/**
 * After the deck went out at `t`, when it could next be heard: the first of its next open span (its
 * fader or the crossfader up while it plays), its next Play press, or its next track load. Null when
 * none comes before the window ends: then the deck stays out to the end.
 */
export function nextHeardTime(attempt: Attempt, deck: DeckId, t: CtxTime, window: CtxSpan): CtxTime | null {
  const reopened = openSpans(attempt, deck, window).find((span) => span.from > t + TIME_EPSILON)?.from;
  const recording = attempt.decks[deck];
  // A Play that starts it (one that pauses it is not a way back in).
  const played = attempt.events.find(
    (event) =>
      event.control === "play" &&
      event.deck === deck &&
      event.ctx > t + TIME_EPSILON &&
      event.ctx < window.to &&
      !deckTracks(recording).some((track) => isPlaying(track.playhead, event.ctx)),
  )?.ctx;
  const loads = [...(recording?.earlier ?? []).map((track) => track.loadedCtx), recording?.loadedCtx].filter(
    (loadedAt): loadedAt is CtxTime => loadedAt !== undefined && loadedAt > t + TIME_EPSILON && loadedAt < window.to,
  );
  const times = [reopened, played, ...loads].filter((time) => time !== undefined);
  return times.length === 0 ? null : Math.min(...times);
}

/** Spans in which both decks are audible (`overlap`). */
export function overlapSpans(attempt: Attempt, window: CtxSpan): CtxSpan[] {
  const bSpans = audibleSpans(attempt, "B", window);
  return audibleSpans(attempt, "A", window).flatMap((a) =>
    bSpans.flatMap((b) => {
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      return to > from ? [{ from, to }] : [];
    }),
  );
}

// Two kinds of time (check-design §2 and "Input leeway"):
// - `entryTime` / `exitTime` are `t_in` / `t_out` exactly as §2 defines them, on the audible frames.
//   Durations and measurement windows (blend length, loudness spans, filter length) use only these.
// - `*ActionTime` are point-in-time actions judged on intent: a fader or crossfader move is timed
//   from its start. Only point-action criteria (cut timing, phrase-start entries) use them.

/** Which point of a fader gesture an action is timed from. */
export type GesturePoint = "travelStart" | "firstMove";

/** The start of the fader or crossfader gesture that leads up to `t`, if one moved 10% of travel. */
function gestureStartBefore(attempt: Attempt, deck: DeckId, t: CtxTime, point: GesturePoint): CtxTime | null {
  const starts = [
    faderGesture(attempt.events, "channelFader", deck, t, attempt.initialMixer[deck].channelFader),
    faderGesture(attempt.events, "crossfader", undefined, t, attempt.initialMixer.crossfader),
  ].flatMap((gesture) => (gesture === null ? [] : [gesture[point]]));
  return starts.length === 0 ? null : Math.min(...starts);
}

/** `t_in`: the first audible frame of the deck in the window. */
export function entryTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  return audibleSpans(attempt, deck, window)[0]?.from ?? null;
}

/** `t_out`: the first frame of the deck's final exit, when it stays inaudible to the window end. */
export function exitTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  const last = audibleSpans(attempt, deck, window).at(-1);
  return last === undefined || last.to >= window.to - TIME_EPSILON ? null : last.to;
}

/** The last fader or crossfader event at or before `t` that took the deck's gain above the audible line. */
function lastGainUp(attempt: Attempt, deck: DeckId, t: CtxTime): CtxTime | null {
  const ups = attempt.events.filter(
    (event) =>
      ((event.control === "channelFader" && event.deck === deck) || event.control === "crossfader") &&
      event.ctx <= t + TIME_EPSILON &&
      channelGainDb(attempt, deck, event.ctx) > AUDIBLE_GAIN_DB &&
      channelGainDb(attempt, deck, event.ctx - 1e-6) <= AUDIBLE_GAIN_DB,
  );
  return ups.at(-1)?.ctx ?? null;
}

/**
 * When the Learner brought the deck in: the later of the Play that started it (timed from its press,
 * `playPressTime`) and the fader or crossfader move that opened its gain (timed from that move's start). So a deck already open on
 * the master comes in at its Play, and a playing deck at the start of its fader move, even if its
 * first audible frame is later (a quiet first beat). Never later than `t_in`. `travelStart` (10% of
 * travel) suits a cut; `firstMove` suits a blend, whose slow move can take seconds to reach 10%.
 */
export function entryActionTime(attempt: GradedAttempt, deck: DeckId, window: CtxSpan, point: GesturePoint = "travelStart"): CtxTime | null {
  const inAt = entryTime(attempt, deck, window);
  if (inAt === null) return null;
  const playhead = attempt.decks[deck]?.playhead;
  const runStart = playhead === undefined ? null : playRunStartAt(playhead, inAt);
  // The Play is timed from its press: the audio starts an output latency (and lookahead) later.
  const startedPlaying = runStart === null ? null : playPressTime(attempt, deck, runStart);
  const gainUp = lastGainUp(attempt, deck, inAt);
  const openedAt = gainUp === null ? null : Math.min(gainUp, gestureStartBefore(attempt, deck, gainUp, point) ?? gainUp);
  const starts = [startedPlaying, openedAt].filter((start) => start !== null);
  return starts.length === 0 ? inAt : Math.min(inAt, Math.max(...starts));
}

/** When the Learner took the deck out: the start of the fader move that silenced it (never later than `t_out`). */
export function exitActionTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  const outAt = exitTime(attempt, deck, window);
  return outAt === null ? null : Math.min(outAt, gestureStartBefore(attempt, deck, outAt, "travelStart") ?? outAt);
}
