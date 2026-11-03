// The Transition editor's timeline as numbers: which beats it spans, how many pixels a beat takes at a
// zoom, where a beat is on screen and back, and what keyframes snap to. Beats are Transition beats
// (0 is the Transition's start on the outgoing track's grid), the same unit as keyframes.
import { BEATS_PER_BAR, BEATS_PER_PHRASE, beatIndexOf, beatsInTrack, type PlanGrid, type Transition } from "@shared/mix-plan.ts";

export interface BeatSpan {
  readonly fromBeat: number;
  readonly toBeat: number;
}

/** The closest zoom: a beat this many pixels wide. */
export const MAX_PX_PER_BEAT = 96;
/** How much one zoom step (+/−, a wheel notch) changes the zoom. */
export const ZOOM_STEP = 1.25;
/** Room either side of a Transition when the editor opens on it. */
export const PAD_BEATS = BEATS_PER_PHRASE;

/** Both tracks laid out against the Transition: the outgoing one from its start, the incoming one to its end. */
export function pairSpan(transition: Pick<Transition, "outgoingAt" | "incomingAt" | "lengthBeats">, outgoing: PlanGrid | null, incoming: PlanGrid | null): BeatSpan {
  const outStart = -beatIndexOf(transition.outgoingAt);
  const outEnd = outgoing === null ? transition.lengthBeats + PAD_BEATS : outStart + beatsInTrack(outgoing);
  const inEnd = incoming === null ? transition.lengthBeats + PAD_BEATS : beatsInTrack(incoming) - beatIndexOf(transition.incomingAt);
  return { fromBeat: Math.min(outStart, -PAD_BEATS), toBeat: Math.max(outEnd, inEnd, transition.lengthBeats + PAD_BEATS) };
}

/** The Transition with a phrase either side: what the editor opens on, and what Preview plays. */
export function transitionFocus(transition: Pick<Transition, "outgoingAt" | "lengthBeats">): BeatSpan {
  return { fromBeat: Math.max(-PAD_BEATS, -beatIndexOf(transition.outgoingAt)), toBeat: transition.lengthBeats + PAD_BEATS };
}

export const spanBeats = (span: BeatSpan) => span.toBeat - span.fromBeat;

/** The zoom at which `span` fills `widthPx`. */
export function fitZoom(span: BeatSpan, widthPx: number): number {
  return Math.min(MAX_PX_PER_BEAT, Math.max(1e-3, widthPx) / Math.max(1, spanBeats(span)));
}

export interface TimelineView {
  readonly pxPerBeat: number;
  /** Pixels scrolled from the span's start. */
  readonly scrollPx: number;
}

export function xOfBeat(beat: number, span: BeatSpan, pxPerBeat: number): number {
  return (beat - span.fromBeat) * pxPerBeat;
}

export function beatOfX(x: number, span: BeatSpan, pxPerBeat: number): number {
  return span.fromBeat + x / pxPerBeat;
}

/**
 * Zooms by `factor` keeping the beat under `anchorPx` (pixels from the timeline's left edge) where it is,
 * between the whole pair (`minPxPerBeat`) and MAX_PX_PER_BEAT.
 */
export function zoomAround(view: TimelineView, factor: number, anchorPx: number, span: BeatSpan, minPxPerBeat: number, widthPx: number): TimelineView {
  const pxPerBeat = Math.min(MAX_PX_PER_BEAT, Math.max(minPxPerBeat, view.pxPerBeat * factor));
  const anchorBeat = beatOfX(view.scrollPx + anchorPx, span, view.pxPerBeat);
  const scrollPx = xOfBeat(anchorBeat, span, pxPerBeat) - anchorPx;
  return { pxPerBeat, scrollPx: Math.min(Math.max(0, spanBeats(span) * pxPerBeat - widthPx), Math.max(0, scrollPx)) };
}

/** The view showing `focus` across `widthPx`. */
export function viewOf(focus: BeatSpan, span: BeatSpan, widthPx: number, minPxPerBeat: number): TimelineView {
  const pxPerBeat = Math.max(minPxPerBeat, fitZoom(focus, widthPx));
  return { pxPerBeat, scrollPx: Math.max(0, xOfBeat(focus.fromBeat, span, pxPerBeat)) };
}

/** What keyframes snap to: a beat, or half a beat once a beat is wide enough to aim at halves. */
export function snapStep(pxPerBeat: number): number {
  return pxPerBeat >= 48 ? 0.5 : 1;
}

export function snapBeat(beat: number, step: number): number {
  return Math.round(beat / step) * step;
}

/** How far apart the grid lines are drawn, beats: beats when close, bars, then phrases zoomed out. */
export function gridLineBeats(pxPerBeat: number): number {
  if (pxPerBeat >= 10) return 1;
  if (pxPerBeat * BEATS_PER_BAR >= 10) return BEATS_PER_BAR;
  return BEATS_PER_PHRASE;
}

/** The numbered phrase starts of the outgoing track inside `[fromBeat, toBeat]`: Transition beat and phrase number. */
export function phraseMarks(transition: Pick<Transition, "outgoingAt">, fromBeat: number, toBeat: number): { readonly beat: number; readonly phrase: number }[] {
  const offset = beatIndexOf(transition.outgoingAt);
  const first = Math.max(0, Math.ceil((fromBeat + offset) / BEATS_PER_PHRASE));
  const marks: { beat: number; phrase: number }[] = [];
  for (let index = first; index * BEATS_PER_PHRASE - offset <= toBeat; index += 1) marks.push({ beat: index * BEATS_PER_PHRASE - offset, phrase: index + 1 });
  return marks;
}
