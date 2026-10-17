// A deck's sound source. Two interchangeable voices sit behind one seam:
// - RateVoice: AudioBufferSourceNode playbackRate. Pitch follows tempo (Master Tempo off).
// - StretchVoice: signalsmith-stretch in an AudioWorklet. Pitch stays put (Master Tempo on).
// Both take the same schedule, so the deck's playhead model is the same either way.

import type { StretchNode } from "signalsmith-stretch";
import type { PendingWork } from "./pending-work.ts";
import type { CtxTime } from "./types.ts";

export interface DeckVoice {
  play(when: CtxTime, positionSec: number, rate: number): void;
  setRate(when: CtxTime, rate: number): void;
  stop(when: CtxTime): void;
}

export class RateVoice implements DeckVoice {
  private source: AudioBufferSourceNode | null = null;

  constructor(
    private readonly context: BaseAudioContext,
    private readonly buffer: AudioBuffer,
    private readonly output: AudioNode,
  ) {}

  play(when: CtxTime, positionSec: number, rate: number): void {
    this.stop(when);
    // Source nodes are one-shot: every start is a new node.
    const source = new AudioBufferSourceNode(this.context, { buffer: this.buffer, playbackRate: rate });
    source.connect(this.output);
    source.onended = () => {
      source.disconnect();
    };
    source.start(when, positionSec);
    this.source = source;
  }

  setRate(when: CtxTime, rate: number): void {
    this.source?.playbackRate.setValueAtTime(rate, when);
  }

  stop(when: CtxTime): void {
    this.source?.stop(when);
    this.source = null;
  }
}

/**
 * Calls into the stretch worklet are messages, tracked so the engine can await them (AudioEngine.settled).
 * The stretcher compensates its own latency only for changes scheduled at least `latency()` ahead, so the
 * engine schedules a Master Tempo deck that far in the future (AudioEngineOptions.lookaheadSec).
 */
export class StretchVoice implements DeckVoice {
  constructor(
    private readonly node: StretchNode,
    private readonly pending: PendingWork,
  ) {}

  play(when: CtxTime, positionSec: number, rate: number): void {
    this.pending.track(this.node.schedule({ output: when, input: positionSec, rate, active: true }));
  }

  setRate(when: CtxTime, rate: number): void {
    this.pending.track(this.node.schedule({ output: when, rate }));
  }

  stop(when: CtxTime): void {
    this.pending.track(this.node.schedule({ output: when, active: false }));
  }
}
