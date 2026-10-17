// Mixer-derived measures: channel gain, `audible`, entry (`t_in`) and exit (`t_out`).
import {
  channelFaderGainDb,
  crossfaderGainDb,
  GAIN_FLOOR_DB,
  type Attempt,
  type CtxSpan,
  type CtxTime,
  type DeckId,
  type MeterFrame,
} from "@shared/attempt.ts";
import { TIME_EPSILON } from "./measures.ts";
import { controlValueAt, faderGestureStart, isPlaying, playRunStartAt } from "./timeline.ts";

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

/** `audible(d, t)`: playing ∧ gain > −24 dB ∧ channel momentary > −40 LUFS. */
export function isAudible(attempt: Attempt, deck: DeckId, t: CtxTime): boolean {
  const recording = attempt.decks[deck];
  if (recording === undefined || !isPlaying(recording.playhead, t)) return false;
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

/**
 * Faders are judged on intent (check-design, input leeway): when a fader move caused the change,
 * the change is timed from the start of that move.
 */
function gestureAdjusted(attempt: Attempt, deck: DeckId, t: CtxTime): CtxTime {
  const start = faderGestureStart(attempt.events, "channelFader", deck, t, attempt.initialMixer[deck].channelFader);
  return start === null ? t : Math.min(start, t);
}

/** `t_in`: the first audible frame of the deck in the window. */
export function entryTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  const first = audibleSpans(attempt, deck, window)[0];
  if (first === undefined) return null;
  const playhead = attempt.decks[deck]?.playhead;
  const startedPlaying = playhead === undefined ? null : playRunStartAt(playhead, first.from);
  return Math.max(gestureAdjusted(attempt, deck, first.from), startedPlaying ?? -Infinity);
}

/** `t_out`: the first frame of the deck's final exit, when it stays inaudible to the window end. */
export function exitTime(attempt: Attempt, deck: DeckId, window: CtxSpan): CtxTime | null {
  const last = audibleSpans(attempt, deck, window).at(-1);
  if (last === undefined || last.to >= window.to - TIME_EPSILON) return null;
  return gestureAdjusted(attempt, deck, last.to);
}
