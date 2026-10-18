// The two-channel mixer graph: per channel trim → 3-band isolator → filter → (pre-fader tap) → channel
// fader → crossfader → master bus → master level. The pre-fader tap feeds the channel meter and the
// headphone CUE send (PFL), as on a DJ mixer. Every change is scheduled at the engine's scheduled time.

import {
  channelFaderGain,
  crossfaderGain,
  decibelsToGain,
  eqKnobToDecibels,
  filterKnobSettings,
  masterKnobToDecibels,
  trimKnobToDecibels,
} from "./curves.ts";
import type { CtxTime, DeckId } from "./types.ts";

export type EqBand = "low" | "mid" | "high";

/** Standard DJ isolator crossovers. */
export const LOW_MID_CROSSOVER_HZ = 250;
export const MID_HIGH_CROSSOVER_HZ = 2500;

/** Time constant for parameter changes: short enough to feel instant, long enough not to click. */
const SMOOTHING_SEC = 0.003;
/** After this many time constants a move to zero snaps to exactly zero (the exponential never gets there). */
const SNAP_AFTER_TIME_CONSTANTS = 10;
const BUTTERWORTH_Q = Math.SQRT1_2;
// Web Audio reads Q in dB for lowpass and highpass (https://webaudio.github.io/web-audio-api/#dom-biquadfilternode-q),
// but as a plain number for allpass.
const BUTTERWORTH_Q_DB = 20 * Math.log10(BUTTERWORTH_Q);

/** Supplies the context time at which a change made now should take effect. */
export type Scheduler = () => CtxTime;

function setSmoothly(param: AudioParam, value: number, when: CtxTime): void {
  // Drop anything still scheduled from an earlier change (such as its snap to zero), then glide.
  param.cancelScheduledValues(when);
  param.setTargetAtTime(value, when, SMOOTHING_SEC);
  if (value === 0) param.setValueAtTime(0, when + SNAP_AFTER_TIME_CONSTANTS * SMOOTHING_SEC);
}

/** Two cascaded Butterworth sections: a 24 dB/octave Linkwitz–Riley filter. */
function linkwitzRiley(context: BaseAudioContext, type: "lowpass" | "highpass", frequency: number) {
  const first = new BiquadFilterNode(context, { type, frequency, Q: BUTTERWORTH_Q_DB });
  const second = new BiquadFilterNode(context, { type, frequency, Q: BUTTERWORTH_Q_DB });
  first.connect(second);
  return { input: first, output: second };
}

/**
 * A 3-band isolator from Linkwitz–Riley crossovers. The low band also passes through the all-pass of the
 * upper crossover, so with every band at unity the bands sum to a flat magnitude response.
 */
class Isolator {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly bands: Readonly<Record<EqBand, GainNode>>;

  constructor(context: BaseAudioContext) {
    this.input = new GainNode(context);
    this.output = new GainNode(context);
    this.bands = { low: new GainNode(context), mid: new GainNode(context), high: new GainNode(context) };

    const lowPass = linkwitzRiley(context, "lowpass", LOW_MID_CROSSOVER_HZ);
    const upperAllPass = new BiquadFilterNode(context, { type: "allpass", frequency: MID_HIGH_CROSSOVER_HZ, Q: BUTTERWORTH_Q });
    this.input.connect(lowPass.input);
    lowPass.output.connect(upperAllPass).connect(this.bands.low);

    const aboveLow = linkwitzRiley(context, "highpass", LOW_MID_CROSSOVER_HZ);
    const midPass = linkwitzRiley(context, "lowpass", MID_HIGH_CROSSOVER_HZ);
    const highPass = linkwitzRiley(context, "highpass", MID_HIGH_CROSSOVER_HZ);
    this.input.connect(aboveLow.input);
    aboveLow.output.connect(midPass.input);
    aboveLow.output.connect(highPass.input);
    midPass.output.connect(this.bands.mid);
    highPass.output.connect(this.bands.high);

    for (const band of Object.values(this.bands)) band.connect(this.output);
  }
}

/**
 * The colour filter: a dry path, a low-pass path and a high-pass path, crossfaded by gains. The filter
 * types never change, so sweeping across the centre cannot click from a coefficient jump.
 */
class ColourFilter {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  private readonly lowPass: { filter: BiquadFilterNode; level: GainNode };
  private readonly highPass: { filter: BiquadFilterNode; level: GainNode };

  constructor(context: BaseAudioContext) {
    this.input = new GainNode(context);
    this.output = new GainNode(context);
    this.dry = new GainNode(context, { gain: 1 });
    this.input.connect(this.dry).connect(this.output);
    const path = (type: "lowpass" | "highpass", frequency: number) => {
      const filter = new BiquadFilterNode(context, { type, frequency });
      const level = new GainNode(context, { gain: 0 });
      this.input.connect(filter).connect(level).connect(this.output);
      return { filter, level };
    };
    this.lowPass = path("lowpass", 20_000);
    this.highPass = path("highpass", 20);
  }

  set(knob: number, when: CtxTime): void {
    const settings = filterKnobSettings(knob);
    setSmoothly(this.dry.gain, settings.kind === "off" ? 1 : 0, when);
    setSmoothly(this.lowPass.level.gain, settings.kind === "lowpass" ? 1 : 0, when);
    setSmoothly(this.highPass.level.gain, settings.kind === "highpass" ? 1 : 0, when);
    if (settings.kind === "off") return;
    const active = settings.kind === "lowpass" ? this.lowPass : this.highPass;
    setSmoothly(active.filter.frequency, settings.cutoffHz, when);
    setSmoothly(active.filter.Q, settings.resonanceDb, when);
  }
}

export class ChannelStrip {
  /** Decks connect here. Mono sources are up-mixed to stereo. */
  readonly input: GainNode;
  /** Post-trim, EQ and filter; pre-fader. Feeds the channel meter and the CUE send. */
  readonly preFader: GainNode;
  readonly output: GainNode;
  private readonly isolator: Isolator;
  private readonly colourFilter: ColourFilter;
  private readonly fader: GainNode;
  private readonly cueSend: GainNode;

  constructor(context: BaseAudioContext, cueBus: AudioNode) {
    this.input = new GainNode(context, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
    this.isolator = new Isolator(context);
    this.colourFilter = new ColourFilter(context);
    this.preFader = new GainNode(context);
    this.fader = new GainNode(context);
    this.output = new GainNode(context);
    this.cueSend = new GainNode(context, { gain: 0 });

    this.input.connect(this.isolator.input);
    this.isolator.output.connect(this.colourFilter.input);
    this.colourFilter.output.connect(this.preFader);
    this.preFader.connect(this.fader).connect(this.output);
    this.preFader.connect(this.cueSend).connect(cueBus);
  }

  setTrim(knob: number, when: CtxTime): void {
    setSmoothly(this.input.gain, decibelsToGain(trimKnobToDecibels(knob)), when);
  }

  setEq(band: EqBand, knob: number, when: CtxTime): void {
    setSmoothly(this.isolator.bands[band].gain, decibelsToGain(eqKnobToDecibels(knob)), when);
  }

  setFilter(knob: number, when: CtxTime): void {
    this.colourFilter.set(knob, when);
  }

  setFader(position: number, when: CtxTime): void {
    setSmoothly(this.fader.gain, channelFaderGain(position), when);
  }

  setCrossfaderGain(gain: number, when: CtxTime): void {
    setSmoothly(this.output.gain, gain, when);
  }

  setCue(on: boolean, when: CtxTime): void {
    setSmoothly(this.cueSend.gain, on ? 1 : 0, when);
  }

  disconnect(): void {
    this.input.disconnect();
    this.preFader.disconnect();
    this.output.disconnect();
  }
}

export interface MixerState {
  /** 0 (full A) … 1 (full B). */
  crossfader: number;
  masterLevel: number;
}

export class Mixer {
  readonly strips: Readonly<Record<DeckId, ChannelStrip>>;
  /** Post master level: what the audience hears. */
  readonly master: GainNode;
  /** Sum of the channels with CUE on, pre-fader. */
  readonly cue: GainNode;
  private readonly masterBus: GainNode;
  private readonly state: MixerState = { crossfader: 0.5, masterLevel: 0 };

  constructor(context: BaseAudioContext) {
    this.masterBus = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
    this.master = new GainNode(context);
    this.cue = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
    this.masterBus.connect(this.master);
    this.strips = { A: new ChannelStrip(context, this.cue), B: new ChannelStrip(context, this.cue) };
    for (const strip of Object.values(this.strips)) strip.output.connect(this.masterBus);
    // Start where the state says (the centre, −3 dB each), as the Checks read it: not at unity.
    for (const deck of ["A", "B"] as const) this.strips[deck].output.gain.value = crossfaderGain(deck, this.state.crossfader);
  }

  snapshot(): Readonly<MixerState> {
    return { ...this.state };
  }

  setCrossfader(position: number, when: CtxTime): void {
    this.state.crossfader = position;
    this.strips.A.setCrossfaderGain(crossfaderGain("A", position), when);
    this.strips.B.setCrossfaderGain(crossfaderGain("B", position), when);
  }

  setMasterLevel(knob: number, when: CtxTime): void {
    this.state.masterLevel = knob;
    setSmoothly(this.master.gain, decibelsToGain(masterKnobToDecibels(knob)), when);
  }

  disconnect(): void {
    for (const strip of Object.values(this.strips)) strip.disconnect();
    this.masterBus.disconnect();
    this.master.disconnect();
    this.cue.disconnect();
  }
}
