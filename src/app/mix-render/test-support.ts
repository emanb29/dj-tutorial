// Tracks and sinks for the Render's browser tests: synthetic audio written as WAV files, so the
// Render decodes them the way it decodes a Learner's own files. Nothing here is played.
import { wavHeader } from "@shared/mix-render.ts";
import type { RenderSink, RenderTrackSource } from "./render.ts";

export const TEST_RATE = 44_100;

/** A stereo WAV file of `left` (and `right`, else the same), 16-bit. */
export function wavFile(left: Float32Array, right: Float32Array = left, sampleRate = TEST_RATE): Blob {
  const pcm = new Uint8Array(left.length * 4);
  const view = new DataView(pcm.buffer);
  const int16 = (sample: number) => Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff);
  for (let index = 0; index < left.length; index++) {
    view.setInt16(index * 4, int16(left[index] ?? 0), true);
    view.setInt16(index * 4 + 2, int16(right[index] ?? 0), true);
  }
  return new Blob([wavHeader(left.length, sampleRate), pcm], { type: "audio/wav" });
}

/** `seconds` of the sum of `partials` (Hz, peak each), from `fromSec` on; silence before. */
export function partialsTrack(seconds: number, partials: readonly (readonly [number, number])[], fromSec = 0, sampleRate = TEST_RATE): Float32Array {
  const start = Math.round(fromSec * sampleRate);
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) =>
    index < start ? 0 : partials.reduce((sum, [hz, peak]) => sum + peak * Math.sin((2 * Math.PI * hz * index) / sampleRate), 0),
  );
}

export const source = (name: string, blob: Blob): RenderTrackSource => ({ name, read: () => Promise.resolve(blob) });

/** Keeps every segment in memory, as the API would on disk. */
export class MemorySink implements RenderSink {
  frames = 0;
  sampleRate = 0;
  readonly segments: Uint8Array[] = [];

  begin(info: { readonly frames: number; readonly sampleRate: number }): Promise<void> {
    this.frames = info.frames;
    this.sampleRate = info.sampleRate;
    return Promise.resolve();
  }

  segment(index: number, pcm: Uint8Array<ArrayBuffer>): Promise<void> {
    if (index !== this.segments.length) throw new Error(`Segment ${String(index)} came out of order.`);
    this.segments.push(pcm);
    return Promise.resolve();
  }

  /** One channel of the whole Render, as floats. */
  channel(channel: 0 | 1): Float32Array {
    const total = this.segments.reduce((sum, segment) => sum + segment.length / 4, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const segment of this.segments) {
      const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
      for (let index = 0; index < segment.length / 4; index++) out[at + index] = view.getInt16(index * 4 + channel * 2, true) / 0x8000;
      at += segment.length / 4;
    }
    return out;
  }
}

/** Upward zero crossings per second of `data` between two times: a pure tone's frequency. */
export function zeroCrossingHz(data: Float32Array, fromSec: number, toSec: number, sampleRate = TEST_RATE): number {
  let crossings = 0;
  for (let index = Math.round(fromSec * sampleRate) + 1; index < Math.round(toSec * sampleRate); index++) {
    if ((data[index - 1] ?? 0) < 0 && (data[index] ?? 0) >= 0) crossings++;
  }
  return crossings / (toSec - fromSec);
}

/** RMS of `data` between two times. */
export function rms(data: Float32Array, fromSec: number, toSec: number, sampleRate = TEST_RATE): number {
  const part = data.subarray(Math.round(fromSec * sampleRate), Math.round(toSec * sampleRate));
  return Math.sqrt(part.reduce((sum, sample) => sum + sample * sample, 0) / part.length);
}
