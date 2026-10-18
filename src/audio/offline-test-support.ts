// Helpers for browser tests that render the engine through an OfflineAudioContext (never the speakers).

import type { EngineCommand } from "./commands.ts";
import { createAudioEngine, type AudioEngine, type AudioEngineOptions } from "./engine.ts";
import type { PlayheadSegment } from "./playhead.ts";

export const SAMPLE_RATE = 48_000;
export const KEYBOARD = { device: "keyboard" } as const;

export function offlineContext(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
}

function stereoBuffer(context: BaseAudioContext, left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer> = left): AudioBuffer {
  const buffer = context.createBuffer(2, left.length, context.sampleRate);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  return buffer;
}

/** A stereo sine buffer, the same in both channels unless `rightFrequency` is given. */
export function toneBuffer(
  context: BaseAudioContext,
  options: { frequency: number; peak: number; seconds: number; rightFrequency?: number },
): AudioBuffer {
  const length = Math.round(options.seconds * context.sampleRate);
  const fill = (frequency: number) =>
    Float32Array.from({ length }, (_, index) => options.peak * Math.sin((2 * Math.PI * frequency * index) / context.sampleRate));
  return stereoBuffer(context, fill(options.frequency), fill(options.rightFrequency ?? options.frequency));
}

/** Silence with a 1 ms, 1 kHz click starting at each of `clickTimes` (track seconds). */
export function clickBuffer(context: BaseAudioContext, seconds: number, clickTimes: readonly number[]): AudioBuffer {
  const data = new Float32Array(Math.round(seconds * context.sampleRate));
  const clickLength = Math.round(context.sampleRate / 1000);
  for (const time of clickTimes) {
    const start = Math.round(time * context.sampleRate);
    for (let index = 0; index < clickLength; index++) {
      data[start + index] = 0.8 * Math.sin((2 * Math.PI * index) / clickLength);
    }
  }
  return stereoBuffer(context, data, data.slice());
}

export function rmsDb(samples: Float32Array): number {
  const meanSquare = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
  return 10 * Math.log10(meanSquare);
}

/** RMS of a channel between two times, in dB relative to full-scale square wave. */
export function channelRmsDb(rendered: AudioBuffer, channel: number, fromSec: number, toSec: number): number {
  const data = rendered.getChannelData(channel);
  return rmsDb(data.subarray(Math.round(fromSec * rendered.sampleRate), Math.round(toSec * rendered.sampleRate)));
}

/** RMS in dB of a sine with this peak: 20·log10(peak/√2). */
export function sineRmsDb(peak: number): number {
  return 20 * Math.log10(peak / Math.SQRT2);
}

/** Upward zero crossings per second between two times: the frequency of a pure tone. */
export function toneFrequency(rendered: AudioBuffer, channel: number, fromSec: number, toSec: number): number {
  const data = rendered.getChannelData(channel);
  const from = Math.round(fromSec * rendered.sampleRate);
  const to = Math.round(toSec * rendered.sampleRate);
  let crossings = 0;
  for (let index = from + 1; index < to; index++) {
    if ((data[index - 1] ?? 0) < 0 && (data[index] ?? 0) >= 0) crossings++;
  }
  return crossings / (toSec - fromSec);
}

/** Time of the first sample louder than `threshold`, in seconds. */
export function onsetSec(rendered: AudioBuffer, threshold = 1e-3): number {
  return rendered.getChannelData(0).findIndex((sample) => Math.abs(sample) > threshold) / rendered.sampleRate;
}

/** Time of the loudest sample within ±`windowSec` of `aroundSec`. */
export function peakSec(rendered: AudioBuffer, aroundSec: number, windowSec: number): number {
  const data = rendered.getChannelData(0);
  const from = Math.max(0, Math.round((aroundSec - windowSec) * rendered.sampleRate));
  const to = Math.min(data.length, Math.round((aroundSec + windowSec) * rendered.sampleRate));
  let loudest = from;
  for (let index = from; index < to; index++) {
    if (Math.abs(data[index] ?? 0) > Math.abs(data[loudest] ?? 0)) loudest = index;
  }
  return loudest / rendered.sampleRate;
}

/** The context time at which a playhead model reaches track position `pos` while playing. */
export function outputTimeOf(segments: readonly PlayheadSegment[], pos: number): number | null {
  for (const [index, segment] of segments.entries()) {
    if (segment.rate <= 0) continue;
    const time = segment.fromCtx + (pos - segment.pos) / segment.rate;
    const end = segments[index + 1]?.fromCtx ?? Number.POSITIVE_INFINITY;
    if (time >= segment.fromCtx && time < end) return time;
  }
  return null;
}

/**
 * Runs `run` when the offline render reaches `time` and returns the render time it ran at. An offline
 * render outruns real time, so a test that sends worklet messages awaits them in `run` (engine.settled())
 * before the render resumes; a real-time context has the whole lookahead for them to arrive.
 */
export function at(context: OfflineAudioContext, time: number, run: () => void | Promise<void>): Promise<number> {
  return context.suspend(time).then(async () => {
    const appliedAt = context.currentTime;
    await run();
    await context.resume();
    return appliedAt;
  });
}

export function send(engine: AudioEngine, ...commands: EngineCommand[]): void {
  for (const command of commands) expectOk(engine.command(command, KEYBOARD));
}

/**
 * An engine on a fresh offline context, with deck A loaded with a tone and playing from time 0, the
 * crossfader on A's side (A at unity on the master; the mixer starts at the centre, −3 dB).
 */
export async function engineWithTone(
  seconds: number,
  tone: { frequency: number; peak: number; rightFrequency?: number },
  options: Partial<AudioEngineOptions> = {},
): Promise<{ context: OfflineAudioContext; engine: AudioEngine }> {
  const context = offlineContext(seconds);
  const engine = await createAudioEngine({ context, ...options });
  const loaded = await engine.load("A", toneBuffer(context, { ...tone, seconds: seconds + 1 }), { trackId: "tone", grid: null });
  if (!loaded.ok) throw new Error(`Loading the test tone failed: ${loaded.error.kind}`);
  send(engine, { control: "crossfader", value: 0 }, { control: "play", deck: "A" });
  return { context, engine };
}

export function expectOk(result: { ok: boolean }): void {
  if (!result.ok) throw new Error(`Expected the command to succeed, got ${JSON.stringify(result)}`);
}
