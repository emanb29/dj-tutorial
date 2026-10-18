// A set (`final-mix`, check-design §5): several tracks in turn on the two decks. It is split into
// plays (one track's stay on a deck) and transitions (one track handing the master over to the
// next). Each transition gets a view: the attempt as the two-track attempts of Lessons 7–16 see it,
// the outgoing deck relabelled A and the incoming B, one track on each, over the time both tracks
// were loaded. Every Lesson measure (blend phase, on-phrase, level match …) then runs on a view
// unchanged, so the set reuses them instead of re-deriving them.
import type { ControlEvent, CtxSpan, CtxTime, DeckId, DeckRecording, PlayheadModel } from "@shared/attempt.ts";
import { barSeconds, loadedDeck, type CheckContext, type LoadedDeck } from "./context.ts";
import type { GradedAttempt } from "./deck-controls.ts";
import { TIME_EPSILON } from "./measures.ts";
import { audibleSpans, overlapSpans } from "./mix.ts";
import { spansSeconds } from "./blend.ts";

/** One track's stay on a deck, inside the grading window. */
export interface Play {
  readonly deck: DeckId;
  readonly trackId: string;
  readonly playhead: PlayheadModel;
  /** The window part in which the deck held this track: from its load to the next load (or the window's end). */
  readonly span: CtxSpan;
  /** Heard spans in which this track was audible on the master. */
  readonly audible: readonly CtxSpan[];
}

/** Overlap classes (check-design §5.1): a cut is under 2 beats, a blend at least 4 bars. */
export type TransitionKind = "cut" | "blend" | "unclassified";
export const CUT_MAX_BEATS = 2;
export const BLEND_MIN_BARS = 4;

export interface SetTransition {
  /** 1 for the hand-over from the first track to the second. */
  readonly number: number;
  readonly outgoing: Play;
  readonly incoming: Play;
  /**
   * The attempt with the outgoing deck as A and the incoming as B, one track each, over `view.window`:
   * from when both were loaded until the incoming track leaves its deck.
   */
  readonly view: CheckContext;
  /** `t_in` of the incoming track. */
  readonly inAt: CtxTime;
  /** Seconds both tracks were audible together. */
  readonly overlapS: number;
  readonly kind: TransitionKind;
}

const other = (deck: DeckId): DeckId => (deck === "A" ? "B" : "A");

/** Every track each deck held, with the span it held it for inside `window`. */
function plays(attempt: GradedAttempt, window: CtxSpan): Omit<Play, "audible">[] {
  return (["A", "B"] as const).flatMap((deck) => {
    const recording: DeckRecording | undefined = attempt.decks[deck];
    const tracks = [...(recording?.earlier ?? []), ...(recording === undefined ? [] : [recording])];
    return tracks.map((track, index) => {
      const loadedAt = track.loadedCtx ?? Number.NEGATIVE_INFINITY;
      const next = tracks[index + 1]?.loadedCtx ?? Number.POSITIVE_INFINITY;
      return { deck, trackId: track.trackId, playhead: track.playhead, span: { from: Math.max(window.from, loadedAt), to: Math.min(window.to, next) } };
    }).filter((play) => play.span.to > play.span.from);
  });
}

/** The attempt with only the given tracks on their decks (no `earlier`). */
function withDecks(attempt: GradedAttempt, decks: Partial<Record<DeckId, { readonly trackId: string; readonly playhead: PlayheadModel }>>): GradedAttempt {
  const recordings = Object.fromEntries(
    Object.entries(decks).map(([deck, track]) => [deck, { trackId: track.trackId, playhead: track.playhead }]),
  ) as Partial<Record<DeckId, DeckRecording>>;
  return { ...attempt, decks: recordings };
}

/** Every track's stay on a deck in the window, with when it was audible. */
export function setPlays(context: CheckContext): Play[] {
  const { attempt, window } = context;
  return plays(attempt, window).map((play) => ({
    ...play,
    audible: audibleSpans(withDecks(attempt, { [play.deck]: play }), play.deck, play.span),
  }));
}

/**
 * The attempt as one transition sees it: `outgoing` relabelled A and `incoming` B (swapping every
 * per-deck field, and mirroring the crossfader), with one track on each deck.
 */
export function transitionAttempt(attempt: GradedAttempt, outgoing: Play, incoming: Play): GradedAttempt {
  const decks = withDecks(attempt, { [outgoing.deck]: outgoing, [incoming.deck]: incoming });
  if (outgoing.deck === "A") return decks;
  const swap = (deck: DeckId | undefined) => (deck === undefined ? undefined : other(deck));
  const events = decks.events.map((event): ControlEvent => {
    if (event.control === "crossfader") return { ...event, value: 1 - event.value };
    const deck = swap(event.deck);
    return deck === undefined ? event : { ...event, deck };
  });
  const { A: meterA, B: meterB, ...buses } = decks.meters;
  return {
    ...decks,
    events,
    decks: { ...(decks.decks.B === undefined ? {} : { A: decks.decks.B }), ...(decks.decks.A === undefined ? {} : { B: decks.decks.A }) },
    meters: { ...buses, ...(meterB === undefined ? {} : { A: meterB }), ...(meterA === undefined ? {} : { B: meterA }) },
    cuePoints: decks.cuePoints.map((cue) => ({ ...cue, deck: other(cue.deck) })),
    initialMixer: { A: decks.initialMixer.B, B: decks.initialMixer.A, crossfader: 1 - decks.initialMixer.crossfader },
    initialDecks: { A: decks.initialDecks.B, B: decks.initialDecks.A },
  };
}

/** A beat's heard length on a loaded deck at `t`. */
function beatSecondsOf(loaded: LoadedDeck, t: CtxTime): number {
  return barSeconds(loaded, t) / 4;
}

/**
 * The set's transitions, in order: each track that came onto the master after another one, on the
 * other deck. Tracks are ordered by when they were first audible; a track that follows one on the
 * same deck (the master went silent in between) is not a transition, and no-dead-air reports the gap.
 */
export function setTransitions(context: CheckContext): SetTransition[] {
  const heard = setPlays(context)
    .filter((play) => play.audible.length > 0)
    .toSorted((first, second) => (first.audible[0]?.from ?? 0) - (second.audible[0]?.from ?? 0));
  const transitions: SetTransition[] = [];
  heard.forEach((incoming, index) => {
    const outgoing = heard[index - 1];
    if (outgoing === undefined || outgoing.deck === incoming.deck) return;
    // From when both tracks were loaded to when the incoming one leaves its deck: the outgoing deck may
    // be reloaded right after the handover, but what is measured after it (the incoming level 3 s in,
    // loudness bars) still belongs to this transition. The next track is not on the view's decks.
    const window: CtxSpan = { from: Math.max(outgoing.span.from, incoming.span.from), to: incoming.span.to };
    if (window.to <= window.from) return;
    const attempt = transitionAttempt(context.attempt, outgoing, incoming);
    const view: CheckContext = { ...context, attempt, window };
    const inAt = audibleSpans(attempt, "B", window)[0]?.from;
    const master = loadedDeck(view, "A");
    if (inAt === undefined || master === null) return;
    const overlapS = spansSeconds(overlapSpans(attempt, window));
    const beat = beatSecondsOf(master, inAt);
    const kind: TransitionKind =
      overlapS < CUT_MAX_BEATS * beat - TIME_EPSILON ? "cut" : overlapS >= BLEND_MIN_BARS * 4 * beat - TIME_EPSILON ? "blend" : "unclassified";
    transitions.push({ number: transitions.length + 1, outgoing, incoming, view, inAt, overlapS, kind });
  });
  return transitions;
}

/** Seconds a play was audible. */
export function audibleSeconds(play: Play): number {
  return spansSeconds(play.audible);
}
