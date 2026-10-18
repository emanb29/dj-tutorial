// Beat FX, DDJ-FLX4 style, with one effect in v1: ECHO, a beat-synced delay. CH SELECT picks what it
// takes in: channel 1 or 2 after its fader and the crossfader, or the whole master. The echoes are
// summed into the master after that tap, so turning the effect OFF (or closing the channel's fader)
// stops new sound going in while the repeats already in the delay ring out, as on a real mixer: that is
// the echo out. LEVEL/DEPTH is the echoes' level; the dry sound is never touched.

import type { BeatFxChannel, BeatFxSnapshot } from "@shared/attempt.ts";
import type { CtxTime } from "./types.ts";

export type { BeatFxChannel, BeatFxSnapshot } from "@shared/attempt.ts";

/** The BEAT ◀/▶ steps, in beats, as on rekordbox's ECHO (the longest that fit a 4-second delay at 60 BPM). */
export const BEAT_FX_BEATS = [0.125, 0.25, 0.5, 0.75, 1, 2, 4] as const;
/** Each repeat is this fraction of the one before: about −6 dB, so a full-depth tail dies in about 6 repeats. */
export const ECHO_FEEDBACK = 0.5;
const MAX_DELAY_SEC = 4;
const SMOOTHING_SEC = 0.003;
/** Delay-time changes glide this slowly, so a tempo change does not zip. */
const DELAY_GLIDE_SEC = 0.05;
const CHANNELS: readonly BeatFxChannel[] = ["A", "B", "master"];

export class BeatFx {
  /** The echoes alone: summed into the master, and metered as the FX return. */
  readonly wet: GainNode;
  private readonly sends: Readonly<Record<BeatFxChannel, GainNode>>;
  private readonly delay: DelayNode;
  private state: BeatFxSnapshot;
  private delaySec = 0.5;

  constructor(
    context: BaseAudioContext,
    taps: Readonly<Record<BeatFxChannel, AudioNode>>,
    initial: BeatFxSnapshot,
  ) {
    this.state = initial;
    const input = new GainNode(context);
    this.delay = new DelayNode(context, { maxDelayTime: MAX_DELAY_SEC, delayTime: this.delaySec });
    const feedback = new GainNode(context, { gain: ECHO_FEEDBACK });
    this.wet = new GainNode(context, { gain: initial.depth });
    this.sends = {
      A: new GainNode(context, { gain: 0 }),
      B: new GainNode(context, { gain: 0 }),
      master: new GainNode(context, { gain: 0 }),
    };
    for (const channel of CHANNELS) taps[channel].connect(this.sends[channel]).connect(input);
    input.connect(this.delay);
    this.delay.connect(feedback).connect(this.delay);
    this.delay.connect(this.wet);
    this.apply(0);
  }

  snapshot(): BeatFxSnapshot {
    return this.state;
  }

  set(changes: Partial<BeatFxSnapshot>, when: CtxTime): void {
    this.state = { ...this.state, ...changes };
    this.apply(when);
  }

  /** The delay for the BPM the effect follows (the selected deck's, heard). */
  setTempo(bpm: number, when: CtxTime): void {
    const delaySec = Math.min(MAX_DELAY_SEC, (this.state.beats * 60) / bpm);
    if (Math.abs(delaySec - this.delaySec) < 1e-6) return;
    this.delaySec = delaySec;
    this.delay.delayTime.cancelScheduledValues(when);
    this.delay.delayTime.setTargetAtTime(delaySec, when, DELAY_GLIDE_SEC);
  }

  disconnect(): void {
    for (const send of Object.values(this.sends)) send.disconnect();
    this.delay.disconnect();
    this.wet.disconnect();
  }

  private apply(when: CtxTime): void {
    for (const channel of CHANNELS) {
      const open = this.state.on && this.state.channel === channel ? 1 : 0;
      this.sends[channel].gain.cancelScheduledValues(when);
      this.sends[channel].gain.setTargetAtTime(open, when, SMOOTHING_SEC);
    }
    this.wet.gain.cancelScheduledValues(when);
    this.wet.gain.setTargetAtTime(this.state.depth, when, SMOOTHING_SEC);
  }
}
