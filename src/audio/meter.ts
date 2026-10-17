// Main-thread side of the loudness meters: one AudioWorkletNode per metered bus.

import { METER_PROCESSOR_NAME, type LoudnessFrame } from "./loudness.ts";
import meterProcessorUrl from "./meter-processor.ts?worker&url";
import type { MeterFrame } from "@shared/attempt.ts";
import type { DeckId } from "./types.ts";

/** Channel meters are post-trim/EQ/filter and pre-fader (check-design §1); master is post master level. */
export type MeterBus = DeckId | "master";

/** A meter frame (the attempt contract's MeterFrame) tagged with its bus. `ctx` is just after the frame's last sample. */
export interface BusMeterFrame extends MeterFrame {
  readonly bus: MeterBus;
}

export async function loadMeterProcessor(context: BaseAudioContext): Promise<void> {
  await context.audioWorklet.addModule(meterProcessorUrl);
}

export function createMeter(
  context: BaseAudioContext,
  bus: MeterBus,
  onFrame: (frame: BusMeterFrame) => void,
): AudioWorkletNode {
  // No outputs: the worklet is pulled by its input, so it needs no path to the destination.
  const node = new AudioWorkletNode(context, METER_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  node.port.onmessage = (event: MessageEvent<LoudnessFrame>) => {
    const { endFrame, samplePeakDb, momentaryLufs, shortTermLufs } = event.data;
    onFrame({ bus, ctx: endFrame / context.sampleRate, samplePeakDb, momentaryLufs, shortTermLufs });
  };
  return node;
}
