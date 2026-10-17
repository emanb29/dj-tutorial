// AudioWorklet processor: wraps LoudnessMeter and posts one frame per 20 ms to the main thread.
// Loaded with Vite's `?worker&url` so its import of loudness.ts is bundled into the worklet module.

import { LoudnessMeter, METER_PROCESSOR_NAME, type LoudnessFrame } from "./loudness.ts";

// AudioWorkletGlobalScope members (not in lib.dom).
declare const sampleRate: number;
declare const currentFrame: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor & {
    process(inputs: Float32Array[][]): boolean;
  },
): void;

/** Render quantum length; fixed at 128 frames in current Web Audio. */
const RENDER_QUANTUM = 128;

class LoudnessMeterProcessor extends AudioWorkletProcessor {
  private readonly meter = new LoudnessMeter(sampleRate);

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0] ?? [];
    const blockLength = channels[0]?.length ?? RENDER_QUANTUM;
    this.meter.process(channels, blockLength, currentFrame, (frame: LoudnessFrame) => {
      this.port.postMessage(frame);
    });
    return true;
  }
}

registerProcessor(METER_PROCESSOR_NAME, LoudnessMeterProcessor);
