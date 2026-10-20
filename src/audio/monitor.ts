// Where the master and headphone-cue buses go. A laptop has one stereo output, so the default for
// headphone work is split cue: cue in the left ear, master in the right. A second output device (or a
// controller's own sound card) can be another MonitorOutput later without touching the mixer.
// attach() is idempotent for the same buses; detach() removes every connection attach() made.

export interface MonitorBuses {
  readonly context: BaseAudioContext;
  /** Stereo master, post master level. */
  readonly master: AudioNode;
  /** Stereo headphone cue bus (pre-fader channels with CUE on). */
  readonly cue: AudioNode;
}

export interface MonitorOutput {
  readonly kind: string;
  attach(buses: MonitorBuses): void;
  /** Cue/master mix knob: 0 is cue only, 1 is master only. */
  setCueMix(mix: number): void;
  /**
   * Headphone LEVEL as an amplitude gain (1 is unity) on the headphone path. Outputs without one ignore
   * it, and so does the FLX4's PHONES jack, whose own amp applies the knob (device-monitors.ts).
   */
  setHeadphoneGain(gain: number): void;
  detach(): void;
  /**
   * How much later than the context's output timestamp the master is heard, when the output delays it
   * (TwoDeviceMonitor lining up two devices). The engine's clock subtracts it. Absent = 0.
   */
  masterDelaySec?(): number;
}

function sameBuses(a: MonitorBuses | null, b: MonitorBuses): boolean {
  return a !== null && a.context === b.context && a.master === b.master && a.cue === b.cue;
}

/** Speakers only: the stereo master goes to the output; the cue bus is not heard. */
export class MasterOnlyMonitor implements MonitorOutput {
  readonly kind = "master-only";
  private attached: MonitorBuses | null = null;

  attach(buses: MonitorBuses): void {
    if (sameBuses(this.attached, buses)) return;
    this.detach();
    buses.master.connect(buses.context.destination);
    this.attached = buses;
  }

  setCueMix(): void {
    // No headphone path to mix.
  }

  setHeadphoneGain(): void {
    // No headphone path to scale.
  }

  detach(): void {
    if (this.attached === null) return;
    this.attached.master.disconnect(this.attached.context.destination);
    this.attached = null;
  }
}

interface SplitCueNodes {
  readonly buses: MonitorBuses;
  readonly cueLevel: GainNode;
  readonly masterInLeft: GainNode;
  readonly masterRight: GainNode;
  readonly merger: ChannelMergerNode;
}

/**
 * Split cue on one stereo output. Left (the headphone ear) = mono (cue × (1 − mix) + master × mix) × the
 * headphone gain; right = mono master.
 * Mono is the speaker down-mix (L + R) / 2.
 */
export class SplitCueMonitor implements MonitorOutput {
  readonly kind = "split-cue";
  private nodes: SplitCueNodes | null = null;
  private cueMix = 0;
  private headphoneGain = 1;

  attach(buses: MonitorBuses): void {
    if (sameBuses(this.nodes?.buses ?? null, buses)) return;
    this.detach();
    const { context } = buses;
    const mono = () => new GainNode(context, { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    const nodes: SplitCueNodes = {
      buses,
      cueLevel: mono(),
      masterInLeft: mono(),
      masterRight: mono(),
      merger: new ChannelMergerNode(context, { numberOfInputs: 2 }),
    };
    buses.cue.connect(nodes.cueLevel).connect(nodes.merger, 0, 0);
    buses.master.connect(nodes.masterInLeft).connect(nodes.merger, 0, 0);
    buses.master.connect(nodes.masterRight).connect(nodes.merger, 0, 1);
    nodes.merger.connect(context.destination);
    this.nodes = nodes;
    this.applyCueMix();
  }

  setCueMix(mix: number): void {
    this.cueMix = mix;
    this.applyCueMix();
  }

  setHeadphoneGain(gain: number): void {
    this.headphoneGain = gain;
    this.applyCueMix();
  }

  detach(): void {
    const nodes = this.nodes;
    if (nodes === null) return;
    nodes.buses.cue.disconnect(nodes.cueLevel);
    nodes.buses.master.disconnect(nodes.masterInLeft);
    nodes.buses.master.disconnect(nodes.masterRight);
    for (const node of [nodes.cueLevel, nodes.masterInLeft, nodes.masterRight, nodes.merger]) node.disconnect();
    this.nodes = null;
  }

  private applyCueMix(): void {
    if (this.nodes === null) return;
    const now = this.nodes.buses.context.currentTime;
    this.nodes.cueLevel.gain.setTargetAtTime((1 - this.cueMix) * this.headphoneGain, now, 0.003);
    this.nodes.masterInLeft.gain.setTargetAtTime(this.cueMix * this.headphoneGain, now, 0.003);
  }
}
