// By-ear practice drills (Lessons 14–16) as a pure state machine: short rounds, one or two reps each,
// with feedback between rounds. The app feeds it live readings of the decks (phase error, tempo-fader
// BPMs) and the Learner's tempo moves and Ready presses, and carries out what it asks: start the next
// round, count a rep, show a line, show the covered displays. No audio and no clock of its own.
import type { DeckId } from "@shared/attempt.ts";
import type { Observation, PracticeDrill } from "./types.ts";

/** What the app reads from the decks each tick. */
export interface DrillReading {
  /** performance.now() milliseconds. */
  readonly nowMs: number;
  /** Live phase error, ms (positive = B behind A); null unless both decks play. */
  readonly phaseMs: number | null;
  /** Each deck's tempo-fader BPM (the jog bend left out); null while it has no track. */
  readonly bpmA: number | null;
  readonly bpmB: number | null;
  /** One bar of deck A, ms. */
  readonly barMs: number;
}

export type DrillInput =
  | { readonly kind: "tick"; readonly reading: DrillReading }
  /** The Learner moved a tempo fader; `reading` is taken after the move. */
  | { readonly kind: "tempo-move"; readonly deck: DeckId; readonly reading: DrillReading }
  | { readonly kind: "ready"; readonly reading: DrillReading };

export interface DrillState {
  /** Rounds started so far; the current round is `round − 1`. */
  readonly round: number;
  /** `playing`: the round's task; `guessed`: tempo-ear after the first tempo move; `reveal`: feedback before the next round. */
  readonly stage: "playing" | "guessed" | "reveal";
  readonly roundStartMs: number;
  /** hold: since when B has stayed under the limit. */
  readonly heldFromMs: number | null;
  readonly revealUntilMs: number;
  /** tempo-ear: B's BPM minus A's at the last reading, for the guess. */
  readonly gapBpm: number | null;
  /** The line under the caption now; null for none. */
  readonly line: string | null;
}

/** Start the next round: both decks back to their practice set-up, B this far out and this far off. */
export interface RoundStart {
  readonly offsetBeats: number;
  readonly apartPercent: number;
}

export type DrillAction = { readonly kind: "start-round"; readonly round: RoundStart } | { readonly kind: "observe"; readonly observation: Observation };

export interface DrillStep {
  readonly state: DrillState;
  readonly actions: readonly DrillAction[];
}

/** hold drills: B this far out (twice the hold limit) is a drift the Learner should hear. */
const DRIFT_FACTOR = 2;
/** hold drills: the drift line waits this long into a round, so the start of a round is heard first. */
const DRIFT_LINE_AFTER_BARS = 1;

const at = <Value>(list: readonly Value[], index: number, fallback: Value): Value => (list.length === 0 ? fallback : (list[index % list.length] ?? fallback));

function roundStart(drill: PracticeDrill, round: number): RoundStart {
  return {
    offsetBeats: drill.kind === "hold" ? at(drill.offsetsBeats, round, 0) : 0,
    apartPercent: at(drill.apartPercents, round, 0),
  };
}

function nextRound(drill: PracticeDrill, state: DrillState, nowMs: number, line: string | null): DrillStep {
  return {
    state: { round: state.round + 1, stage: "playing", roundStartMs: nowMs, heldFromMs: null, revealUntilMs: 0, gapBpm: null, line },
    actions: [{ kind: "start-round", round: roundStart(drill, state.round) }],
  };
}

/** The first round. */
export function startDrill(drill: PracticeDrill, nowMs: number): DrillStep {
  return nextRound(drill, { round: 0, stage: "playing", roundStartMs: nowMs, heldFromMs: null, revealUntilMs: 0, gapBpm: null, line: null }, nowMs, null);
}

/** Whether the covered displays (BPM, phase meter) are shown now: only between rounds. */
export function drillReveals(state: DrillState): boolean {
  return state.stage === "reveal";
}

const bpmText = (bpm: number) => bpm.toFixed(2);
const fasterOrSlower = (gapBpm: number) => (gapBpm > 0 ? "faster" : "slower");

function reveal(state: DrillState, nowMs: number, revealMs: number, line: string, observation: Observation): DrillStep {
  return { state: { ...state, stage: "reveal", revealUntilMs: nowMs + revealMs, heldFromMs: null, line }, actions: [{ kind: "observe", observation }] };
}

function holdStep(drill: Extract<PracticeDrill, { kind: "hold" }>, state: DrillState, reading: DrillReading): DrillStep {
  const { nowMs, phaseMs, barMs } = reading;
  const under = phaseMs !== null && Math.abs(phaseMs) < drill.holdMs;
  const heldFromMs = under ? (state.heldFromMs ?? nowMs) : null;
  if (heldFromMs !== null && nowMs - heldFromMs >= drill.holdBars * barMs) {
    return reveal(state, nowMs, drill.revealMs, "✓ Held in line", { kind: "phase-rep", held: true });
  }
  if (nowMs - state.roundStartMs >= drill.giveUpBars * barMs) {
    return reveal(state, nowMs, drill.revealMs, "Missed it: listen for two kicks, then nudge", { kind: "phase-rep", held: false });
  }
  const drifting = phaseMs !== null && Math.abs(phaseMs) >= DRIFT_FACTOR * drill.holdMs && nowMs - state.roundStartMs >= DRIFT_LINE_AFTER_BARS * barMs;
  const line = under ? "In line: hold it there" : drifting ? "Two kicks? Nudge B" : state.line;
  return { state: { ...state, heldFromMs, line }, actions: [] };
}

function tempoGap(reading: DrillReading): number | null {
  return reading.bpmA === null || reading.bpmB === null ? null : reading.bpmB - reading.bpmA;
}

function tempoEarStep(drill: Extract<PracticeDrill, { kind: "tempo-ear" }>, state: DrillState, input: DrillInput): DrillStep {
  const { reading } = input;
  const gap = tempoGap(reading);
  if (input.kind === "tempo-move") {
    if (state.stage !== "playing" || state.gapBpm === null || gap === null) return { state: { ...state, gapBpm: gap }, actions: [] };
    const right = Math.abs(gap) < Math.abs(state.gapBpm);
    const line = right ? "Right way. Match it by ear, then R" : `Other way: B was ${fasterOrSlower(state.gapBpm)}`;
    return { state: { ...state, stage: "guessed", gapBpm: gap, line }, actions: [{ kind: "observe", observation: { kind: "tempo-guess", right } }] };
  }
  if (input.kind === "ready") {
    if (gap === null) return { state, actions: [] };
    const offBpm = Math.abs(gap);
    const good = offBpm <= drill.matchBpm + 1e-9;
    const line = good ? `✓ ${bpmText(offBpm)} BPM apart` : `${bpmText(offBpm)} BPM apart: B is ${fasterOrSlower(gap)}`;
    return reveal({ ...state, gapBpm: gap }, reading.nowMs, drill.revealMs, line, { kind: "tempo-match", offBpm, good });
  }
  if (reading.nowMs - state.roundStartMs >= drill.giveUpBars * reading.barMs) return nextRound(drill, state, reading.nowMs, "New round: which is faster?");
  return { state: { ...state, gapBpm: gap }, actions: [] };
}

/** One step of the drill. */
export function drillStep(drill: PracticeDrill, state: DrillState, input: DrillInput): DrillStep {
  if (state.stage === "reveal") {
    if (input.kind === "tick" && input.reading.nowMs >= state.revealUntilMs) return nextRound(drill, state, input.reading.nowMs, null);
    return { state, actions: [] };
  }
  if (drill.kind === "tempo-ear") return tempoEarStep(drill, state, input);
  return input.kind === "tick" ? holdStep(drill, state, input.reading) : { state, actions: [] };
}

/**
 * Live phase error between two decks, ms: how far B's beat is behind A's (positive) or ahead
 * (negative), wrapped to ±½ beat, on A's beat length. `aBeat` and `bBeat` are each deck's fractional
 * beat index on its own grid, read at the same heard moment.
 */
export function livePhaseMs(aBeat: number, bBeat: number, beatMsA: number): number {
  const difference = aBeat - bBeat;
  return (difference - Math.round(difference)) * beatMsA;
}

/**
 * The tempo-fader percent that puts deck B `apartPercent` off deck A: B's grid BPM × (1 + percent)
 * = A's BPM × (1 + apart).
 */
export function tempoPercentApart(bpmA: number, gridBpmB: number, apartPercent: number): number {
  return ((bpmA * (1 + apartPercent / 100)) / gridBpmB - 1) * 100;
}
