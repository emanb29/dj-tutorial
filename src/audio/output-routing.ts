// Builds the AudioContext and monitor output for an output plan (output.ts), in the browser. A
// controller plan whose device shows fewer than four channels falls back to split cue on this computer
// rather than ever putting the cue on the speakers; so do a computer-and-FLX4-phones plan and a PC
// MASTER OUT plan, rather than putting the cue on the FLX4's MASTER OUT.

import { controllerMasterAndPhonesSink, controllerPhonesSink, ControllerCueMonitor, deviceHeadphoneSink, TwoDeviceMonitor, type SecondDeviceSink } from "./device-monitors.ts";
import { MasterOnlyMonitor, SplitCueMonitor, type MonitorOutput } from "./monitor.ts";
import { controllerPhonesFallback, type ControllerSecondPlan, type LinedUpPlan, type OutputPlan } from "./output.ts";

export interface OutputRouting {
  readonly context: AudioContext;
  readonly monitor: MonitorOutput;
  /** The plan as built: a fallback says so. */
  readonly plan: OutputPlan;
}

/** Opens an AudioContext on a device (null: the default output). Tests pass fakes. */
export type OpenContext = (sinkId: string | null) => AudioContext;

export const openDeviceContext: OpenContext = (sinkId) => new AudioContext(sinkId === null ? { latencyHint: "interactive" } : ({ latencyHint: "interactive", sinkId } as AudioContextOptions));

function onThisComputer(open: OpenContext, headphones: boolean, fallback: string | null): OutputRouting {
  return {
    context: open(null),
    monitor: headphones ? new SplitCueMonitor() : new MasterOnlyMonitor(),
    plan: { kind: "split-cue", sinkId: null, fallback },
  };
}

/**
 * The FLX4's path for a computer-and-FLX4-phones plan (its headphones) or a PC MASTER OUT plan (its
 * MASTER OUT and headphones), or why it cannot be: a card showing fewer than four outputs would put the
 * cue on its MASTER OUT. The context opened for the check is the one the sink uses first; a later open
 * (after a detach) makes a new one.
 */
function controllerSink(plan: ControllerSecondPlan, open: OpenContext): { ok: true; sink: SecondDeviceSink } | { ok: false; fallback: string } {
  let checked: AudioContext | null = open(plan.controllerSinkId);
  const fallback = controllerPhonesFallback(plan.controllerLabel, checked.destination.maxChannelCount);
  if (fallback !== null) {
    void checked.close();
    return { ok: false, fallback };
  }
  const openOutput = () => {
    const output = checked ?? open(plan.controllerSinkId);
    checked = null;
    return output;
  };
  return { ok: true, sink: plan.kind === "dual-master" ? controllerMasterAndPhonesSink(openOutput) : controllerPhonesSink(openOutput) };
}

function headphoneSinkFor(plan: LinedUpPlan, open: OpenContext): { ok: true; sink: SecondDeviceSink } | { ok: false; fallback: string } {
  return plan.kind === "two-devices" ? { ok: true, sink: deviceHeadphoneSink(plan.headphoneSinkId) } : controllerSink(plan, open);
}

export function createOutputRouting(plan: OutputPlan, options: { readonly headphones: boolean; readonly openContext?: OpenContext }): OutputRouting {
  const open = options.openContext ?? openDeviceContext;
  switch (plan.kind) {
    case "split-cue":
      return onThisComputer(open, options.headphones, plan.fallback);
    case "controller": {
      const context = open(plan.sinkId);
      if (!ControllerCueMonitor.fits(context)) {
        const channels = context.destination.maxChannelCount;
        void context.close();
        return onThisComputer(open, options.headphones, `${plan.label} shows ${String(channels)} outputs, not 4`);
      }
      return { context, monitor: new ControllerCueMonitor(), plan };
    }
    case "two-devices":
    case "computer-and-controller-phones":
    case "dual-master": {
      // Lessons without headphone cueing play the master only, with no delay to line up and no second
      // device; except PC MASTER OUT, whose second device plays the master too (as "controller" does).
      if (!options.headphones && plan.kind !== "dual-master") return { context: open(plan.sinkId), monitor: new MasterOnlyMonitor(), plan };
      const headphones = headphoneSinkFor(plan, open);
      if (!headphones.ok) return onThisComputer(open, options.headphones, headphones.fallback);
      return { context: open(plan.sinkId), monitor: new TwoDeviceMonitor(headphones.sink, plan.headphoneOffsetMs), plan };
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
 * The headphone line-up test for two devices (or speakers and the FLX4's headphones, or PC MASTER OUT):
 * the same click every half second on the speakers and in the headphones (and on the FLX4's MASTER OUT
 * in PC MASTER OUT), through the monitor the Lessons use, until the Learner hears one click. Rejects
 * with the fallback's reason when the FLX4 cannot take the cue.
 */
export async function startAlignmentClicks(plan: LinedUpPlan): Promise<AlignmentClicks> {
  const headphones = headphoneSinkFor(plan, openDeviceContext);
  if (!headphones.ok) throw new Error(headphones.fallback);
  const context = openDeviceContext(plan.sinkId);
  const monitor = new TwoDeviceMonitor(headphones.sink, plan.headphoneOffsetMs);
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
