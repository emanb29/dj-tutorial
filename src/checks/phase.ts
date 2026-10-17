// Inter-deck phase and tempo (check-design §2): `phaseErr`, `holdFrac`, `worstRun`, deck BPM.
// Computed from the two decks' playhead models and beat grids on heard time, never from audio:
// one AudioContext, so output latency cancels and the error budget is the grid alone.
import type { CtxSpan, CtxTime } from "@shared/attempt.ts";
import type { CheckContext, LoadedDeck } from "./context.ts";
import { loadedDeck } from "./context.ts";
import { jogBendAt, type GradedAttempt } from "./deck-commands.ts";
import { TIME_EPSILON } from "./measures.ts";
import { beatPhase, beatSeconds, isPlaying, rateAt } from "./timeline.ts";

/** Phase is sampled at the meters' rate, 50 Hz. */
export const PHASE_SAMPLE_S = 0.02;

/**
 * The deck's tempo-fader BPM at `t` (jog bend factored out): `grid.bpm × rate / (1 + bend)`.
 * `null` while the deck is stopped, since a stopped playhead does not show the tempo fader.
 */
export function tempoBpmAt(attempt: GradedAttempt, loaded: LoadedDeck, t: CtxTime): number | null {
  const rate = rateAt(loaded.playhead, t);
  if (rate <= 0) return null;
  return (loaded.grid.bpm * rate) / (1 + jogBendAt(attempt, loaded.deck, t));
}

export interface PhasePair {
  readonly master: LoadedDeck;
  readonly other: LoadedDeck;
}

/** A (the outgoing deck) is the master; B the other. `null` unless both are loaded with grids. */
export function phasePair(context: CheckContext): PhasePair | null {
  const master = loadedDeck(context, "A");
  const other = loadedDeck(context, "B");
  return master === null || other === null ? null : { master, other };
}

/**
 * `phaseErr(t)`: `wrap(φ_A − φ_B, ±½) · B_M`, in ms (positive = B behind A). `null` unless both
 * decks are playing.
 */
export function phaseErrorMs(pair: PhasePair, t: CtxTime): number | null {
  const { master, other } = pair;
  if (!isPlaying(master.playhead, t) || !isPlaying(other.playhead, t)) return null;
  const phaseMaster = beatPhase(master.playhead, master.grid, t);
  const phaseOther = beatPhase(other.playhead, other.grid, t);
  if (phaseMaster === null || phaseOther === null) return null;
  const difference = phaseMaster - phaseOther;
  return (difference - Math.round(difference)) * beatSeconds(master.playhead, master.grid, t) * 1000;
}

/** Sample times over `span` at 50 Hz, from its start. */
export function sampleTimes(span: CtxSpan): CtxTime[] {
  const count = Math.max(0, Math.ceil((span.to - span.from) / PHASE_SAMPLE_S - TIME_EPSILON));
  return Array.from({ length: count }, (_, index) => span.from + index * PHASE_SAMPLE_S);
}

export interface PhaseHold {
  /** Fraction of samples with `|phaseErr| < limit`; a sample with either deck stopped is not held. */
  readonly holdFraction: number;
  /** Longest run of samples over the run limit (or with a deck stopped), seconds. */
  readonly worstRunS: number;
  readonly worstRun: CtxSpan | null;
}

/** `holdFrac(span, holdLimitMs)` and `worstRun(span, runLimitMs)` over several spans together. */
export function phaseHold(pair: PhasePair, spans: readonly CtxSpan[], holdLimitMs: number, runLimitMs: number): PhaseHold {
  let samples = 0;
  let held = 0;
  let worstRun: CtxSpan | null = null;
  for (const span of spans) {
    let runFrom: CtxTime | null = null;
    const closeRun = (to: CtxTime) => {
      if (runFrom !== null && (worstRun === null || to - runFrom > worstRun.to - worstRun.from)) worstRun = { from: runFrom, to };
      runFrom = null;
    };
    for (const t of sampleTimes(span)) {
      const error = phaseErrorMs(pair, t);
      samples += 1;
      if (error !== null && Math.abs(error) < holdLimitMs) held += 1;
      if (error === null || Math.abs(error) > runLimitMs) runFrom ??= t;
      else closeRun(t);
    }
    closeRun(span.to);
  }
  const worst = worstRun as CtxSpan | null;
  return {
    holdFraction: samples === 0 ? 0 : held / samples,
    worstRunS: worst === null ? 0 : worst.to - worst.from,
    worstRun: worst,
  };
}

/** The first sample in `span` with `|phaseErr| < limitMs`, or `null`. */
export function firstPhaseUnder(pair: PhasePair, span: CtxSpan, limitMs: number): CtxTime | null {
  return sampleTimes(span).find((t) => {
    const error = phaseErrorMs(pair, t);
    return error !== null && Math.abs(error) < limitMs;
  }) ?? null;
}
