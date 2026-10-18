// Hot cues, loops and Beat FX on the event timeline (Lessons 17–19): which loop is on, Beat FX's state
// at a moment, and where an echo's tail dies out. Units are the contract's (shared/attempt.ts `ControlId`).
import { BEAT_FX_DEFAULT, type Attempt, type BeatFxSnapshot, type ControlEvent, type ControlId, type CtxSpan, type CtxTime, type DeckId } from "@shared/attempt.ts";
import type { LoadedDeck } from "./context.ts";
import { TIME_EPSILON } from "./measures.ts";
import { framesIn } from "./mix.ts";
import { phraseOffsetBeats, phraseOffsetBeatsOf } from "./phrasing.ts";
import { positionAt, rateAt, trackBeat } from "./timeline.ts";

/** Loop-button events that leave a loop on: value = its length, `pos` = its start (track seconds). */
export const LOOP_SETTING: ReadonlySet<ControlId> = new Set<ControlId>(["loopOut", "loopAuto", "loopDouble", "loopHalve"]);

export interface RecordedLoop {
  /** The press that left this loop on (heard time) and when it took effect. */
  readonly ctx: CtxTime;
  readonly appliedCtx: CtxTime;
  readonly start: number;
  readonly length: number;
  /** How the loop was first closed: by hand (LOOP OUT) or on the grid (4 BEAT); 2X and ½X keep it. */
  readonly closedBy: "loopOut" | "loopAuto";
}

const inSpan = (event: ControlEvent, span: CtxSpan) => event.ctx >= span.from - TIME_EPSILON && event.ctx < span.to;

/** Every loop the deck was left on in `span`, in time order. */
export function loopsIn(attempt: Attempt, deck: DeckId, span: CtxSpan): RecordedLoop[] {
  let closedBy: RecordedLoop["closedBy"] = "loopAuto";
  return attempt.events
    .filter((event) => event.deck === deck && LOOP_SETTING.has(event.control) && event.pos !== undefined && inSpan(event, span))
    .map((event) => {
      if (event.control === "loopOut" || event.control === "loopAuto") closedBy = event.control;
      return { ctx: event.ctx, appliedCtx: event.appliedCtx ?? event.ctx, start: event.pos ?? 0, length: event.value, closedBy };
    });
}

/** Whether the deck loops at `t`: a loop was left on and no exit (EXIT, or the engine's own) came since. */
export function loopOnAt(attempt: Attempt, deck: DeckId, t: CtxTime): boolean {
  const last = attempt.events.filter((event) => event.deck === deck && (LOOP_SETTING.has(event.control) || event.control === "loopExit") && event.ctx <= t + TIME_EPSILON).at(-1);
  if (last === undefined) return attempt.initialDecks[deck].loop != null;
  return last.control !== "loopExit";
}

/**
 * `phraseOff(t, d)` for a deck that may be looping: within a beat before the loop wraps, the deck is
 * also a moment before the loop's start (the two are the same point of the music), so a press a hair
 * early on the loop's 1 is measured from the start, not from the loop's end bars later.
 */
export function loopedPhraseOffsetBeats(attempt: Attempt, loaded: LoadedDeck, t: CtxTime): number | null {
  const plain = phraseOffsetBeats(loaded, t);
  if (plain === null || !loopOnAt(attempt, loaded.deck, t)) return plain;
  const loop = loopsIn(attempt, loaded.deck, { from: Number.NEGATIVE_INFINITY, to: t + TIME_EPSILON }).at(-1);
  const pos = positionAt(loaded.playhead, t);
  if (loop === undefined || pos === null) return plain;
  const toWrap = loop.start + loop.length - pos;
  if (toWrap < 0 || toWrap > 60 / loaded.grid.bpm) return plain;
  const folded = phraseOffsetBeatsOf(loaded, loop.start - toWrap);
  return folded !== null && Math.abs(folded) < Math.abs(plain) ? folded : plain;
}

/** Signed beats from the nearest downbeat of a track position. */
export function downbeatOffsetBeats(loaded: LoadedDeck, pos: number): number {
  const fromDownbeat = trackBeat(loaded.grid, pos) - loaded.grid.downbeatIndex;
  return fromDownbeat - 4 * Math.round(fromDownbeat / 4);
}

/** Signed beats from the nearest downbeat of what the deck plays at `t`; null before it starts. */
export function downbeatOffsetAt(loaded: LoadedDeck, t: CtxTime): number | null {
  const pos = positionAt(loaded.playhead, t);
  return pos === null ? null : downbeatOffsetBeats(loaded, pos);
}

/** Beat FX at `t`: the starting state, then each ON/OFF, CH SELECT, BEAT and DEPTH event (heard time). */
export function beatFxAt(attempt: Attempt, t: CtxTime): BeatFxSnapshot {
  return attempt.events
    .filter((event) => event.ctx <= t + TIME_EPSILON)
    .reduce<BeatFxSnapshot>((state, event) => {
      switch (event.control) {
        case "beatFx":
          return { ...state, on: event.value > 0 };
        case "beatFxChannel":
          return { ...state, channel: event.deck ?? "master" };
        case "beatFxBeats":
          return { ...state, beats: event.value };
        case "beatFxDepth":
          return { ...state, depth: event.value };
        default:
          return state;
      }
    }, attempt.initialMixer.beatFx ?? BEAT_FX_DEFAULT);
}

/** Beat FX is on and takes in this deck (its channel, or the master it plays into). */
export function echoingAt(attempt: Attempt, deck: DeckId, t: CtxTime): boolean {
  const state = beatFxAt(attempt, t);
  return state.on && (state.channel === deck || state.channel === "master");
}

/** The FX return is silent below this (check-design §4 `fx-off`). */
export const FX_TAIL_LUFS = -50;

/**
 * Where the echoes die out after `from`: just after the last FX-return frame in `[from, window end)`
 * at or above −50 LUFS momentary; `from` when there is none. An audible effect, so read from the meter.
 */
export function fxTailEnd(attempt: Attempt, from: CtxTime, window: CtxSpan): CtxTime {
  const loud = framesIn(attempt.meters.fxReturn, { from, to: window.to }).filter((frame) => frame.momentaryLufs >= FX_TAIL_LUFS);
  const last = loud.at(-1);
  return last === undefined ? from : last.ctx + 0.02;
}

/** The deck's rate at `t`, or its last playing rate when paused there (for "had it kept playing"). */
export function playingRateAt(loaded: LoadedDeck, t: CtxTime): number {
  const rate = rateAt(loaded.playhead, t);
  if (rate > 0) return rate;
  return loaded.playhead.segments.filter((segment) => segment.fromCtx <= t + TIME_EPSILON && segment.rate > 0).at(-1)?.rate ?? 1;
}
