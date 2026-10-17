import { describe, expect, it } from "vitest";
import { LoudnessMeter, type LoudnessFrame } from "./loudness.ts";

const SAMPLE_RATE = 48_000;
const BLOCK = 128;

function sine(frequency: number, peak: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) =>
    peak * Math.sin((2 * Math.PI * frequency * index) / sampleRate),
  );
}

function meter(channels: readonly Float32Array[], sampleRate = SAMPLE_RATE): LoudnessFrame[] {
  const frames: LoudnessFrame[] = [];
  const loudness = new LoudnessMeter(sampleRate);
  const length = channels[0]?.length ?? 0;
  for (let start = 0; start < length; start += BLOCK) {
    loudness.process(
      channels.map((channel) => channel.subarray(start, start + BLOCK)),
      BLOCK,
      start,
      (frame) => frames.push(frame),
    );
  }
  return frames;
}

const fromDbfs = (decibels: number) => 10 ** (decibels / 20);

describe("LoudnessMeter", () => {
  it("emits a frame every 20 ms, timed at the frame's last sample", () => {
    const frames = meter([sine(1000, 0.5, 1)]);
    expect(frames).toHaveLength(50);
    expect(frames[0]?.endFrame).toBe(960);
    expect(frames[49]?.endFrame).toBe(48_000);
  });

  it("reads a full-scale 1 kHz sine in one channel as -3.01 LUFS (ITU-R BS.1770)", () => {
    const frames = meter([sine(1000, 1, 3.2), new Float32Array(3.2 * SAMPLE_RATE)]);
    const last = frames.at(-1);
    expect(last?.momentaryLufs).toBeCloseTo(-3.01, 1);
    expect(last?.shortTermLufs).toBeCloseTo(-3.01, 1);
    expect(last?.samplePeakDb).toBeCloseTo(0, 2);
  });

  it("reads a -3.01 dBFS stereo 1 kHz sine as -3.01 LUFS", () => {
    const channel = sine(1000, fromDbfs(-3.01), 3.2);
    const last = meter([channel, channel]).at(-1);
    expect(last?.momentaryLufs).toBeCloseTo(-3.01, 1);
    expect(last?.shortTermLufs).toBeCloseTo(-3.01, 1);
    expect(last?.samplePeakDb).toBeCloseTo(-3.01, 2);
  });

  it("passes EBU Tech 3341 case 1 at 44.1 kHz: -23 dBFS stereo sine reads -23.0 LUFS", () => {
    const channel = sine(1000, fromDbfs(-23), 3.2, 44_100);
    const last = meter([channel, channel], 44_100).at(-1);
    expect(last?.momentaryLufs).toBeCloseTo(-23, 1);
    expect(last?.shortTermLufs).toBeCloseTo(-23, 1);
  });

  it("weights low frequencies down: 50 Hz reads quieter than 1 kHz at the same level", () => {
    const at1k = meter([sine(1000, 0.5, 1)]).at(-1)?.momentaryLufs ?? 0;
    const at50 = meter([sine(50, 0.5, 1)]).at(-1)?.momentaryLufs ?? 0;
    expect(at1k - at50).toBeGreaterThan(1);
  });

  it("windows momentary over 400 ms and short-term over 3 s", () => {
    const sound = sine(1000, 1, 1);
    const silence = new Float32Array(SAMPLE_RATE);
    const frames = meter([Float32Array.from([...sound, ...silence])]);
    // 200 ms into the silence the 400 ms window is half full: 3 dB down.
    const halfway = frames.find((frame) => frame.endFrame === SAMPLE_RATE + 0.2 * SAMPLE_RATE);
    expect(halfway?.momentaryLufs).toBeCloseTo(-3.01 - 3.01, 0);
    // 500 ms into the silence momentary is silent, but short-term still holds 1 s of the 3 s window.
    const later = frames.find((frame) => frame.endFrame === SAMPLE_RATE + 0.5 * SAMPLE_RATE);
    // Only the K-weighting filters' decaying tail is left.
    expect(later?.momentaryLufs).toBeLessThan(-70);
    expect(later?.shortTermLufs).toBeCloseTo(-3.01 + 10 * Math.log10(1 / 3), 0);
    expect(later?.samplePeakDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("treats a block with no channels as silence", () => {
    const loudness = new LoudnessMeter(SAMPLE_RATE);
    const frames: LoudnessFrame[] = [];
    for (let start = 0; start < 960; start += BLOCK) {
      loudness.process([], BLOCK, start, (frame) => frames.push(frame));
    }
    expect(frames).toEqual([
      {
        endFrame: 960,
        samplePeakDb: Number.NEGATIVE_INFINITY,
        momentaryLufs: Number.NEGATIVE_INFINITY,
        shortTermLufs: Number.NEGATIVE_INFINITY,
      },
    ]);
  });
});
