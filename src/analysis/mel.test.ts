import { describe, expect, it } from "vitest";
import { Fft } from "./fft.ts";
import { frameCount, logMel, MEL_BANDS } from "./mel.ts";
import { downmixMean, resample } from "./resample.ts";
import referenceDataUrl from "./fixtures/logmel-reference.f32?url&inline";

/** Decodes the data: URL Vite inlines the fixture as (works in Node and in the browser). */
async function loadReference(): Promise<Float32Array> {
  const bytes = await (await fetch(referenceDataUrl)).arrayBuffer();
  return new Float32Array(bytes);
}

/** The same signal as scripts/model-export/reference.py test_signal(). */
function referenceSignal(length = 44_100, sampleRate = 22_050) {
  return Float32Array.from({ length }, (_, i) => {
    const tone = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    const thump = i % 11025 < 2000 ? 0.3 * Math.sin((2 * Math.PI * 97 * i) / sampleRate) : 0;
    return tone + thump;
  });
}

describe("fft", () => {
  it("matches a direct DFT", () => {
    const size = 16;
    const real = Float64Array.from({ length: size }, (_, i) => Math.sin(i) + 0.3 * i);
    const imaginary = new Float64Array(size);
    const expected = Array.from({ length: size }, (_, k) =>
      Array.from(real).reduce<[number, number]>(
        ([re, im], x, t) => [
          re + x * Math.cos((2 * Math.PI * k * t) / size),
          im - x * Math.sin((2 * Math.PI * k * t) / size),
        ],
        [0, 0],
      ),
    );
    new Fft(size).forward(real, imaginary);
    expected.forEach(([re, im], k) => {
      expect(real[k]).toBeCloseTo(re, 9);
      expect(imaginary[k]).toBeCloseTo(im, 9);
    });
  });

  it("refuses sizes that are not powers of two", () => {
    expect(() => new Fft(1000)).toThrow(RangeError);
  });
});

describe("log-mel front end", () => {
  it("matches beat_this.preprocessing.LogMelSpect (torchaudio) on the reference signal", async () => {
    const reference = await loadReference();
    const signal = referenceSignal();
    const ours = logMel(signal);
    expect(frameCount(signal.length)).toBe(reference.length / MEL_BANDS);
    expect(ours.length).toBe(reference.length);
    const maxError = ours.reduce((max, value, i) => Math.max(max, Math.abs(value - (reference[i] ?? Infinity))), 0);
    expect(maxError).toBeLessThan(1e-3);
  });
});

describe("resampling", () => {
  it("keeps a click at the same time when halving the rate", () => {
    const input = new Float32Array(44_100);
    input[20_000] = 1;
    const out = resample(input, 44_100, 22_050);
    expect(out.length).toBe(22_050);
    const peak = out.reduce((best, value, i) => (value > (out[best] ?? 0) ? i : best), 0);
    expect(peak).toBe(10_000);
  });

  it("passes a 1 kHz tone at unity gain from 48 kHz", () => {
    const input = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48_000));
    const middle = resample(input, 48_000, 22_050).subarray(5000, 15_000);
    const rms = Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length);
    expect(rms).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it("downmixes as the arithmetic mean", () => {
    expect(Array.from(downmixMean([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
  });
});
