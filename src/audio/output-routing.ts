// Builds the AudioContext and monitor output for an output plan (output.ts), in the browser. A
// controller plan whose device shows fewer than four channels falls back to split cue on this computer
// rather than ever putting the cue on the speakers.

import { ControllerCueMonitor, deviceHeadphoneSink, TwoDeviceMonitor } from "./device-monitors.ts";
import { MasterOnlyMonitor, SplitCueMonitor, type MonitorOutput } from "./monitor.ts";
import type { OutputPlan } from "./output.ts";

export interface OutputRouting {
  readonly context: AudioContext;
  readonly monitor: MonitorOutput;
  /** The plan as built: a fallback says so. */
  readonly plan: OutputPlan;
}

const INTERACTIVE = { latencyHint: "interactive" } as const;

function onThisComputer(headphones: boolean, fallback: string | null): OutputRouting {
  return {
    context: new AudioContext(INTERACTIVE),
    monitor: headphones ? new SplitCueMonitor() : new MasterOnlyMonitor(),
    plan: { kind: "split-cue", sinkId: null, fallback },
  };
}

export function createOutputRouting(plan: OutputPlan, options: { readonly headphones: boolean }): OutputRouting {
  switch (plan.kind) {
    case "split-cue":
      return onThisComputer(options.headphones, plan.fallback);
    case "controller": {
      const context = new AudioContext({ ...INTERACTIVE, sinkId: plan.sinkId } as AudioContextOptions);
      if (!ControllerCueMonitor.fits(context)) {
        const channels = context.destination.maxChannelCount;
        void context.close();
        return onThisComputer(options.headphones, `${plan.label} shows ${String(channels)} outputs, not 4`);
      }
      return { context, monitor: new ControllerCueMonitor(), plan };
    }
    case "two-devices": {
      const context = new AudioContext({ ...INTERACTIVE, sinkId: plan.sinkId } as AudioContextOptions);
      // Lessons without headphone cueing play the master only, with no delay to line up.
      const monitor = options.headphones ? new TwoDeviceMonitor(deviceHeadphoneSink(plan.headphoneSinkId), plan.headphoneOffsetMs) : new MasterOnlyMonitor();
      return { context, monitor, plan };
    }
  }
}

const CLICK_EVERY_SEC = 0.5;
const CLICK_SEC = 0.012;

export interface AlignmentClicks {
  /** The Learner's correction, ms: positive when the headphones sound late. */
  setOffset(ms: number): void;
  stop(): Promise<void>;
}

/**
 * The headphone line-up test for two devices: the same click every half second on the speakers and in
 * the headphones, through the monitor the Lessons use, until the Learner hears one click.
 */
export async function startAlignmentClicks(plan: Extract<OutputPlan, { kind: "two-devices" }>): Promise<AlignmentClicks> {
  const context = new AudioContext({ ...INTERACTIVE, sinkId: plan.sinkId } as AudioContextOptions);
  const monitor = new TwoDeviceMonitor(deviceHeadphoneSink(plan.headphoneSinkId), plan.headphoneOffsetMs);
  const master = new GainNode(context);
  const cue = new GainNode(context);
  monitor.attach({ context, master, cue });
  monitor.setCueMix(0);
  const tone = new OscillatorNode(context, { frequency: 1500 });
  const level = new GainNode(context, { gain: 0 });
  tone.connect(level);
  level.connect(master);
  level.connect(cue);
  await context.resume();
  const start = context.currentTime + 0.1;
  // A minute of clicks is plenty to line up by ear; stop() ends it sooner.
  for (let click = 0; click < 120; click++) {
    const at = start + click * CLICK_EVERY_SEC;
    level.gain.setValueAtTime(0.25, at);
    level.gain.setValueAtTime(0, at + CLICK_SEC);
  }
  tone.start(start);
  let stopped = false;
  return {
    setOffset(ms) {
      monitor.setHeadphoneOffset(ms);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      tone.stop();
      monitor.detach();
      await context.close();
    },
  };
}
