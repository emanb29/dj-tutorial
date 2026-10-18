// A deck's sound source. Two interchangeable voices sit behind one seam:
// - RateVoice: AudioBufferSourceNode playbackRate. Pitch follows tempo (Master Tempo off).
// - StretchVoice: signalsmith-stretch in an AudioWorklet. Pitch stays put (Master Tempo on).
// Both take the same schedule, so the deck's playhead model is the same either way.
//
// Loops (RateVoice): the source plays a copy of the track from the loop start (or the playhead, if
// earlier) to the loop end, with the source's own sample-accurate looping. The copy's last few ms are
// crossfaded into the audio just before the loop start, so the wrap from end to start is continuous:
// no click at the seam, and the loop is exactly as long as the model says. Loop points are whole samples
// (the deck rounds them), so the audio wraps exactly where the model does.
// Replacing a playing source (a seek, a hot cue, a loop on or off) crossfades the two over SWITCH_FADE_SEC.

import type { StretchNode } from "signalsmith-stretch";
import type { LoopSpan } from "@shared/attempt.ts";
import type { PendingWork } from "./pending-work.ts";
import type { CtxTime } from "./types.ts";

export interface DeckVoice {
  /** Starts at `positionSec`, looping `loop` when one is on. Replaces whatever plays now. */
  play(when: CtxTime, positionSec: number, rate: number, loop: LoopSpan | null): void;
  /** `positionSec` is the model's position at `when` (the stretcher needs it inside a loop). */
  setRate(when: CtxTime, rate: number, positionSec: number): void;
  stop(when: CtxTime): void;
}

/** The loop seam's crossfade, baked into the looped copy. */
export const SEAM_FADE_SEC = 0.005;
/** How long a replaced source fades out while its replacement fades in. */
export const SWITCH_FADE_SEC = 0.004;
/** Looped copies kept per voice, so pausing and playing in a loop does not copy the audio again. */
const LOOP_COPIES_KEPT = 4;

interface Playing {
  readonly source: AudioBufferSourceNode;
  readonly level: GainNode;
}

export class RateVoice implements DeckVoice {
  private playing: Playing | null = null;
  private readonly copies = new Map<string, AudioBuffer>();

  constructor(
    private readonly context: BaseAudioContext,
    private readonly buffer: AudioBuffer,
    private readonly output: AudioNode,
  ) {}

  play(when: CtxTime, positionSec: number, rate: number, loop: LoopSpan | null): void {
    const replacing = this.playing;
    // Source nodes are one-shot: every start is a new node.
    const level = new GainNode(this.context, { gain: replacing === null ? 1 : 0 });
    const from = loop === null ? 0 : Math.min(loop.start, positionSec);
    const buffer = loop === null ? this.buffer : this.loopCopy(loop, from);
    const source = new AudioBufferSourceNode(this.context, { buffer, playbackRate: rate });
    if (loop !== null) {
      source.loop = true;
      source.loopStart = loop.start - from;
      source.loopEnd = loop.end - from;
    }
    source.connect(level).connect(this.output);
    source.onended = () => {
      source.disconnect();
      level.disconnect();
    };
    source.start(when, Math.max(0, positionSec - from));
    if (replacing !== null) {
      level.gain.setValueAtTime(0, when);
      level.gain.linearRampToValueAtTime(1, when + SWITCH_FADE_SEC);
      replacing.level.gain.cancelScheduledValues(when);
      replacing.level.gain.setValueAtTime(1, when);
      replacing.level.gain.linearRampToValueAtTime(0, when + SWITCH_FADE_SEC);
      replacing.source.stop(when + SWITCH_FADE_SEC);
    }
    this.playing = { source, level };
  }

  setRate(when: CtxTime, rate: number): void {
    this.playing?.source.playbackRate.setValueAtTime(rate, when);
  }

  stop(when: CtxTime): void {
    this.playing?.source.stop(when);
    this.playing = null;
  }

  /**
   * The track from `from` to the loop end, its last SEAM_FADE_SEC crossfaded into the audio just
   * before the loop start (silence before the track's start), so looping it is continuous.
   */
  private loopCopy(loop: LoopSpan, from: number): AudioBuffer {
    const rate = this.buffer.sampleRate;
    const first = Math.round(from * rate);
    const start = Math.round(loop.start * rate);
    const end = Math.min(this.buffer.length, Math.round(loop.end * rate));
    const key = `${String(first)}:${String(start)}:${String(end)}`;
    const kept = this.copies.get(key);
    if (kept !== undefined) return kept;
    const length = Math.max(1, end - first);
    const fade = Math.max(0, Math.min(Math.round(SEAM_FADE_SEC * rate), end - start - 1));
    const copy = new AudioBuffer({ length, numberOfChannels: this.buffer.numberOfChannels, sampleRate: rate });
    for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) {
      const track = this.buffer.getChannelData(channel);
      const data = track.slice(first, end);
      for (let index = 0; index < fade; index++) {
        const into = (index + 1) / fade;
        const before = track[start - fade + index] ?? 0;
        const at = length - fade + index;
        data[at] = (data[at] ?? 0) * (1 - into) + before * into;
      }
      copy.copyToChannel(data, channel);
    }
    this.copies.set(key, copy);
    if (this.copies.size > LOOP_COPIES_KEPT) this.copies.delete(this.copies.keys().next().value ?? key);
    return copy;
  }
}

/**
 * Calls into the stretch worklet are messages, tracked so the engine can await them (AudioEngine.settled).
 * The stretcher compensates its own latency only for changes scheduled at least `latency()` ahead, so the
 * engine schedules a Master Tempo deck that far in the future (AudioEngineOptions.lookaheadSec).
 * The stretcher loops by itself (`loopStart`/`loopEnd`), checking once per render quantum, so a Master
 * Tempo loop wraps up to 128 samples (2.7 ms at 48 kHz) after the model says; its STFT smooths the seam.
 * Every change names the input position, so the stretcher never runs on from an unwrapped one.
 */
export class StretchVoice implements DeckVoice {
  constructor(
    private readonly node: StretchNode,
    private readonly pending: PendingWork,
  ) {}

  play(when: CtxTime, positionSec: number, rate: number, loop: LoopSpan | null): void {
    this.pending.track(this.node.schedule({ output: when, input: positionSec, rate, active: true, loopStart: loop?.start ?? 0, loopEnd: loop?.end ?? 0 }));
  }

  setRate(when: CtxTime, rate: number, positionSec: number): void {
    this.pending.track(this.node.schedule({ output: when, input: positionSec, rate }));
  }

  stop(when: CtxTime): void {
    this.pending.track(this.node.schedule({ output: when, active: false }));
  }
}
