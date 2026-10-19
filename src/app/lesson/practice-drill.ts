// Runs a by-ear practice drill (src/lessons/drill.ts) on the engine: reads the decks live each tick,
// passes the Learner's tempo moves and Ready presses on, and carries out what the drill asks (start the
// next round, count a rep, show a line or the covered displays). The pure drill decides; this only
// reads and acts.
import type { AudioEngine } from "@audio";
import { drillReveals, drillStep, livePhaseMs, startDrill, type DrillState, type DrillStep, type LessonTrack, type Observation, type PracticeDrill, type RoundStart } from "@lessons";
import type { DeckId } from "@shared/attempt.ts";

export interface DrillStatus {
  /** One short line of feedback under the caption; null for none. */
  readonly line: string | null;
  /** Show the covered displays (BPM, phase meter) now: between rounds only. */
  readonly reveal: boolean;
}

export const NO_DRILL_STATUS: DrillStatus = { line: null, reveal: false };

export interface LiveReading {
  readonly nowMs: number;
  readonly phaseMs: number | null;
  readonly bpmA: number | null;
  readonly bpmB: number | null;
  readonly barMs: number;
}

/**
 * The decks as heard now: the phase error between them (ms, positive = B behind A; null unless both
 * play), each deck's tempo-fader BPM (the jog bend left out, as the Checks read it) and A's bar.
 */
export function liveReading(engine: Pick<AudioEngine, "playhead" | "deckState">, tracks: Readonly<Record<DeckId, LessonTrack | null>>): LiveReading {
  const stateA = engine.deckState("A");
  const stateB = engine.deckState("B");
  const bpm = (deck: DeckId, rate: number) => {
    const track = tracks[deck];
    return track === null ? null : track.grid.bpm * rate;
  };
  const bpmA = bpm("A", stateA.tempoRate);
  const bpmB = bpm("B", stateB.tempoRate);
  const beatMsA = bpmA === null ? 500 : 60_000 / (bpmA * (1 + stateA.jogBend));
  const a = engine.playhead("A");
  const b = engine.playhead("B");
  const both = stateA.playing && stateB.playing && a.ok && b.ok && a.beat !== null && b.beat !== null;
  return {
    nowMs: performance.now(),
    phaseMs: both ? livePhaseMs(a.beat, b.beat, beatMsA) : null,
    bpmA,
    bpmB,
    barMs: 4 * beatMsA,
  };
}

export interface DrillHooks {
  readonly observe: (observation: Observation) => void;
  readonly status: (status: DrillStatus) => void;
  readonly startRound: (round: RoundStart) => void;
}

export class DrillRunner {
  private state: DrillState;
  private shown: DrillStatus = NO_DRILL_STATUS;

  constructor(
    private readonly drill: PracticeDrill,
    private readonly read: () => LiveReading,
    private readonly hooks: DrillHooks,
  ) {
    const first = startDrill(drill, performance.now());
    this.state = first.state;
    this.apply(first);
  }

  tick(): void {
    this.apply(drillStep(this.drill, this.state, { kind: "tick", reading: this.read() }));
  }

  tempoMoved(deck: DeckId): void {
    this.apply(drillStep(this.drill, this.state, { kind: "tempo-move", deck, reading: this.read() }));
  }

  ready(): void {
    this.apply(drillStep(this.drill, this.state, { kind: "ready", reading: this.read() }));
  }

  /** The round's clock starts again now: it waited for the Learner to match the controller. */
  restartRound(): void {
    this.state = { ...this.state, roundStartMs: performance.now(), heldFromMs: null, gapBpm: null };
  }

  /** Stops showing anything (practice is over). */
  stop(): void {
    this.shown = NO_DRILL_STATUS;
    this.hooks.status(NO_DRILL_STATUS);
  }

  private apply(step: DrillStep): void {
    this.state = step.state;
    for (const action of step.actions) {
      if (action.kind === "start-round") this.hooks.startRound(action.round);
      else this.hooks.observe(action.observation);
    }
    const status: DrillStatus = { line: this.state.line, reveal: drillReveals(this.state) };
    if (status.line === this.shown.line && status.reveal === this.shown.reveal) return;
    this.shown = status;
    this.hooks.status(status);
  }
}
