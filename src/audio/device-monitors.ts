// Monitor outputs beyond one stereo device (output.ts has the modes):
// - ControllerCueMonitor: a 4-channel sound card such as the DDJ-FLX4's: master on 1/2, cue on 3/4.
// - TwoDeviceMonitor: master to this context's device, the headphone cue to another device through a
//   HeadphoneSink, the two paths lined up by delaying the earlier one (lineUpDelays). The sink is a
//   stereo device (deviceHeadphoneSink) or the FLX4's headphone jack (controllerPhonesSink, which puts
//   the cue on its outputs 3/4 with ControllerCueMonitor and silence on 1/2).
// Both mix the headphone path as SplitCueMonitor does (cue × (1 − mix) + master × mix, × headphone
// gain), but in stereo, since each has a whole stereo output for the headphones. The FLX4's PHONES jack
// is the exception for the gain: its own headphone amp applies HEADPHONES LEVEL (Mixxx maps MIXING to
// software and LEVEL to nothing; docs/research/flx4-midi.md), so the app leaves the gain at 1 there
// rather than turning the headphones down twice.

import type { MonitorBuses, MonitorOutput } from "./monitor.ts";
import { lineUpDelays } from "./output.ts";

const SMOOTHING_SEC = 0.003;
const MAX_DELAY_SEC = 1;

interface HeadphoneMix {
  readonly cueLevel: GainNode;
  readonly masterLevel: GainNode;
  /** The mixed headphone signal (stereo). */
  readonly out: GainNode;
}

function headphoneMix(buses: MonitorBuses): HeadphoneMix {
  const { context } = buses;
  const stereo = () => new GainNode(context, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
  const mix: HeadphoneMix = { cueLevel: stereo(), masterLevel: stereo(), out: stereo() };
  buses.cue.connect(mix.cueLevel).connect(mix.out);
  buses.master.connect(mix.masterLevel).connect(mix.out);
  return mix;
}

function applyMix(mix: HeadphoneMix, context: BaseAudioContext, cueMix: number, headphoneGain: number): void {
  const now = context.currentTime;
  mix.cueLevel.gain.setTargetAtTime((1 - cueMix) * headphoneGain, now, SMOOTHING_SEC);
  mix.masterLevel.gain.setTargetAtTime(cueMix * headphoneGain, now, SMOOTHING_SEC);
}

function disconnectMix(buses: MonitorBuses, mix: HeadphoneMix): void {
  buses.cue.disconnect(mix.cueLevel);
  buses.master.disconnect(mix.masterLevel);
  for (const node of [mix.cueLevel, mix.masterLevel, mix.out]) node.disconnect();
}

/** Four channels on one device: master to outputs 1/2, the headphone cue to 3/4. */
export class ControllerCueMonitor implements MonitorOutput {
  readonly kind = "controller-cue";
  private attached: { buses: MonitorBuses; mix: HeadphoneMix; masterSplit: ChannelSplitterNode; cueSplit: ChannelSplitterNode; merger: ChannelMergerNode } | null = null;
  private cueMix = 0;
  private readonly headphoneGain = 1;

  /** Whether a destination can take the four channels. */
  static fits(context: BaseAudioContext): boolean {
    return context.destination.maxChannelCount >= 4;
  }

  attach(buses: MonitorBuses): void {
    if (this.attached?.buses.master === buses.master && this.attached.buses.cue === buses.cue) return;
    this.detach();
    const { context } = buses;
    const { destination } = context;
    destination.channelCount = 4;
    destination.channelCountMode = "explicit";
    destination.channelInterpretation = "discrete";
    const mix = headphoneMix(buses);
    const masterSplit = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const cueSplit = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const merger = new ChannelMergerNode(context, { numberOfInputs: 4 });
    buses.master.connect(masterSplit);
    masterSplit.connect(merger, 0, 0);
    masterSplit.connect(merger, 1, 1);
    mix.out.connect(cueSplit);
    cueSplit.connect(merger, 0, 2);
    cueSplit.connect(merger, 1, 3);
    merger.connect(destination);
    this.attached = { buses, mix, masterSplit, cueSplit, merger };
    applyMix(mix, context, this.cueMix, this.headphoneGain);
  }

  setCueMix(mix: number): void {
    this.cueMix = mix;
    if (this.attached !== null) applyMix(this.attached.mix, this.attached.buses.context, this.cueMix, this.headphoneGain);
  }

  setHeadphoneGain(): void {
    // The FLX4's headphone amp applies HEADPHONES LEVEL to outputs 3/4 itself.
  }

  detach(): void {
    const attached = this.attached;
    if (attached === null) return;
    attached.buses.master.disconnect(attached.masterSplit);
    disconnectMix(attached.buses, attached.mix);
    for (const node of [attached.masterSplit, attached.cueSplit, attached.merger]) node.disconnect();
    this.attached = null;
  }
}

/** Where the headphone path leaves the engine's context for another device. */
export interface HeadphoneSink {
  /** Whether the device's own headphone amp applies HEADPHONES LEVEL (the FLX4's PHONES jack), so the app must not. */
  readonly levelOnDevice: boolean;
  /** The node in `context` that leads to the headphone device. */
  open(context: BaseAudioContext): AudioNode;
  /** The headphone path's own output latency, seconds. */
  latencySec(): number;
  close(): void;
}

/**
 * Puts a stereo headphone signal on a four-channel sound card's headphone outputs (3/4) and silence on
 * its master outputs (1/2), through ControllerCueMonitor with a silent master bus: the FLX4's headphone
 * jack, with nothing on its MASTER OUT. Returns the undo.
 */
export function routeToControllerPhones(headphones: AudioNode, output: BaseAudioContext): () => void {
  const monitor = new ControllerCueMonitor();
  const silentMaster = new GainNode(output, { channelCount: 2, channelCountMode: "explicit" });
  const cue = new GainNode(output, { channelCount: 2, channelCountMode: "explicit" });
  headphones.connect(cue);
  // The headphone mix and level are applied before the signal gets here (TwoDeviceMonitor).
  monitor.attach({ context: output, master: silentMaster, cue });
  monitor.setCueMix(0);
  return () => {
    monitor.detach();
    headphones.disconnect(cue);
  };
}

/**
 * The headphone path as a second AudioContext (from `openOutput`), fed by a MediaStream from the
 * engine's context and put on its outputs by `route`. The engine's context stays the one that owns the
 * decks and the clock.
 */
function streamHeadphoneSink(openOutput: () => AudioContext, route: (headphones: AudioNode, output: AudioContext) => () => void, levelOnDevice: boolean): HeadphoneSink {
  let output: AudioContext | null = null;
  let stop: (() => void) | null = null;
  return {
    levelOnDevice,
    open(context) {
      const streamOut = new MediaStreamAudioDestinationNode(context as AudioContext, { channelCount: 2 });
      const headphones = openOutput();
      const unroute = route(new MediaStreamAudioSourceNode(headphones, { mediaStream: streamOut.stream }), headphones);
      const follow = () => {
        // Starts and stops with the engine's context (which starts on the Learner's click).
        if (context.state === "running") void headphones.resume();
        else if (context.state === "suspended") void headphones.suspend();
      };
      context.addEventListener("statechange", follow);
      follow();
      output = headphones;
      stop = () => {
        context.removeEventListener("statechange", follow);
        unroute();
        streamOut.disconnect();
      };
      return streamOut;
    },
    latencySec() {
      return output === null ? 0 : output.outputLatency + output.baseLatency;
    },
    close() {
      stop?.();
      stop = null;
      void output?.close();
      output = null;
    },
  };
}

/** The headphone device as a second stereo AudioContext with its own sinkId. */
export function deviceHeadphoneSink(deviceId: string): HeadphoneSink {
  return streamHeadphoneSink(
    () => new AudioContext({ latencyHint: "interactive", sinkId: deviceId } as AudioContextOptions),
    (headphones, output) => {
      headphones.connect(output.destination);
      return () => {
        headphones.disconnect();
      };
    },
    false,
  );
}

/**
 * The FLX4's headphone jack as the headphone device: a second AudioContext on its four-channel card,
 * cue on 3/4 and silence on 1/2 (routeToControllerPhones). `openOutput` gives that context; the caller
 * has checked it shows four outputs (output-routing.ts).
 */
export function controllerPhonesSink(openOutput: () => AudioContext): HeadphoneSink {
  return streamHeadphoneSink(openOutput, routeToControllerPhones, true);
}

/**
 * The master to this context's device (speakers), the headphone cue to another (headphones). The
 * earlier path is delayed so a beat lands in both at once; `masterDelaySec` tells the engine's clock how
 * much later than its output timestamp the master is heard.
 */
export class TwoDeviceMonitor implements MonitorOutput {
  readonly kind = "two-devices";
  private attached: { buses: MonitorBuses; mix: HeadphoneMix; masterDelay: DelayNode; cueDelay: DelayNode; sink: AudioNode } | null = null;
  private cueMix = 0;
  private headphoneGain = 1;
  private delays = { masterDelaySec: 0, cueDelaySec: 0 };

  constructor(
    private readonly headphones: HeadphoneSink,
    private headphoneOffsetMs: number,
    /** The master device's output latency, seconds; defaults to the context's outputLatency. */
    private readonly masterLatencySec: (context: BaseAudioContext) => number = (context) => (context instanceof AudioContext ? context.outputLatency : 0),
  ) {}

  attach(buses: MonitorBuses): void {
    if (this.attached?.buses.master === buses.master && this.attached.buses.cue === buses.cue) return;
    this.detach();
    const { context } = buses;
    const mix = headphoneMix(buses);
    const masterDelay = new DelayNode(context, { maxDelayTime: MAX_DELAY_SEC });
    const cueDelay = new DelayNode(context, { maxDelayTime: MAX_DELAY_SEC });
    const sink = this.headphones.open(context);
    buses.master.connect(masterDelay).connect(context.destination);
    mix.out.connect(cueDelay).connect(sink);
    this.attached = { buses, mix, masterDelay, cueDelay, sink };
    applyMix(mix, context, this.cueMix, this.headphoneGain);
    this.lineUp();
    // Output latencies are known once the context runs; line up again then.
    context.addEventListener("statechange", this.lineUp);
  }

  /** How much later than the context's output timestamp the master is heard (its delay). */
  masterDelaySec(): number {
    return this.delays.masterDelaySec;
  }

  cueDelaySec(): number {
    return this.delays.cueDelaySec;
  }

  /** The Learner's correction after a click test: positive when the headphones still sound late. */
  setHeadphoneOffset(ms: number): void {
    this.headphoneOffsetMs = ms;
    this.lineUp();
  }

  setCueMix(mix: number): void {
    this.cueMix = mix;
    if (this.attached !== null) applyMix(this.attached.mix, this.attached.buses.context, this.cueMix, this.headphoneGain);
  }

  setHeadphoneGain(gain: number): void {
    // The FLX4's jack turns itself down (levelOnDevice); a plain headphone device has only this gain.
    if (this.headphones.levelOnDevice) return;
    this.headphoneGain = gain;
    if (this.attached !== null) applyMix(this.attached.mix, this.attached.buses.context, this.cueMix, this.headphoneGain);
  }

  detach(): void {
    const attached = this.attached;
    if (attached === null) return;
    attached.buses.context.removeEventListener("statechange", this.lineUp);
    attached.buses.master.disconnect(attached.masterDelay);
    disconnectMix(attached.buses, attached.mix);
    for (const node of [attached.masterDelay, attached.cueDelay]) node.disconnect();
    this.headphones.close();
    this.attached = null;
  }

  private readonly lineUp = (): void => {
    const attached = this.attached;
    if (attached === null) return;
    const { context } = attached.buses;
    this.delays = lineUpDelays({ masterSec: this.masterLatencySec(context), headphoneSec: this.headphones.latencySec() }, this.headphoneOffsetMs);
    attached.masterDelay.delayTime.setValueAtTime(this.delays.masterDelaySec, context.currentTime);
    attached.cueDelay.delayTime.setValueAtTime(this.delays.cueDelaySec, context.currentTime);
  };
}
