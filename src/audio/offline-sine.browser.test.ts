import { describe, expect, it } from "vitest";

// Proves the browser test project can render Web Audio offline. OfflineAudioContext
// never reaches the speakers, and the browser is launched with --mute-audio anyway.

const SAMPLE_RATE = 48_000;

function rootMeanSquare(samples: Float32Array): number {
  const sumOfSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(sumOfSquares / samples.length);
}

async function renderSine(frequency: number, amplitude: number, seconds: number) {
  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: SAMPLE_RATE * seconds,
    sampleRate: SAMPLE_RATE,
  });
  const oscillator = new OscillatorNode(context, { type: "sine", frequency });
  const gain = new GainNode(context, { gain: amplitude });
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

describe("OfflineAudioContext", () => {
  it("renders a 440 Hz sine at amplitude 0.5 with an RMS of 0.5 / sqrt(2)", async () => {
    const samples = await renderSine(440, 0.5, 1);

    expect(samples).toHaveLength(SAMPLE_RATE);
    // A sine's RMS is its peak divided by sqrt(2): 0.35355...
    expect(rootMeanSquare(samples)).toBeCloseTo(0.353_553, 3);
  });

  it("renders silence when the gain is zero", async () => {
    const samples = await renderSine(440, 0, 1);

    expect(rootMeanSquare(samples)).toBe(0);
  });
});
